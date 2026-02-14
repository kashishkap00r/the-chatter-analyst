import { callGeminiJson, POINTS_PROMPT, POINTS_RESPONSE_SCHEMA } from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_TOTAL_IMAGE_CHARS = 20 * 1024 * 1024;
const DEFAULT_MODEL = "gemini-2.5-flash";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-3-pro-preview"]);
const IS_STRICT_VALIDATION: boolean = false;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

const error = (status: number, code: string, message: string, reasonCode?: string, details?: unknown): Response =>
  json(
    {
      error: {
        code,
        message,
        reasonCode,
        details,
      },
    },
    status,
  );

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const extractRetryAfterSeconds = (message: string): number | null => {
  const match = message.match(/retry in\s+([\d.]+)s/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.ceil(parsed));
};

const isUpstreamRateLimit = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("429") ||
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("generate_content_free_tier_requests")
  );
};

const disallowedContextStart = /^(in this slide|this slide shows|the slide shows)\b/i;

const sanitizeContext = (value: string): string => {
  let normalized = value.trim();
  normalized = normalized.replace(/^(in this slide|this slide shows|the slide shows)\s*[:,-]?\s*/i, "");
  if (normalized && normalized[0] === normalized[0].toLowerCase()) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized;
};

const validatePointsResult = (result: any, maxPageCount: number): string | null => {
  if (!result || typeof result !== "object") {
    return "Gemini response is not a JSON object.";
  }

  const requiredRootFields = [
    "companyName",
    "fiscalPeriod",
    "nseScrip",
    "marketCapCategory",
    "industry",
    "companyDescription",
  ];
  for (const field of requiredRootFields) {
    if (!hasNonEmptyString(result[field])) {
      return `Missing or invalid field '${field}'.`;
    }
  }

  if (!Array.isArray(result.slides) || result.slides.length === 0) {
    return "Field 'slides' must contain at least 1 item.";
  }

  for (let i = 0; i < result.slides.length; i++) {
    const slide = result.slides[i];
    const slideIndex = i + 1;
    if (!slide || typeof slide !== "object") {
      return `Slide #${slideIndex} is invalid.`;
    }

    if (!Number.isInteger(slide.selectedPageNumber)) {
      return `Slide #${slideIndex} has an invalid 'selectedPageNumber'.`;
    }

    if (slide.selectedPageNumber < 1 || slide.selectedPageNumber > maxPageCount) {
      return `Slide #${slideIndex} page number ${slide.selectedPageNumber} is out of range.`;
    }

    if (!hasNonEmptyString(slide.context)) {
      return `Slide #${slideIndex} is missing 'context'.`;
    }

    const normalizedContext = sanitizeContext(slide.context);
    if (!normalizedContext) {
      return `Slide #${slideIndex} has empty context after normalization.`;
    }

    if (IS_STRICT_VALIDATION) {
      if (disallowedContextStart.test(slide.context.trim())) {
        return `Slide #${slideIndex} context must not start with generic narration.`;
      }
      if (normalizedContext.length < 80) {
        return `Slide #${slideIndex} context is too short for an insight-led explanation.`;
      }
    }

    slide.context = normalizedContext;
  }

  return null;
};

const extractBase64 = (dataUri: string): string => {
  const commaIndex = dataUri.indexOf(",");
  if (commaIndex >= 0) {
    return dataUri.slice(commaIndex + 1);
  }
  return dataUri;
};

export async function onRequestPost(context: any): Promise<Response> {
  const request = context.request as Request;
  const env = context.env as Env;

  if (!env?.GEMINI_API_KEY) {
    return error(500, "INTERNAL", "Server is missing GEMINI_API_KEY.", "MISSING_GEMINI_KEY");
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return error(413, "BAD_REQUEST", "Request body is too large.", "BODY_TOO_LARGE");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return error(400, "BAD_REQUEST", "Request body must be valid JSON.", "INVALID_JSON");
  }

  const pageImages = Array.isArray(body?.pageImages) ? body.pageImages : [];
  if (pageImages.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'pageImages' is required.", "MISSING_PAGE_IMAGES");
  }

  const model = typeof body?.model === "string" ? body.model : DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) {
    return error(400, "BAD_REQUEST", "Field 'model' is invalid.", "INVALID_MODEL");
  }

  if (pageImages.length > MAX_PAGES) {
    return error(400, "BAD_REQUEST", `A maximum of ${MAX_PAGES} pages is supported.`, "TOO_MANY_PAGES");
  }

  if (!pageImages.every((value) => typeof value === "string" && value.length > 0)) {
    return error(400, "BAD_REQUEST", "All items in 'pageImages' must be non-empty strings.", "INVALID_PAGE_IMAGE");
  }

  const totalImageChars = pageImages.reduce((sum, item) => sum + item.length, 0);
  if (totalImageChars > MAX_TOTAL_IMAGE_CHARS) {
    return error(413, "BAD_REQUEST", "Total image payload is too large.", "PAYLOAD_TOO_LARGE");
  }

  const imageParts = pageImages.map((dataUri) => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: extractBase64(dataUri),
    },
  }));

  try {
    const result = await callGeminiJson({
      apiKey: env.GEMINI_API_KEY,
      model,
      contents: [
        {
          parts: [{ text: POINTS_PROMPT }, ...imageParts],
        },
      ],
      responseSchema: POINTS_RESPONSE_SCHEMA,
    });

    const validationError = validatePointsResult(result, pageImages.length);
    if (validationError) {
      return error(
        502,
        "UPSTREAM_ERROR",
        "Presentation analysis failed validation.",
        "VALIDATION_FAILED",
        validationError,
      );
    }

    return json(result);
  } catch (err: any) {
    const message = String(err?.message || "Unknown error");

    if (isUpstreamRateLimit(message)) {
      const retryAfterSeconds = extractRetryAfterSeconds(message);
      return error(
        429,
        "RATE_LIMIT",
        retryAfterSeconds
          ? `Gemini quota/rate limit reached. Retry in about ${retryAfterSeconds}s.`
          : "Gemini quota/rate limit reached. Please retry shortly.",
        "UPSTREAM_RATE_LIMIT",
      );
    }

    if (message.includes("503") || message.toLowerCase().includes("overload")) {
      return error(502, "UPSTREAM_ERROR", "Gemini is temporarily overloaded. Please retry.", "UPSTREAM_OVERLOAD");
    }

    if (message.toLowerCase().includes("unable to process input image")) {
      return error(
        502,
        "UPSTREAM_ERROR",
        "Gemini could not process one or more slide images for this chunk. Retrying may work.",
        "UPSTREAM_IMAGE_PROCESSING",
      );
    }

    if (message.toLowerCase().includes("timed out") || message.toLowerCase().includes("timeout")) {
      return error(502, "UPSTREAM_ERROR", "Upstream request timed out. Please retry.", "UPSTREAM_TIMEOUT");
    }

    if (message.includes("500") || message.includes("502") || message.includes("504")) {
      return error(502, "UPSTREAM_ERROR", "Gemini request failed upstream. Please retry.", "UPSTREAM_TRANSIENT");
    }

    return error(502, "UPSTREAM_ERROR", `Presentation analysis failed: ${message}`, "UPSTREAM_FAILURE");
  }
}
