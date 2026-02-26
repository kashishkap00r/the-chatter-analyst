import {
  callGeminiJson,
  callOpenRouterJson,
  normalizeGeminiProviderPreference,
  PLOTLINE_EXTRACT_PROMPT,
  PLOTLINE_EXTRACT_RESPONSE_SCHEMA,
} from "../../_shared/gemini";
import { parseJsonBodyWithLimit } from "../../_shared/request";
import { error, json } from "../../_shared/response";
import {
  isAllowedProviderModel,
  parseProvider as parseProviderValue,
  resolveRequestedModel,
} from "../../_shared/providerModels";
import {
  extractRetryAfterSeconds,
  getPrimaryBackupAttemptOrder,
  getPrimarySecondaryTertiaryAttemptOrder,
  isLocationUnsupportedError,
  isSchemaConstraintError,
  isStructuredOutputError,
  isUpstreamRateLimit as isUpstreamRateLimitBase,
  isUpstreamTransientError as isUpstreamTransientErrorBase,
} from "../../_shared/retryPolicy";
import { hasNonEmptyString, isInteger } from "../../_shared/validation";

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

interface KeywordMatch {
  start: number;
  end: number;
  keyword: string;
}

interface MatchWindow {
  start: number;
  end: number;
  keywords: Set<string>;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 900000;
const MAX_HEADER_CHARS = 14000;
const MAX_NO_MATCH_FALLBACK_CHARS = 90000;
const MATCH_WINDOW_RADIUS = 600;
const MAX_MATCH_WINDOWS = 80;
const MAX_MATCH_SCAN_RESULTS = 450;
const MAX_FILTERED_TRANSCRIPT_CHARS = 220000;
const MAX_KEYWORDS = 20;
const MAX_QUOTES_COUNT = 120;
const MAX_CLEAN_QUOTE_CHARS = 1200;
const DEDUPE_STRONG_SIMILARITY = 0.88;
const DEDUPE_SAME_PERIOD_SIMILARITY = 0.72;
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

const MONTH_ABBREVIATIONS: Record<number, string> = {
  1: "Jan",
  2: "Feb",
  3: "Mar",
  4: "Apr",
  5: "May",
  6: "Jun",
  7: "Jul",
  8: "Aug",
  9: "Sep",
  10: "Oct",
  11: "Nov",
  12: "Dec",
};

const DEDUPE_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "been",
  "will",
  "would",
  "about",
  "there",
  "their",
  "into",
  "our",
  "your",
  "which",
  "while",
  "were",
  "are",
  "has",
  "had",
  "also",
  "just",
  "more",
  "than",
  "they",
  "them",
  "over",
  "some",
  "such",
]);

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

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildKeywordRegex = (keyword: KeywordEntry): RegExp => {
  const source = keyword.source.trim();
  const parts = source.split(/[\s\-_/+.]+/g).map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return new RegExp(escapeRegExp(source), "gi");
  }
  const pattern = parts.map((part) => escapeRegExp(part)).join("[\\s\\-_/+.]*");
  return new RegExp(pattern, "gi");
};

const sampleMatchWindows = (windows: MatchWindow[]): MatchWindow[] => {
  if (windows.length <= MAX_MATCH_WINDOWS) return windows;

  const selected: MatchWindow[] = [];
  const step = windows.length / MAX_MATCH_WINDOWS;
  for (let i = 0; i < MAX_MATCH_WINDOWS; i++) {
    const index = Math.min(windows.length - 1, Math.floor(i * step));
    selected.push(windows[index]);
  }
  return selected;
};

