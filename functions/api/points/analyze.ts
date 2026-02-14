import { callGeminiJson, POINTS_PROMPT, POINTS_RESPONSE_SCHEMA } from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_TOTAL_IMAGE_CHARS = 20 * 1024 * 1024;
const MODEL = "gemini-2.5-flash";

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

const error = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status);

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
    return error(500, "INTERNAL", "Server is missing GEMINI_API_KEY.");
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return error(413, "BAD_REQUEST", "Request body is too large.");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return error(400, "BAD_REQUEST", "Request body must be valid JSON.");
  }

  const pageImages = Array.isArray(body?.pageImages) ? body.pageImages : [];
  if (pageImages.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'pageImages' is required.");
  }

  if (pageImages.length > MAX_PAGES) {
    return error(400, "BAD_REQUEST", `A maximum of ${MAX_PAGES} pages is supported.`);
  }

  if (!pageImages.every((value) => typeof value === "string" && value.length > 0)) {
    return error(400, "BAD_REQUEST", "All items in 'pageImages' must be non-empty strings.");
  }

  const totalImageChars = pageImages.reduce((sum, item) => sum + item.length, 0);
  if (totalImageChars > MAX_TOTAL_IMAGE_CHARS) {
    return error(413, "BAD_REQUEST", "Total image payload is too large.");
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
      model: MODEL,
      contents: [
        {
          parts: [{ text: POINTS_PROMPT }, ...imageParts],
        },
      ],
      responseSchema: POINTS_RESPONSE_SCHEMA,
    });

    const validationError = validatePointsResult(result, pageImages.length);
    if (validationError) {
      return error(502, "UPSTREAM_ERROR", `Presentation analysis failed validation: ${validationError}`);
    }

    return json(result);
  } catch (err: any) {
    const message = String(err?.message || "Unknown error");

    if (message.includes("429")) {
      return error(429, "RATE_LIMIT", "Gemini rate limit reached. Please retry shortly.");
    }

    if (message.includes("503") || message.toLowerCase().includes("overload")) {
      return error(502, "UPSTREAM_ERROR", "Gemini is temporarily overloaded. Please retry.");
    }

    return error(502, "UPSTREAM_ERROR", `Presentation analysis failed: ${message}`);
  }
}
