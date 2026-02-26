import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  PLOTLINE_WRITE_PROMPT,
  PLOTLINE_WRITE_RESPONSE_SCHEMA,
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

interface PlotlinePlanInput {
  title: string;
  dek: string;
  sectionPlans: PlotlinePlanSection[];
  skippedCompanyKeys: string[];
}

interface PlotlineStorySectionOutput {
  companyKey: string;
  companyName: string;
  subhead: string;
  narrativeParagraphs: string[];
  quoteBlocks: PlotlineQuoteInput[];
}

interface PlotlineStoryResult {
  title: string;
  dek: string;
  sections: PlotlineStorySectionOutput[];
  closingWatchlist: string[];
  skippedCompanies: string[];
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_KEYWORDS = 20;
const MAX_COMPANIES = 60;
const MAX_QUOTES_PER_COMPANY = 16;
const MAX_TOTAL_QUOTES = 320;
const MAX_QUOTE_CHARS = 1200;
const MAX_SUBHEAD_CHARS = 120;
const MAX_ANGLE_CHARS = 260;
const MAX_TITLE_CHARS = 120;
const MAX_DEK_CHARS = 260;
const MAX_PARAGRAPH_CHARS = 520;
const MAX_PARAGRAPHS_PER_SECTION = 4;
const MAX_WATCHLIST_LINES = 5;
const MIN_WATCHLIST_LINES = 3;
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

const sanitizeSentence = (value: string, maxChars: number): string =>
  value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxChars);

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

const buildFallbackPlan = (keywords: string[], companies: PlotlineCompanyInput[]): PlotlinePlanInput => {
  const scored = companies
    .map((company) => {
      const latestSortKey = company.quotes.reduce((max, quote) => Math.max(max, quote.periodSortKey), 0);
      return {
        company,
        score: company.quotes.length * 2 + latestSortKey / 100000,
      };
    })
    .sort((left, right) => right.score - left.score);

  const selected = scored.slice(0, 10);
  const sectionPlans: PlotlinePlanSection[] = selected.map((entry) => {
    const chronologyMode = inferChronologyMode(entry.company.quotes);
    const quoteIds = [...entry.company.quotes]
      .sort((left, right) => right.periodSortKey - left.periodSortKey)
      .slice(0, 3)
      .map((quote) => quote.quoteId);

    return {
      companyKey: entry.company.companyKey,
      subhead: `${entry.company.companyName}: management signal gets clearer`,
      narrativeAngle:
        chronologyMode === "timeline"
          ? "Explain how management framing evolved from older commentary to current positioning."
          : "Explain what this company reveals in the current period and why it matters versus peers.",
      chronologyMode,
      quoteIds,
    };
  });

  const selectedSet = new Set(sectionPlans.map((section) => section.companyKey));

  return {
    title: `Plotline: ${keywords.join(", ")}`,
    dek: `Management commentary across companies reveals how ${keywords.join(", ")} is shaping strategy and industry direction.`,
    sectionPlans,
    skippedCompanyKeys: companies
      .map((company) => company.companyKey)
      .filter((companyKey) => !selectedSet.has(companyKey)),
  };
};

