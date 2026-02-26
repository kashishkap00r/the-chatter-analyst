import {
  callGeminiJson,
  callOpenRouterJson,
  CHATTER_PROMPT,
  CHATTER_RESPONSE_SCHEMA,
  normalizeGeminiProviderPreference,
} from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 800000;
const PROVIDER_GEMINI = "gemini";
const PROVIDER_OPENROUTER = "openrouter";
const DEFAULT_PROVIDER = PROVIDER_GEMINI;
const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_3_MODEL = "gemini-3-flash-preview";
const PRO_MODEL = "gemini-3-pro-preview";
const OPENROUTER_PRIMARY_MODEL = "deepseek/deepseek-v3.2";
const OPENROUTER_BACKUP_MODEL = "minimax/minimax-m2.1";
const DEFAULT_MODEL = FLASH_3_MODEL;
const ALLOWED_MODELS = new Set([FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL]);
const OPENROUTER_ALLOWED_MODELS = new Set([OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL]);
const MAX_QUOTES_COUNT = 20;
const UPSTREAM_DEPENDENCY_STATUS = 424;
const VALIDATION_STATUS = 422;
const ALLOWED_CATEGORIES = new Set([
  "Financial Guidance",
  "Capital Allocation",
  "Cost & Supply Chain",
  "Tech & Disruption",
  "Regulation & Policy",
  "Macro & Geopolitics",
  "ESG & Climate",
  "Legal & Governance",
  "Competitive Landscape",
  "Other Material",
]);
const CATEGORY_NORMALIZATION_RULES: Array<{ match: RegExp; normalized: string }> = [
  { match: /(financial|guidance|margin|profit|revenue|ebitda)/i, normalized: "Financial Guidance" },
  { match: /(capital|capex|allocation|buyback|dividend)/i, normalized: "Capital Allocation" },
  { match: /(cost|supply|procurement|input)/i, normalized: "Cost & Supply Chain" },
  { match: /(tech|technology|digital|automation|ai)/i, normalized: "Tech & Disruption" },
  { match: /(regulat|policy|compliance|government)/i, normalized: "Regulation & Policy" },
  { match: /(macro|geopolitic|inflation|currency|demand cycle)/i, normalized: "Macro & Geopolitics" },
  { match: /(esg|climate|sustainab)/i, normalized: "ESG & Climate" },
  { match: /(legal|governance|litigation|audit)/i, normalized: "Legal & Governance" },
  { match: /(competitive|competition|market share|peer)/i, normalized: "Competitive Landscape" },
];

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

const error = (status: number, code: string, message: string, reasonCode?: string, details?: unknown): Response =>
  json({ error: { code, message, reasonCode, details } }, status);

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeNseScrip = (value: unknown): string => {
  if (!hasNonEmptyString(value)) return "";

  const raw = value.trim().toUpperCase();
  let candidate = raw;

  if (candidate.includes(":")) {
    const lastSegment = candidate.split(":").pop();
    if (lastSegment) {
      candidate = lastSegment;
    }
  }

  candidate = candidate
    .replace(/^NSE[\s\-_/]*/i, "")
    .replace(/^BSE[\s\-_/]*/i, "")
    .replace(/\.NS$/i, "")
    .replace(/\(NSE\)/i, "")
    .trim();

  const strict = candidate.replace(/[^A-Z0-9]/g, "");
  if (strict) return strict;

  const tokenMatches = raw.match(/[A-Z0-9]{2,15}/g) || [];
  const filtered = tokenMatches.filter((token) => token !== "NSE" && token !== "BSE");
  if (filtered.length === 0) return "";
  return filtered[filtered.length - 1];
};

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

const isSchemaConstraintError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("too many states") ||
    normalized.includes("specified schema produces a constraint")
  );
};

const isOverloadError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("503") ||
    normalized.includes("overload") ||
    normalized.includes("high demand") ||
    normalized.includes("temporarily unavailable")
  );
};

const isTimeoutError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("timed out") || normalized.includes("timeout");
};

const isLocationUnsupportedError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user location is not supported for the api use") ||
    normalized.includes("location is not supported for the api use")
  );
};

const isUpstreamTransientError = (message: string): boolean =>
  isOverloadError(message) ||
  isTimeoutError(message) ||
  message.includes("500") ||
  message.includes("502") ||
  message.includes("504");

