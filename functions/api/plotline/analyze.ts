import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  PLOTLINE_EXTRACT_PROMPT,
  PLOTLINE_EXTRACT_RESPONSE_SCHEMA,
} from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

interface KeywordEntry {
  source: string;
  token: string;
  compact: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 900000;
const MAX_KEYWORDS = 20;
const MAX_QUOTES_COUNT = 120;
const PROVIDER_GEMINI = "gemini";
const PROVIDER_OPENROUTER = "openrouter";
const DEFAULT_PROVIDER = PROVIDER_GEMINI;
const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_3_MODEL = "gemini-3-flash-preview";
const PRO_MODEL = "gemini-3-pro-preview";
const OPENROUTER_PRIMARY_MODEL = "minimax/minimax-01";
const OPENROUTER_BACKUP_MODEL = "qwen/qwen3-vl-235b-a22b-instruct";
const DEFAULT_MODEL = FLASH_3_MODEL;
const ALLOWED_MODELS = new Set([FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL]);
const OPENROUTER_ALLOWED_MODELS = new Set([OPENROUTER_PRIMARY_MODEL]);
const UPSTREAM_DEPENDENCY_STATUS = 424;
const VALIDATION_STATUS = 422;

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

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

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const normalizeToken = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeCompact = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const dedupeKeywordEntries = (value: unknown): KeywordEntry[] => {
  if (!Array.isArray(value)) return [];
  const entries: KeywordEntry[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!hasNonEmptyString(item)) continue;
    const source = item.trim();
    const token = normalizeToken(source);
    const compact = normalizeCompact(source);
    if (!token || !compact) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    entries.push({ source, token, compact });
    if (entries.length >= MAX_KEYWORDS) break;
  }

  return entries;
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
  isOverloadError(message) ||
  isTimeoutError(message) ||
  message.includes("500") ||
  message.includes("502") ||
  message.includes("504");

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
  if (requestedModel === OPENROUTER_BACKUP_MODEL) {
    return [OPENROUTER_BACKUP_MODEL, OPENROUTER_PRIMARY_MODEL];
  }
  return [OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL];
};

const isStructuredOutputError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("invalid json") || normalized.includes("empty response");
};

const canonicalizeYear = (value: number): number => {
  if (value >= 1900 && value <= 2100) return value;
  if (value >= 0 && value <= 99) return 2000 + value;
  return value;
};

const inferPeriodSortKey = (periodLabel: string, fiscalPeriod: string): number => {
  const sources = [periodLabel, fiscalPeriod].filter(hasNonEmptyString).map((item) => item.trim());

  for (const source of sources) {
    const monthMatch = source.match(/\b([A-Za-z]{3,9})\s*['-]?\s*(\d{2,4})\b/);
    if (monthMatch) {
      const month = MONTH_INDEX[monthMatch[1].toLowerCase()];
      const year = canonicalizeYear(Number(monthMatch[2]));
      if (month && Number.isInteger(year)) {
        return year * 100 + month;
      }
    }

    const quarterMatch = source.match(/\bQ([1-4])\s*FY\s*(\d{2,4})\b/i);
    if (quarterMatch) {
      const quarter = Number(quarterMatch[1]);
      const fiscalYear = canonicalizeYear(Number(quarterMatch[2]));
      if (Number.isInteger(quarter) && Number.isInteger(fiscalYear)) {
        const month = quarter === 1 ? 6 : quarter === 2 ? 9 : quarter === 3 ? 12 : 3;
        const year = quarter === 4 ? fiscalYear : fiscalYear - 1;
        return year * 100 + month;
      }
    }

    const fiscalMatch = source.match(/\bFY\s*(\d{2,4})\b/i);
    if (fiscalMatch) {
      const fiscalYear = canonicalizeYear(Number(fiscalMatch[1]));
      if (Number.isInteger(fiscalYear)) {
        return fiscalYear * 100 + 3;
      }
    }
  }

  const now = new Date();
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
};

const detectMatchedKeywords = (quote: string, keywords: KeywordEntry[]): string[] => {
  const lowerQuote = quote.toLowerCase();
  const tokenizedQuote = normalizeToken(quote);
  const compactQuote = normalizeCompact(quote);
  const matches = new Set<string>();

  for (const keyword of keywords) {
    const byLiteral = lowerQuote.includes(keyword.source.toLowerCase());
    const byToken = tokenizedQuote.includes(keyword.token);
    const byCompact = compactQuote.includes(keyword.compact);
    if (byLiteral || byToken || byCompact) {
      matches.add(keyword.source);
    }
  }

  return Array.from(matches);
};

const sanitizeMatchedKeywords = (raw: unknown, keywords: KeywordEntry[], quote: string): string[] => {
  const keywordByToken = new Map<string, string>(keywords.map((keyword) => [keyword.token, keyword.source]));
  const keywordByCompact = new Map<string, string>(keywords.map((keyword) => [keyword.compact, keyword.source]));
  const result = new Set<string>();

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!hasNonEmptyString(item)) continue;
      const token = normalizeToken(item);
      const compact = normalizeCompact(item);
      if (!token || !compact) continue;
      const matched = keywordByToken.get(token) || keywordByCompact.get(compact);
      if (matched) {
        result.add(matched);
      }
    }
  }

  if (result.size === 0) {
    const inferred = detectMatchedKeywords(quote, keywords);
    for (const item of inferred) {
      result.add(item);
    }
  }

  return Array.from(result);
};