const sanitizePlan = (plan: any, fallback: PlotlinePlanInput, companies: PlotlineCompanyInput[]): PlotlinePlanInput => {
  if (!plan || typeof plan !== "object") return fallback;

  const companyByKey = new Map(companies.map((company) => [company.companyKey, company]));
  const sections: PlotlinePlanSection[] = [];
  const seenKeys = new Set<string>();

  if (Array.isArray(plan.sectionPlans)) {
    for (const item of plan.sectionPlans) {
      if (!item || typeof item !== "object") continue;
      if (!hasNonEmptyString(item.companyKey)) continue;
      const companyKey = item.companyKey.trim();
      if (seenKeys.has(companyKey)) continue;
      const company = companyByKey.get(companyKey);
      if (!company) continue;

      const allowedQuoteIds = new Set(company.quotes.map((quote) => quote.quoteId));
      const quoteIds: string[] = Array.isArray(item.quoteIds)
        ? item.quoteIds
            .filter((quoteId: unknown): quoteId is string => hasNonEmptyString(quoteId))
            .map((quoteId) => quoteId.trim())
            .filter((quoteId) => allowedQuoteIds.has(quoteId))
        : [];
      const normalizedQuoteIds: string[] = Array.from(new Set<string>(quoteIds)).slice(0, 3);

      if (normalizedQuoteIds.length === 0) {
        normalizedQuoteIds.push(...company.quotes.slice(-3).map((quote) => quote.quoteId));
      }
      if (normalizedQuoteIds.length === 0) continue;

      const chronologyModeRaw = hasNonEmptyString(item.chronologyMode)
        ? item.chronologyMode.trim().toLowerCase()
        : "";

      sections.push({
        companyKey,
        subhead: hasNonEmptyString(item.subhead)
          ? sanitizeSentence(item.subhead, MAX_SUBHEAD_CHARS)
          : `${company.companyName}: management signal gets clearer`,
        narrativeAngle: hasNonEmptyString(item.narrativeAngle)
          ? sanitizeSentence(item.narrativeAngle, MAX_ANGLE_CHARS)
          : "Explain the strategic signal and investor implication from management evidence.",
        chronologyMode: chronologyModeRaw === "timeline" ? "timeline" : "same_period",
        quoteIds: normalizedQuoteIds,
      });

      seenKeys.add(companyKey);
    }
  }

  if (sections.length === 0) return fallback;

  const skipped = new Set<string>();
  if (Array.isArray(plan.skippedCompanyKeys)) {
    for (const item of plan.skippedCompanyKeys) {
      if (!hasNonEmptyString(item)) continue;
      const normalized = item.trim();
      if (companyByKey.has(normalized)) skipped.add(normalized);
    }
  }
  for (const company of companies) {
    if (!sections.some((section) => section.companyKey === company.companyKey)) {
      skipped.add(company.companyKey);
    }
  }

  return {
    title: hasNonEmptyString(plan.title) ? sanitizeSentence(plan.title, MAX_TITLE_CHARS) : fallback.title,
    dek: hasNonEmptyString(plan.dek) ? sanitizeSentence(plan.dek, MAX_DEK_CHARS) : fallback.dek,
    sectionPlans: sections,
    skippedCompanyKeys: Array.from(skipped),
  };
};

const fallbackParagraphsForSection = (
  section: PlotlinePlanSection,
  company: PlotlineCompanyInput,
  selectedQuotes: PlotlineQuoteInput[],
  keywords: string[],
): string[] => {
  const keywordText = keywords.slice(0, 2).join(" and ") || "the theme";
  const firstPeriod = selectedQuotes[0]?.periodLabel || company.quotes[0]?.periodLabel || "earlier commentary";
  const lastPeriod =
    selectedQuotes[selectedQuotes.length - 1]?.periodLabel ||
    company.quotes[company.quotes.length - 1]?.periodLabel ||
    "latest commentary";

  const p1 = `${company.companyName} management frames ${keywordText} as a strategic issue rather than a one-quarter talking point.`;
  const p2 =
    section.chronologyMode === "timeline" && firstPeriod !== lastPeriod
      ? `The progression from ${firstPeriod} to ${lastPeriod} shows the stance becoming more explicit and operational.`
      : `In the current period, commentary is specific enough to compare against peers and separate signal from routine updates.`;
  const p3 = `Taken together, the evidence points to durable implications for strategy, execution priorities, and medium-term expectations.`;

  return [p1, p2, p3].map((item) => sanitizeSentence(item, MAX_PARAGRAPH_CHARS));
};

