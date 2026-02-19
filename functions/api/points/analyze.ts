import {
  callGeminiJson,
  callOpenRouterJson,
  POINTS_PROMPT,
  POINTS_RESPONSE_SCHEMA,
  normalizeGeminiProviderPreference,
} from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_TOTAL_IMAGE_CHARS = 20 * 1024 * 1024;
const DEFAULT_MODEL = "gemini-2.5-flash";
const OPENROUTER_DEFAULT_MODEL = "openrouter/free";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-3-pro-preview"]);
const IS_STRICT_VALIDATION: boolean = false;
const UPSTREAM_DEPENDENCY_STATUS = 424;
const VALIDATION_STATUS = 422;

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

const isLocationUnsupportedError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user location is not supported for the api use") ||
    normalized.includes("location is not supported for the api use")
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
  const primaryApiKey = env?.GEMINI_API_KEY;
  const requestId = request.headers.get("cf-ray") || crypto.randomUUID();

  if (!primaryApiKey) {
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
  const enableOpenRouterFallback = body?.enableOpenRouterFallback === true;
  const providerPreference = normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER);
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

  console.log(
    JSON.stringify({
      event: "points_request_start",
      requestId,
      requestedModel: model,
      providerPreference,
      pageCount: pageImages.length,
      totalImageChars,
    }),
  );

  try {
    const result = await callGeminiJson({
      apiKey: primaryApiKey,
      vertexApiKey: env.VERTEX_API_KEY,
      providerPreference,
      requestId,
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
      console.log(
        JSON.stringify({
          event: "points_request_validation_failed",
          requestId,
          model,
          validationError,
        }),
      );
      return error(
        VALIDATION_STATUS,
        "UPSTREAM_ERROR",
        "Presentation analysis failed validation.",
        "VALIDATION_FAILED",
        { requestId, validationError },
      );
    }

    console.log(
      JSON.stringify({
        event: "points_request_success",
        requestId,
        model,
        slides: Array.isArray(result?.slides) ? result.slides.length : null,
      }),
    );

    return json(result);
  } catch (err: any) {
    const message = String(err?.message || "Unknown error");

    console.log(
      JSON.stringify({
        event: "points_request_failure",
        requestId,
        model,
        message,
      }),
    );

    let openRouterFallbackError: string | undefined;
    const isOverload = message.includes("503") || message.toLowerCase().includes("overload");
    const isImageProcessing = message.toLowerCase().includes("unable to process input image");
    const isTimeout = message.toLowerCase().includes("timed out") || message.toLowerCase().includes("timeout");
    const isLocationBlocked = isLocationUnsupportedError(message);
    const isTransient = message.includes("500") || message.includes("502") || message.includes("504");
    const isRateLimited = isUpstreamRateLimit(message);

    const canAttemptOpenRouterFallback =
      enableOpenRouterFallback &&
      Boolean(env.OPENROUTER_API_KEY) &&
      (isRateLimited || isOverload || isImageProcessing || isTimeout || isLocationBlocked || isTransient);

    if (canAttemptOpenRouterFallback) {
      const openRouterModel =
        typeof env.OPENROUTER_MODEL === "string" && env.OPENROUTER_MODEL.trim()
          ? env.OPENROUTER_MODEL.trim()
          : OPENROUTER_DEFAULT_MODEL;

      try {
        console.log(
          JSON.stringify({
            event: "points_openrouter_fallback_start",
            requestId,
            model,
            openRouterModel,
          }),
        );

        const fallbackResult = await callOpenRouterJson({
          apiKey: env.OPENROUTER_API_KEY as string,
          model: openRouterModel,
          requestId,
          referer: env.OPENROUTER_SITE_URL,
          appTitle: env.OPENROUTER_APP_TITLE || "The Chatter Analyst",
          messageContent: [
            {
              type: "text",
              text:
                `${POINTS_PROMPT}\n\n` +
                "FINAL OUTPUT REQUIREMENT: Return only one valid JSON object. No markdown, no explanation.",
            },
            ...pageImages.map((dataUri) => ({
              type: "image_url" as const,
              image_url: { url: dataUri },
            })),
          ],
        });

        const fallbackValidationError = validatePointsResult(fallbackResult, pageImages.length);
        if (fallbackValidationError) {
          openRouterFallbackError = `OpenRouter validation failed: ${fallbackValidationError}`;
          console.log(
            JSON.stringify({
              event: "points_openrouter_fallback_validation_failed",
              requestId,
              model,
              openRouterModel,
              fallbackValidationError,
            }),
          );
        } else {
          console.log(
            JSON.stringify({
              event: "points_openrouter_fallback_success",
              requestId,
              model,
              openRouterModel,
            }),
          );
          return json(fallbackResult);
        }
      } catch (openRouterError: any) {
        openRouterFallbackError = String(openRouterError?.message || "OpenRouter fallback failed.");
        console.log(
          JSON.stringify({
            event: "points_openrouter_fallback_failed",
            requestId,
            model,
            openRouterModel,
            openRouterFallbackError,
          }),
        );
      }
    }

    const details = {
      requestId,
      model,
      openRouterFallbackEnabled: enableOpenRouterFallback,
      ...(openRouterFallbackError ? { openRouterFallbackError } : {}),
    };

    if (isRateLimited) {
      const retryAfterSeconds = extractRetryAfterSeconds(message);
      return error(
        429,
        "RATE_LIMIT",
        retryAfterSeconds
          ? `Gemini quota/rate limit reached. Retry in about ${retryAfterSeconds}s.`
          : "Gemini quota/rate limit reached. Please retry shortly.",
        "UPSTREAM_RATE_LIMIT",
        details,
      );
    }

    if (isOverload) {
      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        "Gemini is temporarily overloaded. Please retry.",
        "UPSTREAM_OVERLOAD",
        details,
      );
    }

    if (isImageProcessing) {
      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        "Gemini could not process one or more slide images for this chunk. Retrying may work.",
        "UPSTREAM_IMAGE_PROCESSING",
        details,
      );
    }

    if (isTimeout) {
      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        "Upstream request timed out. Please retry.",
        "UPSTREAM_TIMEOUT",
        details,
      );
    }

    if (isLocationBlocked) {
      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        "Gemini request was temporarily blocked by provider location policy. Please retry.",
        "UPSTREAM_LOCATION_UNSUPPORTED",
        details,
      );
    }

    if (isTransient) {
      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        "Gemini request failed upstream. Please retry.",
        "UPSTREAM_TRANSIENT",
        details,
      );
    }

    return error(
      UPSTREAM_DEPENDENCY_STATUS,
      "UPSTREAM_ERROR",
      `Presentation analysis failed: ${message}`,
      "UPSTREAM_FAILURE",
      details,
    );
  }
}