const buildFilteredTranscript = (
  transcript: string,
  keywords: KeywordEntry[],
): { filteredText: string; matchCount: number; windowCount: number } => {
  const allMatches: KeywordMatch[] = [];

  for (const keyword of keywords) {
    const regex = buildKeywordRegex(keyword);
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(transcript)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        keyword: keyword.source,
      });
      if (allMatches.length >= MAX_MATCH_SCAN_RESULTS) break;
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1;
      }
    }
    if (allMatches.length >= MAX_MATCH_SCAN_RESULTS) break;
  }

  const sortedMatches = allMatches.sort((left, right) => left.start - right.start);
  const windows: MatchWindow[] = [];
  for (const match of sortedMatches) {
    const windowStart = Math.max(0, match.start - MATCH_WINDOW_RADIUS);
    const windowEnd = Math.min(transcript.length, match.end + MATCH_WINDOW_RADIUS);
    const previous = windows[windows.length - 1];
    if (previous && windowStart <= previous.end + 120) {
      previous.end = Math.max(previous.end, windowEnd);
      previous.keywords.add(match.keyword);
    } else {
      windows.push({
        start: windowStart,
        end: windowEnd,
        keywords: new Set([match.keyword]),
      });
    }
  }

  const sampledWindows = sampleMatchWindows(windows);
  const headerText = transcript.slice(0, MAX_HEADER_CHARS);

  if (sampledWindows.length === 0) {
    const fallbackBody = transcript.slice(0, Math.min(MAX_TRANSCRIPT_CHARS, MAX_NO_MATCH_FALLBACK_CHARS));
    const filteredText = [
      "TRANSCRIPT HEADER (metadata context):",
      headerText,
      "",
      "NO EXPLICIT KEYWORD MATCH WINDOWS FOUND BY PRE-SCAN.",
      "Use transcript header for company metadata and return quotes as an empty array if no explicit keyword quote exists.",
      "",
      "TRANSCRIPT FALLBACK EXCERPT:",
      fallbackBody,
    ]
      .join("\n")
      .slice(0, MAX_FILTERED_TRANSCRIPT_CHARS);

    return {
      filteredText,
      matchCount: 0,
      windowCount: 0,
    };
  }

  const snippets = sampledWindows.map((window, index) => {
    const snippetText = transcript.slice(window.start, window.end);
    const keywordsLabel = Array.from(window.keywords).join(", ");
    return [
      `--- Snippet ${index + 1} | Chars ${window.start}-${window.end} | Keywords: ${keywordsLabel} ---`,
      snippetText,
    ].join("\n");
  });

  const filteredText = [
    "TRANSCRIPT HEADER (metadata context):",
    headerText,
    "",
    `KEYWORD MATCH WINDOWS: ${sampledWindows.length} snippet(s), ${sortedMatches.length} total raw match(es).`,
    "",
    ...snippets,
  ]
    .join("\n")
    .slice(0, MAX_FILTERED_TRANSCRIPT_CHARS);

  return {
    filteredText,
    matchCount: sortedMatches.length,
    windowCount: sampledWindows.length,
  };
};

const parseProvider = (value: unknown): ReturnType<typeof parseProviderValue> =>
  parseProviderValue(value, DEFAULT_PROVIDER);

const getModelAttemptOrder = (requestedModel: string): string[] =>
  getPrimarySecondaryTertiaryAttemptOrder(requestedModel, FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL);

const getOpenRouterAttemptOrder = (requestedModel: string): string[] =>
  getPrimaryBackupAttemptOrder(requestedModel, OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL);

const isUpstreamRateLimit = (message: string): boolean =>
  isUpstreamRateLimitBase(message, { includeFreeTierRateLimitToken: true });

const isUpstreamTransientError = (message: string): boolean =>
  isUpstreamTransientErrorBase(message, { includeStatusCode524: true });

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

const formatPeriodLabelFromSortKey = (periodSortKey: number): string => {
  const year = Math.floor(periodSortKey / 100);
  const month = periodSortKey % 100;
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return "Unknown Period";
  }
  const monthLabel = MONTH_ABBREVIATIONS[month];
  if (!monthLabel) {
    return "Unknown Period";
  }
  return `${monthLabel}'${String(year % 100).padStart(2, "0")}`;
};

const normalizeQuoteText = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim()
    .slice(0, MAX_CLEAN_QUOTE_CHARS);

const splitTranscriptSentences = (transcript: string): string[] =>
  transcript
    .replace(/---\s*page\s+\d+\s*---/gi, " ")
    .replace(/\r/g, " ")
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 20);