const buildDeterministicStory = (
  keywords: string[],
  companies: PlotlineCompanyInput[],
  plan: PlotlinePlanInput,
): PlotlineStoryResult => {
  const companyByKey = new Map(companies.map((company) => [company.companyKey, company]));

  const sections: PlotlineStorySectionOutput[] = plan.sectionPlans
    .map((planSection) => {
      const company = companyByKey.get(planSection.companyKey);
      if (!company) return null;
      const quoteById = new Map(company.quotes.map((quote) => [quote.quoteId, quote]));
      const quoteBlocks = planSection.quoteIds
        .map((quoteId) => quoteById.get(quoteId))
        .filter((quote): quote is PlotlineQuoteInput => Boolean(quote))
        .slice(0, 3);

      const selectedQuotes = quoteBlocks.length > 0 ? quoteBlocks : company.quotes.slice(-3);
      if (selectedQuotes.length === 0) return null;

      return {
        companyKey: company.companyKey,
        companyName: company.companyName,
        subhead: sanitizeSentence(planSection.subhead, MAX_SUBHEAD_CHARS),
        narrativeParagraphs: fallbackParagraphsForSection(planSection, company, selectedQuotes, keywords),
        quoteBlocks: selectedQuotes,
      };
    })
    .filter((section): section is PlotlineStorySectionOutput => Boolean(section));

  const closingWatchlist = [
    `Watch whether management commentary keeps ${keywords[0] || "the theme"} tied to concrete operating actions, not broad statements.`,
    "Track if guidance language and capital allocation comments stay directionally consistent over coming quarters.",
    "Compare follow-through signals across companies to identify who is adapting faster and who is still in messaging mode.",
  ].map((line) => sanitizeSentence(line, 220));

  return {
    title: sanitizeSentence(plan.title, MAX_TITLE_CHARS),
    dek: sanitizeSentence(plan.dek, MAX_DEK_CHARS),
    sections,
    closingWatchlist,
    skippedCompanies: plan.skippedCompanyKeys,
  };
};

const normalizeParagraphs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item: unknown): item is string => hasNonEmptyString(item))
    .map((item) => sanitizeSentence(item, MAX_PARAGRAPH_CHARS))
    .filter((item) => item.length > 0)
    .slice(0, MAX_PARAGRAPHS_PER_SECTION);
};

const normalizeWatchlist = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return fallback.slice(0, MAX_WATCHLIST_LINES);
  const normalized: string[] = Array.from(
    new Set(
      value
        .filter((item: unknown): item is string => hasNonEmptyString(item))
        .map((item) => sanitizeSentence(item, 220))
        .filter((item) => item.length > 0),
    ) as Set<string>,
  ).slice(0, MAX_WATCHLIST_LINES);

  if (normalized.length >= MIN_WATCHLIST_LINES) return normalized;
  return fallback.slice(0, MAX_WATCHLIST_LINES);
};

const normalizeWriterOutput = (
  raw: any,
  keywords: string[],
  companies: PlotlineCompanyInput[],
  plan: PlotlinePlanInput,
): PlotlineStoryResult => {
  const fallbackStory = buildDeterministicStory(keywords, companies, plan);
  if (!raw || typeof raw !== "object") return fallbackStory;

  const companyByKey = new Map(companies.map((company) => [company.companyKey, company]));
  const planByCompanyKey = new Map(plan.sectionPlans.map((section) => [section.companyKey, section]));
  const sections: PlotlineStorySectionOutput[] = [];
  const seenCompanies = new Set<string>();

  if (Array.isArray(raw.sections)) {
    for (const item of raw.sections) {
      if (!item || typeof item !== "object") continue;
      if (!hasNonEmptyString(item.companyKey)) continue;
      const companyKey = item.companyKey.trim();
      if (seenCompanies.has(companyKey)) continue;

      const company = companyByKey.get(companyKey);
      const planSection = planByCompanyKey.get(companyKey);
      if (!company || !planSection) continue;

      const paragraphs = normalizeParagraphs(item.narrativeParagraphs);
      if (paragraphs.length === 0) continue;

      const quoteById = new Map(company.quotes.map((quote) => [quote.quoteId, quote]));
      const requestedQuoteIds: string[] = Array.isArray(item.quoteIds)
        ? item.quoteIds
            .filter((quoteId: unknown): quoteId is string => hasNonEmptyString(quoteId))
            .map((quoteId) => quoteId.trim())
        : [];

      const normalizedQuoteIds: string[] = Array.from(new Set<string>(requestedQuoteIds)).filter((quoteId) =>
        quoteById.has(quoteId),
      );
      const quoteIds =
        normalizedQuoteIds.length > 0
          ? normalizedQuoteIds.slice(0, 3)
          : planSection.quoteIds.filter((quoteId) => quoteById.has(quoteId)).slice(0, 3);

      const quoteBlocks = quoteIds
        .map((quoteId) => quoteById.get(quoteId))
        .filter((quote): quote is PlotlineQuoteInput => Boolean(quote));

      if (quoteBlocks.length === 0) continue;

      sections.push({
        companyKey,
        companyName: company.companyName,
        subhead: hasNonEmptyString(item.subhead)
          ? sanitizeSentence(item.subhead, MAX_SUBHEAD_CHARS)
          : sanitizeSentence(planSection.subhead, MAX_SUBHEAD_CHARS),
        narrativeParagraphs: paragraphs,
        quoteBlocks,
      });

      seenCompanies.add(companyKey);
    }
  }

  if (sections.length === 0) return fallbackStory;

  const fallbackWatchlist = fallbackStory.closingWatchlist;
  const closingWatchlist = normalizeWatchlist(raw.closingWatchlist, fallbackWatchlist);

  return {
    title: hasNonEmptyString(raw.title)
      ? sanitizeSentence(raw.title, MAX_TITLE_CHARS)
      : sanitizeSentence(plan.title, MAX_TITLE_CHARS),
    dek: hasNonEmptyString(raw.dek)
      ? sanitizeSentence(raw.dek, MAX_DEK_CHARS)
      : sanitizeSentence(plan.dek, MAX_DEK_CHARS),
    sections,
    closingWatchlist,
    skippedCompanies: plan.skippedCompanyKeys,
  };
};

