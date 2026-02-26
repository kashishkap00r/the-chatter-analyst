import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  PLOTLINE_PLAN_PROMPT,
  PLOTLINE_PLAN_RESPONSE_SCHEMA,
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
  quoteId: string;
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

interface PlotlinePlanSection {
  companyKey: string;
  subhead: string;
  narrativeAngle: string;
  chronologyMode: "timeline" | "same_period";
  quoteIds: string[];
}

interface PlotlinePlanResult {
  title: string;
  dek: string;
  sectionPlans: PlotlinePlanSection[];
  skippedCompanyKeys: string[];
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_KEYWORDS = 20;
const MAX_COMPANIES = 60;
const MAX_QUOTES_PER_COMPANY = 16;
const MAX_TOTAL_QUOTES = 320;
const MAX_QUOTE_CHARS = 1200;
const MAX_SUBHEAD_CHARS = 120;
const MAX_ANGLE_CHARS = 260;
const MAX_TITLE_CHARS = 120;
const MAX_DEK_CHARS = 240;
const PROVIDER_GEMINI = "gemini";
const PROVIDER_OPENROUTER = "openrouter";
const DEFAULT_PROVIDER = PROVIDER_GEMINI;
const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_3_MODEL = "gemini-3-flash-preview";
const PRO_MODEL = "gemini-3-pro-preview";
const OPENROUTER_PRIMARY_MODEL = "minimax/minimax-m2.5";
const OPENROUTER_BACKUP_MODEL = "mistralai/mistral-large-2512";
const DEFAULT_MODEL = FLASH_3_MODEL;
const ALLOWED_MODELS = new Set([FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL]);
const OPENROUTER_ALLOWED_MODELS = new Set([OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL]);

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

const normalizeQuote = (quote: any, keywordSet: Set<string>): PlotlineQuoteInput | null => {
  if (!quote || typeof quote !== "object") return null;
  if (!hasNonEmptyString(quote.quoteId)) return null;
  if (!hasNonEmptyString(quote.quote)) return null;

  const matchedKeywords = Array.isArray(quote.matchedKeywords)
    ? quote.matchedKeywords
        .filter((item: unknown): item is string => hasNonEmptyString(item))
        .map((item) => item.trim())
        .filter((item) => keywordSet.has(normalizeToken(item)))
    : [];

  if (matchedKeywords.length === 0) return null;

  const periodSortKey =
    isInteger(quote.periodSortKey) && quote.periodSortKey >= 190001 && quote.periodSortKey <= 210012
      ? quote.periodSortKey
      : 200001;

  return {
    quoteId: quote.quoteId.trim().slice(0, 120),
    quote: quote.quote.trim().replace(/\s+/g, " ").slice(0, MAX_QUOTE_CHARS),
    speakerName: hasNonEmptyString(quote.speakerName) ? quote.speakerName.trim() : "Management",
    speakerDesignation: hasNonEmptyString(quote.speakerDesignation)
      ? quote.speakerDesignation.trim()
      : "Company Management",
    matchedKeywords: Array.from(new Set(matchedKeywords)),
    periodLabel: hasNonEmptyString(quote.periodLabel) ? quote.periodLabel.trim() : "Unknown Period",
    periodSortKey,
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

  const dedupedQuoteById = new Map<string, PlotlineQuoteInput>();
  for (const rawQuote of company.quotes) {
    const normalized = normalizeQuote(rawQuote, keywordSet);
    if (!normalized) continue;
    if (!dedupedQuoteById.has(normalized.quoteId)) {
      dedupedQuoteById.set(normalized.quoteId, normalized);
    }
  }

  const quotes = Array.from(dedupedQuoteById.values())
    .sort((left, right) => {
      if (left.periodSortKey !== right.periodSortKey) return left.periodSortKey - right.periodSortKey;
      return left.quote.localeCompare(right.quote);
    })
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

const inferChronologyMode = (quotes: PlotlineQuoteInput[]): "timeline" | "same_period" => {
  const periods = new Set(quotes.map((quote) => quote.periodSortKey));
  return periods.size >= 2 ? "timeline" : "same_period";
};

const buildFallbackPlan = (keywords: string[], companies: PlotlineCompanyInput[]): PlotlinePlanResult => {
  const scoredCompanies = companies
    .map((company) => {
      const latestSortKey = company.quotes.reduce((max, quote) => Math.max(max, quote.periodSortKey), 0);
      const score = company.quotes.length * 2 + latestSortKey / 100000;
      return {
        company,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  const strong = scoredCompanies.filter((entry) => entry.company.quotes.length >= 2);
  const selected = (strong.length > 0 ? strong : scoredCompanies).slice(0, 10);

  const sectionPlans: PlotlinePlanSection[] = selected.map((entry) => {
    const company = entry.company;
    const chronologyMode = inferChronologyMode(company.quotes);
    const quoteIds = [...company.quotes]
      .sort((left, right) => right.periodSortKey - left.periodSortKey)
      .slice(0, 3)
      .map((quote) => quote.quoteId);

    return {
      companyKey: company.companyKey,
      subhead: `${company.companyName}: management signal gets clearer`,
      narrativeAngle:
        chronologyMode === "timeline"
          ? "Track how management framing evolved from earlier commentary to the latest stance."
          : "Show what this company reveals about the theme in the current quarter versus peers.",
      chronologyMode,
      quoteIds,
    };
  });

  const selectedKeys = new Set(sectionPlans.map((section) => section.companyKey));
  const skippedCompanyKeys = companies
    .map((company) => company.companyKey)
    .filter((companyKey) => !selectedKeys.has(companyKey));

  const keywordTitle = keywords.join(", ");
  return {
    title: `Plotline: ${keywordTitle}`,
    dek: `Management commentary across companies shows how ${keywordTitle} is shifting strategy and industry direction.`,
    sectionPlans,
    skippedCompanyKeys,
  };
};

const sanitizeTitle = (value: unknown, fallback: string): string => {
  if (!hasNonEmptyString(value)) return fallback;
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS);
};

const sanitizeDek = (value: unknown, fallback: string): string => {
  if (!hasNonEmptyString(value)) return fallback;
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_DEK_CHARS);
};

const normalizePlanResult = (
  raw: any,
  keywords: string[],
  companies: PlotlineCompanyInput[],
): PlotlinePlanResult => {
  const fallback = buildFallbackPlan(keywords, companies);
  if (!raw || typeof raw !== "object") return fallback;

  const companyByKey = new Map(companies.map((company) => [company.companyKey, company]));
  const sections: PlotlinePlanSection[] = [];
  const seenCompanyKeys = new Set<string>();

  if (Array.isArray(raw.sectionPlans)) {
    for (const item of raw.sectionPlans) {
      if (!item || typeof item !== "object") continue;
      if (!hasNonEmptyString(item.companyKey)) continue;
      const companyKey = item.companyKey.trim();
      if (seenCompanyKeys.has(companyKey)) continue;
      const company = companyByKey.get(companyKey);
      if (!company) continue;

      const validQuoteIdSet = new Set(company.quotes.map((quote) => quote.quoteId));
      const quoteIds: string[] = Array.isArray(item.quoteIds)
        ? item.quoteIds
            .filter((quoteId: unknown): quoteId is string => hasNonEmptyString(quoteId))
            .map((quoteId) => quoteId.trim())
            .filter((quoteId) => validQuoteIdSet.has(quoteId))
        : [];

      const dedupedQuoteIds: string[] = Array.from(new Set<string>(quoteIds)).slice(0, 3);
      if (dedupedQuoteIds.length === 0) {
        const fallbackQuoteIds = company.quotes.slice(-3).map((quote) => quote.quoteId);
        if (fallbackQuoteIds.length === 0) continue;
        dedupedQuoteIds.push(...fallbackQuoteIds);
      }

      const chronologyModeRaw = hasNonEmptyString(item.chronologyMode)
        ? item.chronologyMode.trim().toLowerCase()
        : "";
      const chronologyMode: "timeline" | "same_period" = chronologyModeRaw === "timeline" ? "timeline" : "same_period";

      sections.push({
        companyKey,
        subhead: hasNonEmptyString(item.subhead)
          ? item.subhead.trim().replace(/\s+/g, " ").slice(0, MAX_SUBHEAD_CHARS)
          : `${company.companyName}: management signal gets clearer`,
        narrativeAngle: hasNonEmptyString(item.narrativeAngle)
          ? item.narrativeAngle.trim().replace(/\s+/g, " ").slice(0, MAX_ANGLE_CHARS)
          : "Explain the strategic signal from management commentary and why it matters.",
        chronologyMode,
        quoteIds: dedupedQuoteIds,
      });

      seenCompanyKeys.add(companyKey);
    }
  }

  if (sections.length === 0) return fallback;

  const fallbackSectionByCompany = new Map(fallback.sectionPlans.map((section) => [section.companyKey, section]));
  const sortedSections = sections.sort((left, right) => {
    const leftIndex = fallbackSectionByCompany.has(left.companyKey)
      ? fallback.sectionPlans.findIndex((section) => section.companyKey === left.companyKey)
      : Number.MAX_SAFE_INTEGER;
    const rightIndex = fallbackSectionByCompany.has(right.companyKey)
      ? fallback.sectionPlans.findIndex((section) => section.companyKey === right.companyKey)
      : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });

  const rawSkipped: string[] = Array.isArray(raw.skippedCompanyKeys)
    ? raw.skippedCompanyKeys
        .filter((item: unknown): item is string => hasNonEmptyString(item))
        .map((item) => item.trim())
        .filter((item) => companyByKey.has(item))
    : [];

  const skippedSet = new Set(rawSkipped);
  for (const company of companies) {
    if (!sortedSections.some((section) => section.companyKey === company.companyKey)) {
      skippedSet.add(company.companyKey);
    }
  }

  return {
    title: sanitizeTitle(raw.title, fallback.title),
    dek: sanitizeDek(raw.dek, fallback.dek),
    sectionPlans: sortedSections,
    skippedCompanyKeys: Array.from(skippedSet),
  };
};

const buildModelInput = (keywords: string[], companies: PlotlineCompanyInput[]): string => {
  const compactEvidence = companies.map((company) => ({
    companyKey: company.companyKey,
    companyName: company.companyName,
    marketCapCategory: company.marketCapCategory,
    industry: company.industry,
    quoteEvidence: company.quotes.map((quote) => ({
      quoteId: quote.quoteId,
      periodLabel: quote.periodLabel,
      periodSortKey: quote.periodSortKey,
      quote: quote.quote,
      speakerName: quote.speakerName,
      speakerDesignation: quote.speakerDesignation,
      matchedKeywords: quote.matchedKeywords,
    })),
  }));

  return [
    PLOTLINE_PLAN_PROMPT,
    "",
    "THEME KEYWORDS:",
    keywords.map((keyword) => `- ${keyword}`).join("\n"),
    "",
    "COMPANY EVIDENCE (JSON):",
    JSON.stringify(compactEvidence),
  ].join("\n");
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
      `Too many total quotes for story planning (${totalQuotes}, max ${MAX_TOTAL_QUOTES}).`,
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

  const fallbackPlan = buildFallbackPlan(keywords, companies);
  const geminiApiKey = env?.GEMINI_API_KEY;
  const openRouterApiKey = env?.OPENROUTER_API_KEY;
  const providerReady =
    (provider === PROVIDER_GEMINI && hasNonEmptyString(geminiApiKey)) ||
    (provider === PROVIDER_OPENROUTER && hasNonEmptyString(openRouterApiKey));

  if (!providerReady) {
    console.log(
      JSON.stringify({
        event: "plotline_plan_fallback_no_key",
        requestId,
        provider,
      }),
    );
    return json(fallbackPlan);
  }

  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;
  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);

  const inputText = buildModelInput(keywords, companies);

  console.log(
    JSON.stringify({
      event: "plotline_plan_start",
      requestId,
      provider,
      requestedModel: model,
      providerPreference,
      keywordCount: keywords.length,
      companyCount: companies.length,
      totalQuotes,
    }),
  );

  for (let attemptIndex = 0; attemptIndex < modelAttemptOrder.length; attemptIndex++) {
    const attemptModel = modelAttemptOrder[attemptIndex];

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
              responseSchema: PLOTLINE_PLAN_RESPONSE_SCHEMA,
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

      const plan = normalizePlanResult(raw, keywords, companies);

      console.log(
        JSON.stringify({
          event: "plotline_plan_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          sections: plan.sectionPlans.length,
          skipped: plan.skippedCompanyKeys.length,
        }),
      );

      return json(plan);
    } catch (err: any) {
      const message = String(err?.message || "Unknown planning failure");
      console.log(
        JSON.stringify({
          event: "plotline_plan_attempt_failed",
          requestId,
          provider,
          model: attemptModel,
          message,
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "plotline_plan_fallback_after_failures",
      requestId,
      provider,
      sections: fallbackPlan.sectionPlans.length,
    }),
  );

  return json(fallbackPlan);
}
