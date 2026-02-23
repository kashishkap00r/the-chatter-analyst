import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  THREAD_SHORTLIST_PROMPT,
  THREAD_SHORTLIST_RESPONSE_SCHEMA,
} from "../../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

interface ThreadQuoteCandidateInput {
  id: string;
  companyName: string;
  marketCapCategory: string;
  industry: string;
  summary: string;
  quote: string;
  speakerName: string;
  speakerDesignation: string;
}

const MAX_BODY_BYTES = 3 * 1024 * 1024;
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
const DEFAULT_MAX_CANDIDATES = 25;
const MAX_ALLOWED_CANDIDATES = 40;
const DEFAULT_MAX_PER_COMPANY = 2;

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
  if (requestedModel === OPENROUTER_BACKUP_MODEL) {
    return [OPENROUTER_BACKUP_MODEL, OPENROUTER_PRIMARY_MODEL];
  }
  return [OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL];
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

const normalizeText = (value: string, maxChars: number): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
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

const SIGNAL_TERMS = [
  "guidance",
  "pricing",
  "margin",
  "mix",
  "demand",
  "capacity",
  "allocation",
  "capex",
  "risk",
  "competition",
  "share",
  "strategy",
  "inflection",
  "structural",
  "regulatory",
  "pipeline",
  "utilization",
  "credit",
  "order book",
  "moat",
  "transformation",
  "turnaround",
  "pivot",
  "runway",
  "acquisition",
  "divestment",
];

const NOISE_TERMS = [
  "qoq",
  "yoy",
  "quarter",
  "last quarter",
  "sequential",
  "reported",
  "year-on-year",
];

const scoreQuote = (quote: ThreadQuoteCandidateInput): number => {
  const content = `${quote.summary} ${quote.quote}`.toLowerCase();
  const signalHits = SIGNAL_TERMS.reduce((sum, term) => sum + (content.includes(term) ? 1 : 0), 0);
  const noiseHits = NOISE_TERMS.reduce((sum, term) => sum + (content.includes(term) ? 1 : 0), 0);

  const summaryLen = quote.summary.length;
  const quoteLen = quote.quote.length;
  const lenPenalty = summaryLen > 420 ? 1 : 0;
  const qualityBonus = quoteLen >= 90 && quoteLen <= 420 ? 1 : 0;

  return signalHits * 3 + qualityBonus - noiseHits - lenPenalty;
};

const buildLocalRanking = (quotes: ThreadQuoteCandidateInput[]): ThreadQuoteCandidateInput[] =>
  [...quotes].sort((left, right) => {
    const scoreDiff = scoreQuote(right) - scoreQuote(left);
    if (scoreDiff !== 0) return scoreDiff;
    return left.id.localeCompare(right.id);
  });

const enforceCapAndTake = (
  orderedIds: string[],
  quoteById: Map<string, ThreadQuoteCandidateInput>,
  maxCandidates: number,
  maxPerCompany: number,
): string[] => {
  const result: string[] = [];
  const companyCounts = new Map<string, number>();

  for (const id of orderedIds) {
    const quote = quoteById.get(id);
    if (!quote) continue;

    const companyKey = quote.companyName.toLowerCase().trim();
    const currentCount = companyCounts.get(companyKey) ?? 0;
    if (currentCount >= maxPerCompany) {
      continue;
    }

    result.push(id);
    companyCounts.set(companyKey, currentCount + 1);

    if (result.length >= maxCandidates) {
      break;
    }
  }

  return result;
};

const mergeAndFillIds = (params: {
  preferredIds: string[];
  fallbackOrder: string[];
  quoteById: Map<string, ThreadQuoteCandidateInput>;
  maxCandidates: number;
  maxPerCompany: number;
}): string[] => {
  const { preferredIds, fallbackOrder, quoteById, maxCandidates, maxPerCompany } = params;
  const seen = new Set<string>();
  const combined: string[] = [];

  for (const id of [...preferredIds, ...fallbackOrder]) {
    if (!id || seen.has(id)) continue;
    if (!quoteById.has(id)) continue;
    seen.add(id);
    combined.push(id);
  }

  return enforceCapAndTake(combined, quoteById, maxCandidates, maxPerCompany);
};