const buildModelInput = (keywords: string[], companies: PlotlineCompanyInput[], plan: PlotlinePlanInput): string => {
  const compactCompanies = companies.map((company) => ({
    companyKey: company.companyKey,
    companyName: company.companyName,
    marketCapCategory: company.marketCapCategory,
    industry: company.industry,
    quotes: company.quotes.map((quote) => ({
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
    PLOTLINE_WRITE_PROMPT,
    "",
    "THEME KEYWORDS:",
    keywords.map((keyword) => `- ${keyword}`).join("\n"),
    "",
    "STORY PLAN (JSON):",
    JSON.stringify(plan),
    "",
    "COMPANY EVIDENCE (JSON):",
    JSON.stringify(compactCompanies),
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
      `Too many total quotes for story writing (${totalQuotes}, max ${MAX_TOTAL_QUOTES}).`,
      "TOO_MANY_QUOTES",
    );
  }

  const fallbackPlan = buildFallbackPlan(keywords, companies);
  const plan = sanitizePlan(body?.plan, fallbackPlan, companies);

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

  const fallbackStory = buildDeterministicStory(keywords, companies, plan);
  const geminiApiKey = env?.GEMINI_API_KEY;
  const openRouterApiKey = env?.OPENROUTER_API_KEY;
  const providerReady =
    (provider === PROVIDER_GEMINI && hasNonEmptyString(geminiApiKey)) ||
    (provider === PROVIDER_OPENROUTER && hasNonEmptyString(openRouterApiKey));

  if (!providerReady) {
    console.log(
      JSON.stringify({
        event: "plotline_write_fallback_no_key",
        requestId,
        provider,
      }),
    );
    return json(fallbackStory);
  }

  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;
  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);

  const inputText = buildModelInput(keywords, companies, plan);

  console.log(
    JSON.stringify({
      event: "plotline_write_start",
      requestId,
      provider,
      requestedModel: model,
      providerPreference,
      keywordCount: keywords.length,
      companyCount: companies.length,
      sectionsInPlan: plan.sectionPlans.length,
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
              responseSchema: PLOTLINE_WRITE_RESPONSE_SCHEMA,
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

      const story = normalizeWriterOutput(raw, keywords, companies, plan);

      console.log(
        JSON.stringify({
          event: "plotline_write_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          sections: story.sections.length,
          closingLines: story.closingWatchlist.length,
        }),
      );

      return json(story);
    } catch (err: any) {
      const message = String(err?.message || "Unknown story writing failure");
      console.log(
        JSON.stringify({
          event: "plotline_write_attempt_failed",
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
      event: "plotline_write_fallback_after_failures",
      requestId,
      provider,
      sections: fallbackStory.sections.length,
    }),
  );

  return json(fallbackStory);
}