const normalizeCategory = (rawCategory: string): string => {
  const trimmed = rawCategory.trim();
  if (!trimmed) {
    return "Other Material";
  }
  if (ALLOWED_CATEGORIES.has(trimmed)) {
    return trimmed;
  }
  for (const rule of CATEGORY_NORMALIZATION_RULES) {
    if (rule.match.test(trimmed)) {
      return rule.normalized;
    }
  }
  return "Other Material";
};

const getModelAttemptOrder = (requestedModel: string): string[] => {
  if (requestedModel === FLASH_MODEL) {
    return [FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL];
  }
  if (requestedModel === FLASH_3_MODEL) {
    return [FLASH_3_MODEL, FLASH_MODEL, PRO_MODEL];
  }
  return [PRO_MODEL, FLASH_3_MODEL, FLASH_MODEL];
};

const parseProvider = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_PROVIDER;
  const normalized = value.trim().toLowerCase();
  if (normalized === PROVIDER_GEMINI) return PROVIDER_GEMINI;
  if (normalized === PROVIDER_OPENROUTER) return PROVIDER_OPENROUTER;
  return "";
};

const getOpenRouterAttemptOrder = (requestedModel: string): string[] => {
  if (requestedModel === OPENROUTER_PRIMARY_MODEL) {
    return [OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL];
  }
  return [OPENROUTER_BACKUP_MODEL, OPENROUTER_PRIMARY_MODEL];
};

const isStructuredOutputError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("invalid json") || normalized.includes("empty response");
};