const normalizeShortlistPayload = (value: any): string[] => {
  if (!value || typeof value !== "object") return [];
  const ids = Array.isArray(value.shortlistedQuoteIds) ? value.shortlistedQuoteIds : [];
  return ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim());
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

  const maxCandidatesRaw = Number(body?.maxCandidates);
  const maxCandidates =
    Number.isFinite(maxCandidatesRaw) && maxCandidatesRaw > 0
      ? Math.min(MAX_ALLOWED_CANDIDATES, Math.floor(maxCandidatesRaw))
      : DEFAULT_MAX_CANDIDATES;

  const maxPerCompanyRaw = Number(body?.maxPerCompany);
  const maxPerCompany =
    Number.isFinite(maxPerCompanyRaw) && maxPerCompanyRaw > 0
      ? Math.min(6, Math.floor(maxPerCompanyRaw))
      : DEFAULT_MAX_PER_COMPANY;

  const quoteInputs = Array.isArray(body?.quotes) ? body.quotes : [];
  if (quoteInputs.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'quotes' must contain at least one item.", "MISSING_QUOTES");
  }

  const quoteById = new Map<string, ThreadQuoteCandidateInput>();
  const normalizedQuotes: ThreadQuoteCandidateInput[] = [];

  for (let i = 0; i < quoteInputs.length; i++) {
    const quote = quoteInputs[i];
    const validationError = validateQuote(quote, i);
    if (validationError) {
      return error(400, "BAD_REQUEST", validationError, "INVALID_QUOTE");
    }

    const normalized: ThreadQuoteCandidateInput = {
      id: quote.id.trim(),
      companyName: quote.companyName.trim(),
      marketCapCategory: quote.marketCapCategory.trim(),
      industry: quote.industry.trim(),
      summary: quote.summary.trim(),
      quote: quote.quote.trim(),
      speakerName: quote.speakerName.trim(),
      speakerDesignation: quote.speakerDesignation.trim(),
    };

    if (!quoteById.has(normalized.id)) {
      quoteById.set(normalized.id, normalized);
      normalizedQuotes.push(normalized);
    }
  }

  if (normalizedQuotes.length === 0) {
    return error(400, "BAD_REQUEST", "No valid quotes found after normalization.", "NO_VALID_QUOTES");
  }

  const geminiApiKey = env?.GEMINI_API_KEY;
  const openRouterApiKey = env?.OPENROUTER_API_KEY;
  if (provider === PROVIDER_GEMINI && !geminiApiKey) {
    return error(500, "INTERNAL", "Server is missing GEMINI_API_KEY.", "MISSING_GEMINI_KEY");
  }
  if (provider === PROVIDER_OPENROUTER && !openRouterApiKey) {
    return error(500, "INTERNAL", "Server is missing OPENROUTER_API_KEY.", "MISSING_OPENROUTER_KEY");
  }

  const localRanking = buildLocalRanking(normalizedQuotes);
  const fallbackOrder = localRanking.map((quote) => quote.id);

  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);
  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;

  const shortlistInput = {
    maxCandidates,
    maxPerCompany,
    quotes: normalizedQuotes.map((quote) => ({
      id: quote.id,
      companyName: quote.companyName,
      marketCapCategory: quote.marketCapCategory,
      industry: quote.industry,
      summary: normalizeText(quote.summary, 220),
      quote: normalizeText(quote.quote, 360),
      speakerName: quote.speakerName,
      speakerDesignation: quote.speakerDesignation,
    })),
  };

  const inputText = `${THREAD_SHORTLIST_PROMPT}\n\nINPUT JSON:\n${JSON.stringify(shortlistInput)}`;

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
              responseSchema: THREAD_SHORTLIST_RESPONSE_SCHEMA,
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

      const aiIds = normalizeShortlistPayload(result);
      const shortlistedQuoteIds = mergeAndFillIds({
        preferredIds: aiIds,
        fallbackOrder,
        quoteById,
        maxCandidates,
        maxPerCompany,
      });

      return json({ shortlistedQuoteIds });
    } catch (analysisError: any) {
      const message = String(analysisError?.message || "Thread shortlist generation failed.");
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

      return error(VALIDATION_STATUS, "VALIDATION_FAILED", message, "THREAD_SHORTLIST_FAILED", {
        requestId,
        provider,
        model: attemptModel,
      });
    }
  }

  return error(500, "INTERNAL", lastMessage, "UNKNOWN_FAILURE");
}
