import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  PLOTLINE_SUMMARIZE_PROMPT,
  PLOTLINE_SUMMARIZE_RESPONSE_SCHEMA,
} from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

interface PlotlineQuoteInput {
  quote: string;
  speakerName: string;
  speakerDesignation: string;
  matchedKeywords: string[];
  periodLabel: string;
  periodSortKey: number;
}

interface PlotlineCompanyInput {
  companyKey: string;
  companyName: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  quotes: PlotlineQuoteInput[];
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_KEYWORDS = 20;
const MAX_COMPANIES = 60;
const MAX_QUOTES_PER_COMPANY = 12;
const MAX_TOTAL_QUOTES = 320;
const MAX_QUOTE_CHARS = 900;
const MAX_NARRATIVE_CHARS = 1400;
const MAX_BULLETS = 10;
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

const dedupeKeywords = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of value) {
    if (!hasNonEmptyString(item)) continue;
    const source = item.trim();
    const token = normalizeToken(source);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    output.push(source);
    if (output.length >= MAX_KEYWORDS) break;
  }

  return output;
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

const normalizeQuote = (quote: any, keywordSet: Set<string>): PlotlineQuoteInput | null => {
  if (!quote || typeof quote !== "object") return null;
  if (!hasNonEmptyString(quote.quote)) return null;

  const matchedKeywords = Array.isArray(quote.matchedKeywords)
    ? quote.matchedKeywords
        .filter((item: unknown): item is string => hasNonEmptyString(item))
        .map((item) => item.trim())
        .filter((item) => keywordSet.has(normalizeToken(item)))
    : [];

  if (matchedKeywords.length === 0) {
    return null;
  }

  return {
    quote: quote.quote.trim().slice(0, MAX_QUOTE_CHARS),
    speakerName: hasNonEmptyString(quote.speakerName) ? quote.speakerName.trim() : "Management",
    speakerDesignation: hasNonEmptyString(quote.speakerDesignation)
      ? quote.speakerDesignation.trim()
      : "Company Management",
    matchedKeywords: Array.from(new Set(matchedKeywords)),
    periodLabel: hasNonEmptyString(quote.periodLabel) ? quote.periodLabel.trim() : "Unknown Period",
    periodSortKey:
      isInteger(quote.periodSortKey) && quote.periodSortKey >= 190001 && quote.periodSortKey <= 210012
        ? quote.periodSortKey
        : 200001,
  };
};

const normalizeCompany = (company: any, keywordSet: Set<string>): PlotlineCompanyInput | null => {
  if (!company || typeof company !== "object") return null;
  const requiredFields = [
    "companyKey",
    "companyName",
    "nseScrip",
    "marketCapCategory",
    "industry",
    "companyDescription",
  ];
  for (const field of requiredFields) {
    if (!hasNonEmptyString(company[field])) return null;
  }

  const normalizedScrip = company.nseScrip.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalizedScrip) return null;

  if (!Array.isArray(company.quotes) || company.quotes.length === 0) {
    return null;
  }

  const quotes = company.quotes
    .map((quote: any) => normalizeQuote(quote, keywordSet))
    .filter((quote: PlotlineQuoteInput | null): quote is PlotlineQuoteInput => Boolean(quote))
    .slice(0, MAX_QUOTES_PER_COMPANY);

  if (quotes.length === 0) return null;

  return {
    companyKey: company.companyKey.trim(),
    companyName: company.companyName.trim(),
    nseScrip: normalizedScrip,
    marketCapCategory: company.marketCapCategory.trim(),
    industry: company.industry.trim(),
    companyDescription: company.companyDescription.trim(),
    quotes,
  };
};

const normalizeCompanies = (value: unknown, keywordSet: Set<string>): PlotlineCompanyInput[] => {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map((company) => normalizeCompany(company, keywordSet))
    .filter((company: PlotlineCompanyInput | null): company is PlotlineCompanyInput => Boolean(company))
    .slice(0, MAX_COMPANIES);

  const uniqueByKey = new Map<string, PlotlineCompanyInput>();
  for (const company of normalized) {
    if (!uniqueByKey.has(company.companyKey)) {
      uniqueByKey.set(company.companyKey, company);
    }
  }

  return Array.from(uniqueByKey.values());
};

const sanitizeNarrative = (value: unknown): string => {
  if (!hasNonEmptyString(value)) return "";
  const normalized = value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_NARRATIVE_CHARS);
  return normalized;
};

const sanitizeBullets = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  const bullets: string[] = [];
  for (const item of value) {
    if (!hasNonEmptyString(item)) continue;
    const normalized = item.trim().replace(/\s+/g, " ");
    if (!normalized || unique.has(normalized.toLowerCase())) continue;
    unique.add(normalized.toLowerCase());
    bullets.push(normalized);
    if (bullets.length >= MAX_BULLETS) break;
  }
  return bullets;
};

