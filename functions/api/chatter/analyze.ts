import { callGeminiJson, CHATTER_PROMPT, CHATTER_RESPONSE_SCHEMA } from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 800000;
const DEFAULT_MODEL = "gemini-2.5-flash";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-3-pro-preview"]);
const REQUIRED_QUOTES_COUNT = 20;

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

const validateChatterResult = (result: any): string | null => {
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

  if (!Array.isArray(result.quotes)) {
    return "Field 'quotes' must be an array.";
  }

  if (result.quotes.length !== REQUIRED_QUOTES_COUNT) {
    return `Field 'quotes' must contain exactly ${REQUIRED_QUOTES_COUNT} items, got ${result.quotes.length}.`;
  }

  for (let i = 0; i < result.quotes.length; i++) {
    const quoteItem = result.quotes[i];
    const quoteIndex = i + 1;

    if (!quoteItem || typeof quoteItem !== "object") {
      return `Quote #${quoteIndex} is invalid.`;
    }
    if (!hasNonEmptyString(quoteItem.quote)) {
      return `Quote #${quoteIndex} is missing 'quote'.`;
    }
    if (!hasNonEmptyString(quoteItem.summary)) {
      return `Quote #${quoteIndex} is missing 'summary'.`;
    }
    if (!hasNonEmptyString(quoteItem.category)) {
      return `Quote #${quoteIndex} is missing 'category'.`;
    }
    if (!quoteItem.speaker || typeof quoteItem.speaker !== "object") {
      return `Quote #${quoteIndex} is missing 'speaker'.`;
    }
    if (!hasNonEmptyString(quoteItem.speaker.name)) {
      return `Quote #${quoteIndex} is missing 'speaker.name'.`;
    }
    if (!hasNonEmptyString(quoteItem.speaker.designation)) {
      return `Quote #${quoteIndex} is missing 'speaker.designation'.`;
    }
  }

  return null;
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

  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return error(400, "BAD_REQUEST", "Field 'transcript' is required.");
  }

  const model = typeof body?.model === "string" ? body.model : DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) {
    return error(400, "BAD_REQUEST", "Field 'model' is invalid.");
  }

  try {
    const result = await callGeminiJson({
      apiKey: env.GEMINI_API_KEY,
      model,
      contents: [
        {
          parts: [
            {
              text: `${CHATTER_PROMPT}\n\nINPUT TRANSCRIPT:\n${transcript.substring(0, MAX_TRANSCRIPT_CHARS)}`,
            },
          ],
        },
      ],
      responseSchema: CHATTER_RESPONSE_SCHEMA,
    });

    const validationError = validateChatterResult(result);
    if (validationError) {
      return error(502, "UPSTREAM_ERROR", `Transcript analysis failed validation: ${validationError}`);
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

    return error(502, "UPSTREAM_ERROR", `Transcript analysis failed: ${message}`);
  }
}
