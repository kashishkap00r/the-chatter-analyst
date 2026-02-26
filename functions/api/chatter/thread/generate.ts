import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  THREAD_DRAFT_PROMPT,
  THREAD_DRAFT_RESPONSE_SCHEMA,
} from "../../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

interface SelectedThreadQuote {
  id: string;
  companyName: string;
  marketCapCategory: string;
  industry: string;
  summary: string;
  quote: string;
  speakerName: string;
  speakerDesignation: string;
}

interface ThreadEditionMetadata {
  editionTitle: string;
  editionUrl?: string;
  editionDate?: string;
  companiesCovered?: number;
  industriesCovered?: number;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_QUOTES = 30;
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

const fallbackInsightTweet = (quote: SelectedThreadQuote): string => {
  const base = `${quote.companyName}: ${quote.summary}`.replace(/\s+/g, " ").trim();
  if (base.length <= MAX_TWEET_CHARS) {
    return base;
  }
  return `${base.slice(0, MAX_TWEET_CHARS - 1).trimEnd()}…`;
};

const validateQuote = (quote: any, index: number): string | null => {
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

  for (const field of required) {
    if (!hasNonEmptyString(quote?.[field])) {
      return `Quote #${index + 1} is missing field '${field}'.`;
    }
  }

  return null;
};

const normalizeDraftResult = (
  rawResult: any,
  selectedQuotes: SelectedThreadQuote[],
  editionMetadata: ThreadEditionMetadata,
): { introTweet: string; insightTweets: Array<{ quoteId: string; tweet: string }>; outroTweet: string } => {
  const introFallback = `Q results season is in full swing and management commentary is packed with signal. Here are the standout nuggets from this edition of The Chatter.`;
  const outroFallback = editionMetadata.editionUrl
    ? `For the full breakdown, read the complete edition here: ${editionMetadata.editionUrl}`
    : `For the full breakdown, read the complete edition on The Chatter.`;

  const introTweet = normalizeTweet(rawResult?.introTweet) || introFallback;
  const outroTweet = normalizeTweet(rawResult?.outroTweet) || outroFallback;

  const candidateInsights: Array<{ quoteId: string; tweet: string }> = Array.isArray(rawResult?.insightTweets)
    ? rawResult.insightTweets
        .map((item: any) => ({
          quoteId: hasNonEmptyString(item?.quoteId) ? item.quoteId.trim() : "",
          tweet: normalizeTweet(item?.tweet),
        }))
        .filter((item) => item.quoteId && item.tweet)
    : [];

  const byQuoteId = new Map<string, string>();
  for (const item of candidateInsights) {
    if (!byQuoteId.has(item.quoteId)) {
      byQuoteId.set(item.quoteId, item.tweet);
    }
  }

  const insightTweets = selectedQuotes.map((quote, index) => {
    const mapped = byQuoteId.get(quote.id);
    if (mapped) {
      return { quoteId: quote.id, tweet: mapped };
    }

    const fallbackByIndex = candidateInsights[index]?.tweet;
    return {
      quoteId: quote.id,
      tweet: fallbackByIndex || fallbackInsightTweet(quote),
    };
  });

  return {
    introTweet,
    insightTweets,
    outroTweet,
  };
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

  const selectedQuotes = Array.isArray(body?.selectedQuotes) ? body.selectedQuotes : [];
  if (selectedQuotes.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'selectedQuotes' must contain at least one quote.", "MISSING_QUOTES");
  }
  if (selectedQuotes.length > MAX_QUOTES) {
    return error(400, "BAD_REQUEST", `Field 'selectedQuotes' allows at most ${MAX_QUOTES} quotes.`, "TOO_MANY_QUOTES");
  }

  const seenIds = new Set<string>();
  const validatedQuotes: SelectedThreadQuote[] = [];

  for (let i = 0; i < selectedQuotes.length; i++) {
    const quote = selectedQuotes[i];
    const validationError = validateQuote(quote, i);
    if (validationError) {
      return error(400, "BAD_REQUEST", validationError, "INVALID_QUOTE");
    }

    const normalizedQuote: SelectedThreadQuote = {
      id: quote.id.trim(),
      companyName: quote.companyName.trim(),
      marketCapCategory: quote.marketCapCategory.trim(),
      industry: quote.industry.trim(),
      summary: quote.summary.trim(),
      quote: quote.quote.trim(),
      speakerName: quote.speakerName.trim(),
      speakerDesignation: quote.speakerDesignation.trim(),
    };

    if (seenIds.has(normalizedQuote.id)) {
      return error(400, "BAD_REQUEST", `Duplicate quote id '${normalizedQuote.id}' found.`, "DUPLICATE_QUOTE_ID");
    }
    seenIds.add(normalizedQuote.id);
    validatedQuotes.push(normalizedQuote);
  }

  const editionMetadata: ThreadEditionMetadata = {
    editionTitle: hasNonEmptyString(body?.editionMetadata?.editionTitle)
      ? body.editionMetadata.editionTitle.trim()
      : "The Chatter",
    editionUrl: hasNonEmptyString(body?.editionMetadata?.editionUrl)
      ? body.editionMetadata.editionUrl.trim()
      : undefined,
    editionDate: hasNonEmptyString(body?.editionMetadata?.editionDate)
      ? body.editionMetadata.editionDate.trim()
      : undefined,
    companiesCovered: Number.isFinite(Number(body?.editionMetadata?.companiesCovered))
      ? Number(body.editionMetadata.companiesCovered)
      : undefined,
    industriesCovered: Number.isFinite(Number(body?.editionMetadata?.industriesCovered))
      ? Number(body.editionMetadata.industriesCovered)
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
    editionMetadata,
    selectedQuotes: validatedQuotes,
  };

  const inputText = `${THREAD_DRAFT_PROMPT}\n\nINPUT JSON:\n${JSON.stringify(inputPayload)}`;

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
              responseSchema: THREAD_DRAFT_RESPONSE_SCHEMA,
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

      const normalized = normalizeDraftResult(result, validatedQuotes, editionMetadata);
      return json(normalized);
    } catch (analysisError: any) {
      const message = String(analysisError?.message || "Thread generation failed.");
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

      return error(VALIDATION_STATUS, "VALIDATION_FAILED", message, "THREAD_GENERATION_FAILED", {
        requestId,
        provider,
        model: attemptModel,
      });
    }
  }

  return error(500, "INTERNAL", lastMessage, "UNKNOWN_FAILURE");
}