const normalizeSummaryResult = (
  value: any,
  companies: PlotlineCompanyInput[],
  keywords: string[],
): { companyNarratives: Array<{ companyKey: string; narrative: string }>; masterThemeBullets: string[] } => {
  const allowedCompanyKeys = new Set(companies.map((company) => company.companyKey));
  const narrativeMap = new Map<string, string>();

  if (value && typeof value === "object" && Array.isArray(value.companyNarratives)) {
    for (const item of value.companyNarratives) {
      if (!item || typeof item !== "object") continue;
      if (!hasNonEmptyString(item.companyKey) || !allowedCompanyKeys.has(item.companyKey.trim())) continue;
      const narrative = sanitizeNarrative(item.narrative);
      if (!narrative) continue;
      narrativeMap.set(item.companyKey.trim(), narrative);
    }
  }

  const fallbackNarrative = `Management commentary suggests this keyword is tied to strategic direction, not a one-quarter update.`;
  const companyNarratives = companies.map((company) => ({
    companyKey: company.companyKey,
    narrative: narrativeMap.get(company.companyKey) || fallbackNarrative,
  }));

  const bullets = sanitizeBullets(value?.masterThemeBullets);
  const masterThemeBullets =
    bullets.length > 0 ? bullets : [`Across companies, ${keywords.join(", ")} is emerging as a structural management theme.`];

  return {
    companyNarratives,
    masterThemeBullets,
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

  const keywords = dedupeKeywords(body?.keywords);
  if (keywords.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'keywords' must contain at least one keyword.", "MISSING_KEYWORDS");
  }
  const keywordSet = new Set(keywords.map((keyword) => normalizeToken(keyword)));

  const companies = normalizeCompanies(body?.companies, keywordSet);
  if (companies.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'companies' must contain valid company quote data.", "MISSING_COMPANIES");
  }

  const totalQuotes = companies.reduce((sum, company) => sum + company.quotes.length, 0);
  if (totalQuotes > MAX_TOTAL_QUOTES) {
    return error(
      400,
      "BAD_REQUEST",
      `Too many total quotes for summary (${totalQuotes}, max ${MAX_TOTAL_QUOTES}).`,
      "TOO_MANY_QUOTES",
    );
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

  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;
  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);

  const inputText = [
    PLOTLINE_SUMMARIZE_PROMPT,
    "",
    "THEME KEYWORDS:",
    keywords.map((keyword) => `- ${keyword}`).join("\n"),
    "",
    "COMPANY QUOTE DATA (JSON):",
    JSON.stringify(companies),
  ].join("\n");

  console.log(
    JSON.stringify({
      event: "plotline_summary_start",
      requestId,
      provider,
      requestedModel: model,
      providerPreference,
      keywordCount: keywords.length,
      companyCount: companies.length,
      totalQuotes,
    }),
  );

  let lastMessage = "Unknown error";
  for (let attemptIndex = 0; attemptIndex < modelAttemptOrder.length; attemptIndex++) {
    const attemptModel = modelAttemptOrder[attemptIndex];
    const hasFallback = attemptIndex < modelAttemptOrder.length - 1;

    try {
      const raw =
        provider === PROVIDER_GEMINI
          ? await callGeminiJson({
              apiKey: geminiApiKey as string,
              vertexApiKey: env.VERTEX_API_KEY,
              providerPreference,
              requestId,
              model: attemptModel,
              contents: [{ parts: [{ text: inputText }] }],
              responseSchema: PLOTLINE_SUMMARIZE_RESPONSE_SCHEMA,
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

      const result = normalizeSummaryResult(raw, companies, keywords);
      if (result.companyNarratives.length === 0 || result.masterThemeBullets.length === 0) {
        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Plotline summary failed validation.",
          "VALIDATION_FAILED",
          { requestId, model: attemptModel },
        );
      }

      console.log(
        JSON.stringify({
          event: "plotline_summary_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          companyNarratives: result.companyNarratives.length,
          bullets: result.masterThemeBullets.length,
        }),
      );

      if (attemptModel !== model) {
        console.log(
          JSON.stringify({
            event: "plotline_summary_model_fallback_success",
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
          event: "plotline_summary_model_attempt_failure",
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
        `Plotline summary failed: ${message}`,
        "UPSTREAM_FAILURE",
        details,
      );
    }
  }

  return error(
    UPSTREAM_DEPENDENCY_STATUS,
    "UPSTREAM_ERROR",
    `Plotline summary failed: ${lastMessage}`,
    "UPSTREAM_FAILURE",
    { requestId, provider, model },
  );
}