const validateChatterResult = (result: any): string | null => {
  if (!result || typeof result !== "object") {
    return "Gemini response is not a JSON object.";
  }

  const requiredRootFields = [
    "companyName",
    "fiscalPeriod",
    "marketCapCategory",
    "industry",
    "companyDescription",
  ];
  for (const field of requiredRootFields) {
    if (!hasNonEmptyString(result[field])) {
      return `Missing or invalid field '${field}'.`;
    }
  }

  result.nseScrip = normalizeNseScrip(result.nseScrip);

  if (!Array.isArray(result.quotes)) {
    return "Field 'quotes' must be an array.";
  }

  if (result.quotes.length < 1) {
    return "Field 'quotes' must contain at least 1 item.";
  }

  if (result.quotes.length > MAX_QUOTES_COUNT) {
    return `Field 'quotes' must contain at most ${MAX_QUOTES_COUNT} items, got ${result.quotes.length}.`;
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
    quoteItem.category = normalizeCategory(quoteItem.category);
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
  const requestId = request.headers.get("cf-ray") || crypto.randomUUID();

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

  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return error(400, "BAD_REQUEST", "Field 'transcript' is required.", "MISSING_TRANSCRIPT");
  }

  const provider = parseProvider(body?.provider);
  if (!provider) {
    return error(400, "BAD_REQUEST", "Field 'provider' is invalid.", "INVALID_PROVIDER");
  }

  const model =
    typeof body?.model === "string" && body.model.trim()
      ? body.model.trim()
      : provider === PROVIDER_OPENROUTER
        ? OPENROUTER_PRIMARY_MODEL
        : DEFAULT_MODEL;

  if (provider === PROVIDER_GEMINI && !ALLOWED_MODELS.has(model)) {
    return error(400, "BAD_REQUEST", "Field 'model' is invalid for provider 'gemini'.", "INVALID_MODEL");
  }
  if (provider === PROVIDER_OPENROUTER && !OPENROUTER_ALLOWED_MODELS.has(model)) {
    return error(400, "BAD_REQUEST", "Field 'model' is invalid for provider 'openrouter'.", "INVALID_MODEL");
  }

  const primaryApiKey = env?.GEMINI_API_KEY;
  const openRouterApiKey = env?.OPENROUTER_API_KEY;
  if (provider === PROVIDER_GEMINI && !primaryApiKey) {
    return error(500, "INTERNAL", "Server is missing GEMINI_API_KEY.", "MISSING_GEMINI_KEY");
  }
  if (provider === PROVIDER_OPENROUTER && !openRouterApiKey) {
    return error(500, "INTERNAL", "Server is missing OPENROUTER_API_KEY.", "MISSING_OPENROUTER_KEY");
  }

  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);
  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;
  const inputText = `${CHATTER_PROMPT}\n\nINPUT TRANSCRIPT:\n${transcript.substring(0, MAX_TRANSCRIPT_CHARS)}`;

  console.log(
    JSON.stringify({
      event: "chatter_request_start",
      requestId,
      provider,
      requestedModel: model,
      providerPreference,
      transcriptChars: transcript.length,
    }),
  );

  let lastMessage = "Unknown error";
  for (let attemptIndex = 0; attemptIndex < modelAttemptOrder.length; attemptIndex++) {
    const attemptModel = modelAttemptOrder[attemptIndex];
    const hasFallback = attemptIndex < modelAttemptOrder.length - 1;

    try {
      const result =
        provider === PROVIDER_GEMINI
          ? await callGeminiJson({
              apiKey: primaryApiKey as string,
              vertexApiKey: env.VERTEX_API_KEY,
              providerPreference,
              requestId,
              model: attemptModel,
              contents: [
                {
                  parts: [{ text: inputText }],
                },
              ],
              responseSchema: CHATTER_RESPONSE_SCHEMA,
            })
          : await callOpenRouterJson({
              apiKey: openRouterApiKey as string,
              model: attemptModel,
              requestId,
              referer: env.OPENROUTER_SITE_URL,
              appTitle: env.OPENROUTER_APP_TITLE || "The Chatter Analyst",
              messageContent:
                `${inputText}\n\n` +
                "FINAL OUTPUT REQUIREMENT: Return only one valid JSON object. No markdown, no explanation.",
            });

      const validationError = validateChatterResult(result);
      if (validationError) {
        console.log(
          JSON.stringify({
            event: "chatter_request_validation_failed",
            requestId,
            model: attemptModel,
            validationError,
          }),
        );
        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Transcript analysis failed validation.",
          "VALIDATION_FAILED",
          { requestId, validationError, model: attemptModel },
        );
      }

      console.log(
        JSON.stringify({
          event: "chatter_request_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          quotes: Array.isArray(result?.quotes) ? result.quotes.length : null,
        }),
      );

      if (attemptModel !== model) {
        console.log(
          JSON.stringify({
            event: "chatter_model_fallback_success",
            requestId,
            provider,
            requestedModel: model,
            resolvedModel: attemptModel,
          }),
        );
      }

      return json(result);
    } catch (err: any) {
      const message = String(err?.message || "Unknown error");
      lastMessage = message;

      const schemaConstraint = isSchemaConstraintError(message) || isStructuredOutputError(message);
      const upstreamRateLimit = isUpstreamRateLimit(message);
      const transientUpstream = isUpstreamTransientError(message);
      const locationUnsupported = provider === PROVIDER_GEMINI && isLocationUnsupportedError(message);
      const shouldFallback =
        hasFallback && (schemaConstraint || upstreamRateLimit || transientUpstream || locationUnsupported);

      console.log(
        JSON.stringify({
          event: "chatter_model_attempt_failure",
          requestId,
          provider,
          model: attemptModel,
          hasFallback,
          schemaConstraint,
          upstreamRateLimit,
          transientUpstream,
          locationUnsupported,
        }),
      );

      if (shouldFallback) {
        continue;
      }

      const details = {
        requestId,
        provider,
        model: attemptModel,
      };

      if (upstreamRateLimit) {
        const retryAfterSeconds = extractRetryAfterSeconds(message);
        return error(
          429,
          "RATE_LIMIT",
          retryAfterSeconds
            ? `Upstream quota/rate limit reached. Retry in about ${retryAfterSeconds}s.`
            : "Upstream quota/rate limit reached. Please retry shortly.",
          "UPSTREAM_RATE_LIMIT",
          details,
        );
      }

      if (schemaConstraint) {
        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Model could not satisfy strict structured output requirements.",
          "MODEL_SCHEMA_INCOMPATIBLE",
          details,
        );
      }

      if (isOverloadError(message)) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream model/provider is temporarily overloaded. Please retry.",
          "UPSTREAM_OVERLOAD",
          details,
        );
      }

      if (isTimeoutError(message)) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream request timed out. Please retry.",
          "UPSTREAM_TIMEOUT",
          details,
        );
      }

      if (locationUnsupported) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Gemini request was blocked by provider location policy after retries and model failover. Retry shortly or configure VERTEX_API_KEY for provider-level failover.",
          "UPSTREAM_LOCATION_UNSUPPORTED",
          details,
        );
      }

      if (transientUpstream) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream model request failed transiently. Please retry.",
          "UPSTREAM_TRANSIENT",
          details,
        );
      }

      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        `Transcript analysis failed: ${message}`,
        "UPSTREAM_FAILURE",
        details,
      );
    }
  }

  return error(
    UPSTREAM_DEPENDENCY_STATUS,
    "UPSTREAM_ERROR",
    `Transcript analysis failed: ${lastMessage}`,
    "UPSTREAM_FAILURE",
    { requestId, provider, model },
  );
}