const toTokenSet = (value: string): Set<string> => {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .filter((token) => token.length >= 3 && !DEDUPE_STOP_WORDS.has(token));
  return new Set(tokens);
};

const jaccardSimilarity = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  const union = left.size + right.size - overlap;
  return union > 0 ? overlap / union : 0;
};

const findBestSentenceIndex = (quote: string, transcriptSentences: string[], matchedKeywords: string[]): number => {
  if (transcriptSentences.length === 0) return -1;

  const normalizedQuote = normalizeQuoteText(quote).toLowerCase();
  const quotePrefix = normalizedQuote.split(/\s+/g).slice(0, 8).join(" ").trim();
  const quoteTokens = toTokenSet(quote);
  const keywordTokens = new Set(matchedKeywords.map((keyword) => normalizeToken(keyword)));

  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < transcriptSentences.length; index++) {
    const sentence = transcriptSentences[index];
    const lowerSentence = sentence.toLowerCase();

    let score = 0;
    if (quotePrefix && lowerSentence.includes(quotePrefix)) {
      score += 0.55;
    }
    if (normalizedQuote && (normalizedQuote.includes(lowerSentence) || lowerSentence.includes(normalizedQuote))) {
      score += 0.45;
    }

    const sentenceTokens = toTokenSet(sentence);
    score += jaccardSimilarity(quoteTokens, sentenceTokens) * 0.9;

    const normalizedSentence = normalizeToken(sentence);
    for (const keywordToken of keywordTokens) {
      if (keywordToken && normalizedSentence.includes(keywordToken)) {
        score += 0.1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore >= 0.35 ? bestIndex : -1;
};

const expandQuoteContext = (quote: string, transcript: string, matchedKeywords: string[]): string => {
  const cleanedQuote = normalizeQuoteText(quote);
  if (!cleanedQuote) return cleanedQuote;

  const transcriptSentences = splitTranscriptSentences(transcript);
  if (transcriptSentences.length === 0) return cleanedQuote;

  const sentenceIndex = findBestSentenceIndex(cleanedQuote, transcriptSentences, matchedKeywords);
  if (sentenceIndex < 0) return cleanedQuote;

  const startIndex = Math.max(0, sentenceIndex - 1);
  const endIndex = Math.min(transcriptSentences.length - 1, sentenceIndex + 1);
  const excerpt = normalizeQuoteText(transcriptSentences.slice(startIndex, endIndex + 1).join(" "));

  if (!excerpt) return cleanedQuote;
  return excerpt.length > cleanedQuote.length ? excerpt : cleanedQuote;
};

const hasKeywordOverlap = (left: string[], right: string[]): boolean => {
  const rightSet = new Set(right.map((keyword) => normalizeToken(keyword)));
  return left.some((keyword) => rightSet.has(normalizeToken(keyword)));
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

const sanitizeQuotes = (rawQuotes: any[], keywords: KeywordEntry[], fiscalPeriod: string, transcript: string): any[] => {
  const preliminaryQuotes: any[] = [];

  for (const rawQuote of rawQuotes) {
    if (!rawQuote || typeof rawQuote !== "object") continue;
    if (!hasNonEmptyString(rawQuote.quote)) continue;

    const rawQuoteText = normalizeQuoteText(rawQuote.quote);
    if (!rawQuoteText) continue;

    const matchedKeywords = sanitizeMatchedKeywords(rawQuote.matchedKeywords, keywords, rawQuoteText);
    if (matchedKeywords.length === 0) continue;

    const expandedQuote = expandQuoteContext(rawQuoteText, transcript, matchedKeywords);
    const quote = normalizeQuoteText(expandedQuote);
    if (!quote) continue;

    const speakerName = hasNonEmptyString(rawQuote.speakerName) ? rawQuote.speakerName.trim() : "Management";
    const speakerDesignation = hasNonEmptyString(rawQuote.speakerDesignation)
      ? rawQuote.speakerDesignation.trim()
      : "Company Management";
    const rawPeriodLabel = hasNonEmptyString(rawQuote.periodLabel) ? rawQuote.periodLabel.trim() : fiscalPeriod;
    const periodSortKey =
      isInteger(rawQuote.periodSortKey) && rawQuote.periodSortKey >= 190001 && rawQuote.periodSortKey <= 210012
        ? rawQuote.periodSortKey
        : inferPeriodSortKey(rawPeriodLabel, fiscalPeriod);
    const periodLabel = formatPeriodLabelFromSortKey(periodSortKey);

    preliminaryQuotes.push({
      quote,
      speakerName,
      speakerDesignation,
      matchedKeywords,
      periodLabel,
      periodSortKey,
    });
  }

  const byPriority = preliminaryQuotes.sort((left, right) => {
    if (left.periodSortKey !== right.periodSortKey) {
      return left.periodSortKey - right.periodSortKey;
    }
    return right.quote.length - left.quote.length;
  });

  const deduped: any[] = [];
  for (const candidate of byPriority) {
    const candidateTokens = toTokenSet(candidate.quote);
    let isDuplicate = false;

    for (const existing of deduped) {
      const exactDuplicate =
        candidate.quote.toLowerCase() === existing.quote.toLowerCase() &&
        candidate.speakerName.toLowerCase() === existing.speakerName.toLowerCase();
      if (exactDuplicate) {
        isDuplicate = true;
        break;
      }

      const similarity = jaccardSimilarity(candidateTokens, toTokenSet(existing.quote));
      if (similarity >= DEDUPE_STRONG_SIMILARITY) {
        isDuplicate = true;
        break;
      }

      const samePeriod = candidate.periodSortKey === existing.periodSortKey;
      if (samePeriod && hasKeywordOverlap(candidate.matchedKeywords, existing.matchedKeywords)) {
        if (similarity >= DEDUPE_SAME_PERIOD_SIMILARITY) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (!isDuplicate) {
      deduped.push(candidate);
    }
  }

  return deduped.sort((left, right) => {
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

  const parsedBody = await parseJsonBodyWithLimit<any>(request, MAX_BODY_BYTES);
  if (parsedBody.ok === false) {
    return parsedBody.reason === "BODY_TOO_LARGE"
      ? error(413, "BAD_REQUEST", "Request body is too large.", "BODY_TOO_LARGE")
      : error(400, "BAD_REQUEST", "Request body must be valid JSON.", "INVALID_JSON");
  }
  const body = parsedBody.body;

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

  const model = resolveRequestedModel(body?.model, provider, {
    gemini: DEFAULT_MODEL,
    openrouter: OPENROUTER_PRIMARY_MODEL,
  });

  if (!isAllowedProviderModel(provider, model, { gemini: ALLOWED_MODELS, openrouter: OPENROUTER_ALLOWED_MODELS })) {
    return provider === PROVIDER_GEMINI
      ? error(400, "BAD_REQUEST", "Field 'model' is invalid for provider 'gemini'.", "INVALID_MODEL")
      : error(400, "BAD_REQUEST", "Field 'model' is invalid for provider 'openrouter'.", "INVALID_MODEL");
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

  const filteredTranscript = buildFilteredTranscript(
    transcript.substring(0, MAX_TRANSCRIPT_CHARS),
    keywords,
  );
  const keywordBlock = keywords.map((keyword) => `- ${keyword.source}`).join("\n");
  const inputText = [
    PLOTLINE_EXTRACT_PROMPT,
    "",
    "TARGET KEYWORDS:",
    keywordBlock,
    "",
    "INPUT TRANSCRIPT EXCERPTS:",
    filteredTranscript.filteredText,
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
      filteredTranscriptChars: filteredTranscript.filteredText.length,
      prescanKeywordMatches: filteredTranscript.matchCount,
      prescanWindowCount: filteredTranscript.windowCount,
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

      result.quotes = sanitizeQuotes(
        Array.isArray(result.quotes) ? result.quotes : [],
        keywords,
        result.fiscalPeriod,
        transcript.substring(0, MAX_TRANSCRIPT_CHARS),
      );

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