const validateRootFields = (result: any): string | null => {
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

  const normalizedScrip = result.nseScrip.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalizedScrip) {
    return "Field 'nseScrip' must contain at least one A-Z or 0-9 character.";
  }
  result.nseScrip = normalizedScrip;

  if (!Array.isArray(result.quotes)) {
    return "Field 'quotes' must be an array.";
  }

  if (result.quotes.length > MAX_QUOTES_COUNT) {
    return `Field 'quotes' must contain at most ${MAX_QUOTES_COUNT} items.`;
  }

  return null;
};

const sanitizeQuotes = (rawQuotes: any[], keywords: KeywordEntry[], fiscalPeriod: string): any[] => {
  const uniqueMap = new Map<string, any>();

  for (const rawQuote of rawQuotes) {
    if (!rawQuote || typeof rawQuote !== "object") continue;
    if (!hasNonEmptyString(rawQuote.quote)) continue;

    const quote = rawQuote.quote.trim();
    if (!quote) continue;

    const matchedKeywords = sanitizeMatchedKeywords(rawQuote.matchedKeywords, keywords, quote);
    if (matchedKeywords.length === 0) {
      continue;
    }

    const speakerName = hasNonEmptyString(rawQuote.speakerName) ? rawQuote.speakerName.trim() : "Management";
    const speakerDesignation = hasNonEmptyString(rawQuote.speakerDesignation)
      ? rawQuote.speakerDesignation.trim()
      : "Company Management";
    const periodLabel = hasNonEmptyString(rawQuote.periodLabel) ? rawQuote.periodLabel.trim() : fiscalPeriod;
    const periodSortKey =
      isInteger(rawQuote.periodSortKey) && rawQuote.periodSortKey >= 190001 && rawQuote.periodSortKey <= 210012
        ? rawQuote.periodSortKey
        : inferPeriodSortKey(periodLabel, fiscalPeriod);

    const uniqueKey = `${quote.toLowerCase()}|${speakerName.toLowerCase()}|${periodSortKey}`;
    if (uniqueMap.has(uniqueKey)) continue;

    uniqueMap.set(uniqueKey, {
      quote,
      speakerName,
      speakerDesignation,
      matchedKeywords,
      periodLabel,
      periodSortKey,
    });
  }

  return Array.from(uniqueMap.values()).sort((left, right) => {
    if (left.periodSortKey !== right.periodSortKey) {
      return left.periodSortKey - right.periodSortKey;
    }
    return left.quote.localeCompare(right.quote);
  });
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

  const transcript = hasNonEmptyString(body?.transcript) ? body.transcript.trim() : "";
  if (!transcript) {
    return error(400, "BAD_REQUEST", "Field 'transcript' is required.", "MISSING_TRANSCRIPT");
  }

  const keywords = dedupeKeywordEntries(body?.keywords);
  if (keywords.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'keywords' must contain at least one keyword.", "MISSING_KEYWORDS");
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

  const keywordBlock = keywords.map((keyword) => `- ${keyword.source}`).join("\n");
  const inputText = [
    PLOTLINE_EXTRACT_PROMPT,
    "",
    "TARGET KEYWORDS:",
    keywordBlock,
    "",
    "INPUT TRANSCRIPT:",
    transcript.substring(0, MAX_TRANSCRIPT_CHARS),
  ].join("\n");

  console.log(
    JSON.stringify({
      event: "plotline_request_start",
      requestId,
      provider,
      requestedModel: model,
      providerPreference,
      transcriptChars: transcript.length,
      keywordCount: keywords.length,
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
              apiKey: geminiApiKey as string,
              vertexApiKey: env.VERTEX_API_KEY,
              providerPreference,
              requestId,
              model: attemptModel,
              contents: [
                {
                  parts: [{ text: inputText }],
                },
              ],
              responseSchema: PLOTLINE_EXTRACT_RESPONSE_SCHEMA,
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

      const validationError = validateRootFields(result);
      if (validationError) {
        console.log(
          JSON.stringify({
            event: "plotline_request_validation_failed",
            requestId,
            model: attemptModel,
            validationError,
          }),
        );
        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Plotline transcript analysis failed validation.",
          "VALIDATION_FAILED",
          { requestId, validationError, model: attemptModel },
        );
      }

      result.quotes = sanitizeQuotes(Array.isArray(result.quotes) ? result.quotes : [], keywords, result.fiscalPeriod);

      console.log(
        JSON.stringify({
          event: "plotline_request_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          quotes: result.quotes.length,
        }),
      );

      if (attemptModel !== model) {
        console.log(
          JSON.stringify({
            event: "plotline_model_fallback_success",
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
      const shouldFallback = hasFallback && (schemaConstraint || upstreamRateLimit || transientUpstream || locationUnsupported);

      console.log(
        JSON.stringify({
          event: "plotline_model_attempt_failure",
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
          "Upstream request failed transiently. Please retry.",
          "UPSTREAM_TRANSIENT",
          details,
        );
      }

      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        `Plotline transcript analysis failed: ${message}`,
        "UPSTREAM_FAILURE",
        details,
      );
    }
  }

  return error(
    UPSTREAM_DEPENDENCY_STATUS,
    "UPSTREAM_ERROR",
    `Plotline transcript analysis failed: ${lastMessage}`,
    "UPSTREAM_FAILURE",
    { requestId, provider, model },
  );
}
