import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  THREAD_REGENERATE_PROMPT,
  THREAD_REGENERATE_RESPONSE_SCHEMA,
} from "../../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

interface TargetQuoteInput {
  id: string;
  companyName: string;
  marketCapCategory: string;
  industry: string;
  summary: string;
  quote: string;
  speakerName: string;
  speakerDesignation: string;
}

const MAX_BODY_BYTES = 1 * 1024 * 1024;
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
const UPSTREAM_DEPENDENCY_STATUS = 424;
const VALIDATION_STATUS = 422;
const MAX_TWEET_CHARS = 260;

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

const parseProvider = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_PROVIDER;
  const normalized = value.trim().toLowerCase();
  if (normalized === PROVIDER_GEMINI) return PROVIDER_GEMINI;
  if (normalized === PROVIDER_OPENROUTER) return PROVIDER_OPENROUTER;
  return "";
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

const getOpenRouterAttemptOrder = (requestedModel: string): string[] => {
  if (requestedModel === OPENROUTER_PRIMARY_MODEL) {
    return [OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL];
  }
  return [OPENROUTER_BACKUP_MODEL, OPENROUTER_PRIMARY_MODEL];
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
    normalized.includes("resource exhausted")
  );
};

const isSchemaConstraintError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("too many states") || normalized.includes("specified schema produces a constraint");
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
  isOverloadError(message) || isTimeoutError(message) || message.includes("500") || message.includes("502") || message.includes("504");

const normalizeTweet = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
  if (normalized.length <= MAX_TWEET_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TWEET_CHARS - 1).trimEnd()}…`;
};

const validateTargetQuote = (quote: any): quote is TargetQuoteInput => {
  if (!quote || typeof quote !== "object") return false;
  const required = [
    "id",
    "companyName",
    "marketCapCategory",
    "industry",
    "summary",
    "quote",
    "speakerName",
    "speakerDesignation",
  ];

  return required.every((field) => hasNonEmptyString(quote[field]));
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

  const tweetKind = hasNonEmptyString(body?.tweetKind) ? body.tweetKind.trim().toLowerCase() : "";
  if (!["intro", "insight", "outro"].includes(tweetKind)) {
    return error(400, "BAD_REQUEST", "Field 'tweetKind' must be intro, insight, or outro.", "INVALID_TWEET_KIND");
  }

  if (tweetKind === "insight" && !validateTargetQuote(body?.targetQuote)) {
    return error(
      400,
      "BAD_REQUEST",
      "Field 'targetQuote' is required for insight tweet regeneration.",
      "INVALID_TARGET_QUOTE",
    );
  }

  const usedTweetTexts: string[] = Array.isArray(body?.usedTweetTexts)
    ? body.usedTweetTexts.filter((item: unknown) => hasNonEmptyString(item)).map((item: string) => item.trim())
    : [];

  const editionMetadata = {
    editionTitle: hasNonEmptyString(body?.editionMetadata?.editionTitle)
      ? body.editionMetadata.editionTitle.trim()
      : "The Chatter",
    editionUrl: hasNonEmptyString(body?.editionMetadata?.editionUrl)
      ? body.editionMetadata.editionUrl.trim()
      : undefined,
    editionDate: hasNonEmptyString(body?.editionMetadata?.editionDate)
      ? body.editionMetadata.editionDate.trim()
      : undefined,
  };

  const geminiApiKey = env?.GEMINI_API_KEY;
  const openRouterApiKey = env?.OPENROUTER_API_KEY;
  if (provider === PROVIDER_GEMINI && !geminiApiKey) {
    return error(500, "INTERNAL", "Server is missing GEMINI_API_KEY.", "MISSING_GEMINI_KEY");
  }
  if (provider === PROVIDER_OPENROUTER && !openRouterApiKey) {
    return error(500, "INTERNAL", "Server is missing OPENROUTER_API_KEY.", "MISSING_OPENROUTER_KEY");
  }

  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);
  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;

  const inputPayload = {
    tweetKind,
    editionMetadata,
    currentTweet: hasNonEmptyString(body?.currentTweet) ? body.currentTweet.trim() : undefined,
    usedTweetTexts,
    targetQuote: tweetKind === "insight" ? body.targetQuote : undefined,
  };

  const inputText = `${THREAD_REGENERATE_PROMPT}\n\nINPUT JSON:\n${JSON.stringify(inputPayload)}`;

  let lastMessage = "Unknown error";
  for (let attemptIndex = 0; attemptIndex < modelAttemptOrder.length; attemptIndex++) {
    const attemptModel = modelAttemptOrder[attemptIndex];
    const hasFallback = attemptIndex < modelAttemptOrder.length - 1;

    try {
      const result =
        provider === PROVIDER_GEMINI
          ? await callGeminiJson({
              apiKey: geminiApiKey as string,
              vertexApiKey: env?.VERTEX_API_KEY,
              model: attemptModel,
              contents: [{ role: "user", parts: [{ text: inputText }] }],
              responseSchema: THREAD_REGENERATE_RESPONSE_SCHEMA,
              providerPreference,
              requestId,
            })
          : await callOpenRouterJson({
              apiKey: openRouterApiKey as string,
              model: attemptModel,
              messageContent: inputText,
              requestId,
              referer: env?.OPENROUTER_SITE_URL,
              appTitle: env?.OPENROUTER_APP_TITLE,
            });

      const tweet = normalizeTweet(result?.tweet);
      if (!tweet) {
        return error(VALIDATION_STATUS, "VALIDATION_FAILED", "Regenerated tweet is empty.", "EMPTY_TWEET");
      }

      return json({ tweet });
    } catch (analysisError: any) {
      const message = String(analysisError?.message || "Tweet regeneration failed.");
      lastMessage = message;

      const retryAfterSeconds = extractRetryAfterSeconds(message);
      if (isUpstreamRateLimit(message)) {
        return error(
          429,
          "UPSTREAM_RATE_LIMIT",
          message,
          "RATE_LIMITED",
          retryAfterSeconds ? { retryAfterSeconds } : undefined,
        );
      }

      if (isSchemaConstraintError(message)) {
        return error(400, "BAD_REQUEST", message, "SCHEMA_CONSTRAINT");
      }

      if (isLocationUnsupportedError(message)) {
        if (hasFallback) {
          continue;
        }
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_FAILED",
          "Gemini request was blocked by provider location policy. Please retry.",
          "UPSTREAM_LOCATION_UNSUPPORTED",
          { requestId, provider, model: attemptModel },
        );
      }

      if (isUpstreamTransientError(message)) {
        if (hasFallback) {
          continue;
        }
        return error(UPSTREAM_DEPENDENCY_STATUS, "UPSTREAM_FAILED", message, "UPSTREAM_TRANSIENT", {
          requestId,
          provider,
          model: attemptModel,
        });
      }

      if (hasFallback) {
        continue;
      }

      return error(VALIDATION_STATUS, "VALIDATION_FAILED", message, "THREAD_REGENERATE_FAILED", {
        requestId,
        provider,
        model: attemptModel,
      });
    }
  }

  return error(500, "INTERNAL", lastMessage, "UNKNOWN_FAILURE");
}
