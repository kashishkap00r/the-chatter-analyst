import {
  callGeminiJson,
  callOpenRouterJson,
  POINTS_PROMPT,
  POINTS_RESPONSE_SCHEMA,
  normalizeGeminiProviderPreference,
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
  isImageProcessingError,
  isLocationUnsupportedError,
  isOverloadError,
  isSchemaConstraintError,
  isStructuredOutputError,
  isTimeoutError,
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

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_TOTAL_IMAGE_CHARS = 20 * 1024 * 1024;
const PROVIDER_GEMINI = "gemini";
const PROVIDER_OPENROUTER = "openrouter";
const DEFAULT_PROVIDER = PROVIDER_GEMINI;
const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_3_MODEL = "gemini-3-flash-preview";
const PRO_MODEL = "gemini-3-pro-preview";
const OPENROUTER_PRIMARY_MODEL = "qwen/qwen2.5-vl-32b-instruct";
const OPENROUTER_BACKUP_MODEL = "minimax/minimax-01";
const DEFAULT_MODEL = FLASH_3_MODEL;
const ALLOWED_MODELS = new Set([FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL]);
const OPENROUTER_ALLOWED_MODELS = new Set([OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL]);
const IS_STRICT_VALIDATION: boolean = false;
const UPSTREAM_DEPENDENCY_STATUS = 424;
const VALIDATION_STATUS = 422;
const MAX_SELECTED_SLIDES = 10;
const MAX_CONTEXT_SENTENCES = 2;
const MAX_CONTEXT_CHARACTERS = 420;
const MAX_CONTEXT_REWRITE_CANDIDATES = 6;
const MIN_REVIEW_CONFIDENCE = 0.58;
const HIGH_CONFIDENCE_DROP_THRESHOLD = 0.78;

const POINTS_CONTEXT_REWRITE_SCHEMA = {
  type: "OBJECT",
  properties: {
    rewrites: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          selectedPageNumber: { type: "INTEGER" },
          context: { type: "STRING" },
        },
        required: ["selectedPageNumber", "context"],
      },
    },
  },
  required: ["rewrites"],
};

const POINTS_SLIDE_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    reviews: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          selectedPageNumber: { type: "INTEGER" },
          status: { type: "STRING" },
          reasonCode: { type: "STRING" },
          confidence: { type: "NUMBER" },
          context: { type: "STRING" },
        },
        required: ["selectedPageNumber", "status", "reasonCode", "confidence", "context"],
      },
    },
  },
  required: ["reviews"],
};

interface ChunkRange {
  startPage: number;
  endPage: number;
}

interface PointsValidationResult {
  error: string | null;
  normalizedPageCount: number;
}

const parseProvider = (value: unknown): ReturnType<typeof parseProviderValue> =>
  parseProviderValue(value, DEFAULT_PROVIDER);

const getModelAttemptOrder = (requestedModel: string): string[] =>
  getPrimarySecondaryTertiaryAttemptOrder(requestedModel, FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL);

const getOpenRouterAttemptOrder = (requestedModel: string): string[] =>
  getPrimaryBackupAttemptOrder(requestedModel, OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL);

const isUpstreamRateLimit = (message: string): boolean =>
  isUpstreamRateLimitBase(message, { includeFreeTierRateLimitToken: true });

const isUpstreamTransientError = (message: string): boolean => isUpstreamTransientErrorBase(message);

const disallowedContextStart = /^(in this slide|this slide shows|the slide shows)\b/i;

const sanitizeContext = (value: string): string => {
  let normalized = value.trim();
  normalized = normalized.replace(/^(in this slide|this slide shows|the slide shows)\s*[:,-]?\s*/i, "");
  if (normalized && normalized[0] === normalized[0].toLowerCase()) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized;
};

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "there",
  "their",
  "which",
  "while",
  "have",
  "has",
  "were",
  "been",
  "being",
  "into",
  "about",
  "across",
  "under",
  "after",
  "before",
  "where",
  "what",
  "when",
  "over",
  "only",
  "also",
  "than",
  "then",
  "because",
  "would",
  "could",
  "should",
  "company",
  "business",
  "shows",
  "slide",
  "table",
  "chart",
  "graph",
]);

const DESCRIPTIVE_TERMS = [
  "this slide",
  "the slide",
  "chart shows",
  "table shows",
  "graph shows",
  "illustrates",
  "depicts",
  "presents",
  "breakup",
  "composition",
  "distribution",
  "lists",
  "highlights",
];

const INFERENCE_TERMS = [
  "because",
  "driven by",
  "reflects",
  "implies",
  "suggests",
  "indicates",
  "points to",
  "signals",
  "underscores",
  "therefore",
  "as a result",
  "which means",
  "hinting",
  "read-through",
  "read through",
  "sets up",
];

const NOVELTY_TERMS = [
  "new",
  "first",
  "pivot",
  "shift",
  "inflection",
  "structural",
  "turning point",
  "mix shift",
  "mix upgrade",
  "repricing",
  "consolidation",
  "acquisition",
  "divestment",
  "capacity addition",
  "utilization",
  "pricing power",
  "runway",
  "transition",
  "reposition",
  "emerging",
];

const ROUTINE_TERMS = [
  "yoy",
  "qoq",
  "quarter",
  "revenue",
  "ebitda",
  "pat",
  "profit",
  "gross margin",
  "operating margin",
  "growth",
  "guidance",
];

const FINANCIAL_TERMS = [
  "revenue",
  "ebitda",
  "pat",
  "profit",
  "margin",
  "operating leverage",
  "nim",
  "roa",
  "roe",
  "credit cost",
  "cost to income",
  "gnpa",
  "nnpa",
  "volume",
];

const JARGON_TERMS = [
  "operating leverage",
  "normalized",
  "normalization",
  "structural",
  "trajectory",
  "calibrated",
  "prudential",
  "asymmetric",
  "inflection",
  "dislocation",
  "accretive",
  "deleveraging",
  "adjacency",
  "granularity",
  "read-through",
  "read through",
];

const MARKETING_TERMS = [
  "award",
  "awards",
  "recognition",
  "esg",
  "csr",
  "sustainability",
  "vision",
  "mission",
  "values",
  "brand campaign",
  "customer delight",
  "customer centric",
  "employee engagement",
  "great place to work",
  "stakeholder",
  "transformation journey",
  "digital journey",
  "purpose",
  "leadership position",
  "industry leading",
];

interface SlideEntry {
  selectedPageNumber: number;
  context: string;
}

interface ContextRewriteCandidate {
  selectedPageNumber: number;
  context: string;
  reason: string;
  qualityScore: number;
}

interface ContextRewriteResult {
  rewrites: Array<{
    selectedPageNumber: number;
    context: string;
  }>;
}

interface SlideReviewEntry {
  selectedPageNumber: number;
  status: "keep" | "drop";
  reasonCode: string;
  confidence: number;
  context: string;
}

interface SlideReviewPayload {
  reviews: SlideReviewEntry[];
}

interface SlideReviewOutcome {
  slides: SlideEntry[];
  reviewedCount: number;
  droppedCount: number;
  mismatchDropped: number;
  marketingDropped: number;
  weakSignalDropped: number;
}

const splitSentences = (value: string): string[] =>
  value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

const countTermHits = (lowerText: string, terms: string[]): number =>
  terms.reduce((total, term) => total + (lowerText.includes(term) ? 1 : 0), 0);

const ensureSentenceEnding = (value: string): string => {
  if (!value) return value;
  return /[.!?]$/.test(value) ? value : `${value}.`;
};

const clampContextLength = (value: string): string => {
  const sentences = splitSentences(value);
  if (sentences.length === 0) return value;
  const chosen = sentences.slice(0, MAX_CONTEXT_SENTENCES).map(ensureSentenceEnding).join(" ");
  if (chosen.length <= MAX_CONTEXT_CHARACTERS) {
    return chosen;
  }
  return `${chosen.slice(0, MAX_CONTEXT_CHARACTERS - 1).trimEnd()}…`;
};

const containsFinancialLanguage = (value: string): boolean => {
  const lower = value.toLowerCase();
  return countTermHits(lower, FINANCIAL_TERMS) > 0;
};

const hasNumericEvidence = (value: string): boolean =>
  /(?:\d+[%x]?|bps|crore|lakh|million|billion|mn|bn|mt|gw|units?)/i.test(value);

const isLikelyMarketingContext = (value: string): boolean => {
  const lower = value.toLowerCase();
  const marketingHits = countTermHits(lower, MARKETING_TERMS);
  const inferenceHits = countTermHits(lower, INFERENCE_TERMS);
  const noveltyHits = countTermHits(lower, NOVELTY_TERMS);
  return marketingHits >= 2 && inferenceHits === 0 && noveltyHits === 0 && !hasNumericEvidence(value);
};

const contextNeedsRewrite = (value: string): { needsRewrite: boolean; reason: string } => {
  const lower = value.toLowerCase();
  const descriptiveHits = countTermHits(lower, DESCRIPTIVE_TERMS);
  const inferenceHits = countTermHits(lower, INFERENCE_TERMS);
  const financialHits = countTermHits(lower, FINANCIAL_TERMS);
  const jargonHits = countTermHits(lower, JARGON_TERMS);
  const sentenceCount = splitSentences(value).length;
  const wordCount = value.trim().split(/\s+/).filter(Boolean).length;
  const avgWordsPerSentence = sentenceCount > 0 ? wordCount / sentenceCount : wordCount;
  const longWordCount = (value.match(/\b[a-z]{14,}\b/gi) || []).length;
  const startsDescriptive = /^(this|the)\s+(slide|chart|table|graph)\b/i.test(value.trim());

  if (startsDescriptive || (descriptiveHits >= 2 && inferenceHits === 0)) {
    return { needsRewrite: true, reason: "descriptive_only" };
  }

  if (sentenceCount > MAX_CONTEXT_SENTENCES + 1 || value.length > MAX_CONTEXT_CHARACTERS) {
    return { needsRewrite: true, reason: "too_verbose" };
  }

  if (financialHits > 0 && inferenceHits === 0) {
    return { needsRewrite: true, reason: "financial_without_why" };
  }

  if (jargonHits >= 2 || longWordCount >= 2 || avgWordsPerSentence > 24) {
    return { needsRewrite: true, reason: "jargon_dense" };
  }

  return { needsRewrite: false, reason: "ok" };
};

const scoreContextQuality = (value: string): number => {
  const lower = value.toLowerCase();
  const inferenceHits = countTermHits(lower, INFERENCE_TERMS);
  const noveltyHits = countTermHits(lower, NOVELTY_TERMS);
  const descriptiveHits = countTermHits(lower, DESCRIPTIVE_TERMS);
  const routineHits = countTermHits(lower, ROUTINE_TERMS);
  const marketingHits = countTermHits(lower, MARKETING_TERMS);
  const sentencePenalty = Math.max(0, splitSentences(value).length - MAX_CONTEXT_SENTENCES);
  const financialPenalty = containsFinancialLanguage(value) && inferenceHits === 0 ? 2 : 0;
  const marketingPenalty = isLikelyMarketingContext(value) ? 3 : Math.min(2, marketingHits);

  return (
    inferenceHits * 3 +
    noveltyHits * 2 -
    descriptiveHits * 2 -
    routineHits -
    marketingPenalty -
    sentencePenalty -
    financialPenalty
  );
};

const toTokenSet = (value: string): Set<string> => {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));

  return new Set(tokens);
};

const jaccardSimilarity = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const areContextsNearDuplicate = (left: string, right: string): boolean => {
  const leftSet = toTokenSet(left);
  const rightSet = toTokenSet(right);
  return jaccardSimilarity(leftSet, rightSet) >= 0.68;
};

const buildRewritePrompt = (
  candidates: ContextRewriteCandidate[],
  companyName: string,
  industry: string,
): string => {
  const payload = candidates.map((item) => ({
    selectedPageNumber: item.selectedPageNumber,
    context: item.context,
    rewriteReason: item.reason,
  }));

  return [
    "You are rewriting slide context for a smart non-specialist reader who wants sharp investor insight.",
    `Company: ${companyName || "Unknown"}`,
    `Industry: ${industry || "Unknown"}`,
    "",
    "Rewrite each context to be insight-first, concise, and not descriptive.",
    "Rules:",
    "- Keep each context to exactly 2 short sentences where possible.",
    "- Sentence 1: hidden signal, likely driver, or read-between-the-lines interpretation.",
    "- Sentence 2: investor implication (durability, risk, margins, strategy, or industry structure).",
    "- Use plain English and direct wording.",
    "- Keep sentence length compact (roughly <= 22 words where possible).",
    "- Limit jargon; use common finance words only when they add precision.",
    "- Avoid abstract phrasing and stacked qualifiers.",
    "- Do not narrate obvious visuals from the slide.",
    "- If context is financial/result oriented, clearly explain why it matters now beyond headline numbers.",
    "",
    "Return JSON only with: { \"rewrites\": [{ \"selectedPageNumber\": number, \"context\": string }] }",
    "Return one rewrite for each input selectedPageNumber.",
    "",
    `INPUT: ${JSON.stringify(payload)}`,
  ].join("\n");
};

const normalizeRewritePayload = (value: any): ContextRewriteResult => {
  if (!value || typeof value !== "object" || !Array.isArray(value.rewrites)) {
    return { rewrites: [] };
  }

  const rewrites = value.rewrites
    .filter((item: any) => item && Number.isInteger(item.selectedPageNumber) && hasNonEmptyString(item.context))
    .map((item: any) => ({
      selectedPageNumber: Number(item.selectedPageNumber),
      context: sanitizeContext(clampContextLength(item.context)),
    }));

  return { rewrites };
};

const normalizeSlideReviewPayload = (value: any): SlideReviewPayload => {
  if (!value || typeof value !== "object" || !Array.isArray(value.reviews)) {
    return { reviews: [] };
  }

  const reviews = value.reviews
    .filter((item: any) => item && Number.isInteger(item.selectedPageNumber))
    .map((item: any) => {
      const normalizedStatus = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
      const normalizedReason = typeof item.reasonCode === "string" ? item.reasonCode.trim().toLowerCase() : "ok";
      const parsedConfidence = Number(item.confidence);
      const confidence =
        Number.isFinite(parsedConfidence) && parsedConfidence >= 0
          ? Math.min(1, Math.max(0, parsedConfidence))
          : 0.5;
      const context = hasNonEmptyString(item.context) ? sanitizeContext(clampContextLength(item.context)) : "";

      return {
        selectedPageNumber: Number(item.selectedPageNumber),
        status: normalizedStatus === "drop" ? "drop" : "keep",
        reasonCode: normalizedReason || "ok",
        confidence,
        context,
      } as SlideReviewEntry;
    });

  return { reviews };
};

const applyMarketingPrefilter = (slides: SlideEntry[]): { slides: SlideEntry[]; droppedCount: number } => {
  if (slides.length === 0) return { slides, droppedCount: 0 };

  const marketingSlides = slides.filter((slide) => isLikelyMarketingContext(slide.context));
  if (marketingSlides.length === 0) {
    return { slides, droppedCount: 0 };
  }

  const keptSlides = slides.filter((slide) => !isLikelyMarketingContext(slide.context));
  if (keptSlides.length >= Math.min(3, slides.length)) {
    return {
      slides: keptSlides,
      droppedCount: marketingSlides.length,
    };
  }

  return { slides, droppedCount: 0 };
};

const buildSlideReviewPrompt = (
  slides: SlideEntry[],
  companyName: string,
  industry: string,
): string => {
  const payload = slides.map((slide, index) => ({
    selectedPageNumber: slide.selectedPageNumber,
    currentContext: slide.context,
    imageRef: `image_${index + 1}`,
  }));

  return [
    "You are reviewing candidate slide insights for quality control.",
    `Company: ${companyName || "Unknown"}`,
    `Industry: ${industry || "Unknown"}`,
    "",
    "You will receive one image per candidate in the same order as INPUT imageRef values.",
    "For each candidate, decide if context is truly matched to that exact slide and has real investor signal.",
    "",
    "KEEP only if all are true:",
    "- Context clearly belongs to that exact slide (not another slide).",
    "- Context explains why the slide matters, not just what is visible.",
    "- Insight is not generic corporate marketing language.",
    "",
    "DROP when any are true:",
    "- Context does not match slide evidence (mismatch/wrong slide).",
    "- Slide is mostly branding, awards, ESG PR, slogans, or other promotional material with weak analytical signal.",
    "- Context is too generic to justify inclusion.",
    "",
    "If keeping, rewrite context into plain-English, insight-first, max 2 short sentences.",
    "Do not narrate obvious visuals. Keep direct and specific.",
    "",
    "Return JSON only:",
    "{",
    '  "reviews": [',
    '    {"selectedPageNumber": 1, "status": "keep|drop", "reasonCode": "ok|mismatch|marketing|weak_signal", "confidence": 0.0-1.0, "context": "string"}',
    "  ]",
    "}",
    "",
    `INPUT: ${JSON.stringify(payload)}`,
  ].join("\n");
};

const selectBestSlides = (slides: SlideEntry[]): SlideEntry[] => {
  const dedupByPage = new Map<number, SlideEntry>();
  for (const slide of slides) {
    const existing = dedupByPage.get(slide.selectedPageNumber);
    if (!existing) {
      dedupByPage.set(slide.selectedPageNumber, slide);
      continue;
    }
    if (scoreContextQuality(slide.context) > scoreContextQuality(existing.context)) {
      dedupByPage.set(slide.selectedPageNumber, slide);
    }
  }

  const scored = Array.from(dedupByPage.values()).map((slide, index) => ({
    slide,
    index,
    score: scoreContextQuality(slide.context),
  }));

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.slide.selectedPageNumber - right.slide.selectedPageNumber;
  });

  const selected: Array<{ slide: SlideEntry; score: number }> = [];
  for (const candidate of scored) {
    if (selected.some((entry) => areContextsNearDuplicate(entry.slide.context, candidate.slide.context))) {
      continue;
    }
    selected.push({ slide: candidate.slide, score: candidate.score });
    if (selected.length >= MAX_SELECTED_SLIDES) {
      break;
    }
  }

  if (selected.length < Math.min(MAX_SELECTED_SLIDES, scored.length)) {
    for (const candidate of scored) {
      if (selected.some((entry) => entry.slide.selectedPageNumber === candidate.slide.selectedPageNumber)) {
        continue;
      }
      selected.push({ slide: candidate.slide, score: candidate.score });
      if (selected.length >= MAX_SELECTED_SLIDES) {
        break;
      }
    }
  }

  return selected
    .map((entry) => entry.slide)
    .sort((left, right) => left.selectedPageNumber - right.selectedPageNumber);
};

const parseChunkRange = (
  rawStartPage: unknown,
  rawEndPage: unknown,
  chunkPageCount: number,
): { chunkRange: ChunkRange | null; errorMessage?: string } => {
  const hasStart = rawStartPage !== undefined;
  const hasEnd = rawEndPage !== undefined;

  if (!hasStart && !hasEnd) {
    return { chunkRange: null };
  }

  if (!hasStart || !hasEnd || !isInteger(rawStartPage) || !isInteger(rawEndPage)) {
    return {
      chunkRange: null,
      errorMessage: "Fields 'chunkStartPage' and 'chunkEndPage' must be integer values when provided.",
    };
  }

  const startPage = rawStartPage;
  const endPage = rawEndPage;
  if (startPage < 1 || endPage < startPage) {
    return {
      chunkRange: null,
      errorMessage: "Fields 'chunkStartPage' and 'chunkEndPage' define an invalid range.",
    };
  }

  const expectedChunkLength = endPage - startPage + 1;
  if (expectedChunkLength !== chunkPageCount) {
    return {
      chunkRange: null,
      errorMessage:
        `Chunk range length (${expectedChunkLength}) does not match pageImages length (${chunkPageCount}).`,
    };
  }

  return {
    chunkRange: { startPage, endPage },
  };
};

const buildPointsPrompt = (chunkPageCount: number, chunkRange: ChunkRange | null): string => {
  const chunkGuidance =
    chunkRange === null
      ? [
          "REQUEST PAGE WINDOW",
          `- You are seeing a page chunk in this request with exactly ${chunkPageCount} images.`,
          `- selectedPageNumber MUST be local to this chunk: 1 to ${chunkPageCount}.`,
          `- Return no more than ${MAX_SELECTED_SLIDES} slides in this response.`,
        ]
      : [
          "REQUEST PAGE WINDOW",
          `- You are seeing only a chunk of the full deck: absolute pages ${chunkRange.startPage}-${chunkRange.endPage}.`,
          `- selectedPageNumber MUST be local to this chunk: 1 to ${chunkPageCount} (not absolute deck page).`,
          `- Mapping: local page 1 = absolute page ${chunkRange.startPage}; local page ${chunkPageCount} = absolute page ${chunkRange.endPage}.`,
          `- Return no more than ${MAX_SELECTED_SLIDES} slides in this response.`,
        ];

  return `${POINTS_PROMPT}\n\n${chunkGuidance.join("\n")}`;
};

const normalizeSelectedPageNumber = (
  selectedPageNumber: number,
  maxChunkPageCount: number,
  chunkRange: ChunkRange | null,
): { value: number; normalized: boolean } | null => {
  if (selectedPageNumber >= 1 && selectedPageNumber <= maxChunkPageCount) {
    return { value: selectedPageNumber, normalized: false };
  }

  if (chunkRange && selectedPageNumber >= chunkRange.startPage && selectedPageNumber <= chunkRange.endPage) {
    const localPage = selectedPageNumber - chunkRange.startPage + 1;
    if (localPage >= 1 && localPage <= maxChunkPageCount) {
      return { value: localPage, normalized: true };
    }
  }

  return null;
};

const validatePointsResult = (
  result: any,
  maxPageCount: number,
  chunkRange: ChunkRange | null,
): PointsValidationResult => {
  if (!result || typeof result !== "object") {
    return { error: "Gemini response is not a JSON object.", normalizedPageCount: 0 };
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
      return { error: `Missing or invalid field '${field}'.`, normalizedPageCount: 0 };
    }
  }

  if (!Array.isArray(result.slides) || result.slides.length === 0) {
    return { error: "Field 'slides' must contain at least 1 item.", normalizedPageCount: 0 };
  }

  let normalizedPageCount = 0;

  for (let i = 0; i < result.slides.length; i++) {
    const slide = result.slides[i];
    const slideIndex = i + 1;
    if (!slide || typeof slide !== "object") {
      return { error: `Slide #${slideIndex} is invalid.`, normalizedPageCount };
    }

    if (!Number.isInteger(slide.selectedPageNumber)) {
      return { error: `Slide #${slideIndex} has an invalid 'selectedPageNumber'.`, normalizedPageCount };
    }

    const normalizedPage = normalizeSelectedPageNumber(slide.selectedPageNumber, maxPageCount, chunkRange);
    if (!normalizedPage) {
      const rangeHint =
        chunkRange === null
          ? `Expected local page number in range 1-${maxPageCount}.`
          : `Expected local page number in range 1-${maxPageCount} for this chunk (absolute ${chunkRange.startPage}-${chunkRange.endPage}).`;
      return {
        error: `Slide #${slideIndex} page number ${slide.selectedPageNumber} is out of range. ${rangeHint}`,
        normalizedPageCount,
      };
    }
    if (normalizedPage.normalized) {
      normalizedPageCount += 1;
    }
    slide.selectedPageNumber = normalizedPage.value;

    if (!hasNonEmptyString(slide.context)) {
      return { error: `Slide #${slideIndex} is missing 'context'.`, normalizedPageCount };
    }

    const normalizedContext = sanitizeContext(slide.context);
    if (!normalizedContext) {
      return { error: `Slide #${slideIndex} has empty context after normalization.`, normalizedPageCount };
    }

    if (IS_STRICT_VALIDATION) {
      if (disallowedContextStart.test(slide.context.trim())) {
        return { error: `Slide #${slideIndex} context must not start with generic narration.`, normalizedPageCount };
      }
      if (normalizedContext.length < 80) {
        return { error: `Slide #${slideIndex} context is too short for an insight-led explanation.`, normalizedPageCount };
      }
    }

    slide.context = normalizedContext;
  }

  return { error: null, normalizedPageCount };
};

const extractBase64 = (dataUri: string): string => {
  const commaIndex = dataUri.indexOf(",");
  if (commaIndex >= 0) {
    return dataUri.slice(commaIndex + 1);
  }
  return dataUri;
};

const extractMimeType = (dataUri: string): string => {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUri.trim());
  if (match && hasNonEmptyString(match[1])) {
    return match[1].trim();
  }
  return "image/jpeg";
};

const applySlideReviewIfNeeded = async (params: {
  provider: string;
  requestId: string;
  model: string;
  providerPreference?: ReturnType<typeof normalizeGeminiProviderPreference>;
  geminiApiKey?: string;
  vertexApiKey?: string;
  openRouterApiKey?: string;
  openRouterSiteUrl?: string;
  openRouterAppTitle?: string;
  companyName: string;
  industry: string;
  slides: SlideEntry[];
  pageImages: string[];
}): Promise<SlideReviewOutcome> => {
  const {
    provider,
    requestId,
    model,
    providerPreference,
    geminiApiKey,
    vertexApiKey,
    openRouterApiKey,
    openRouterSiteUrl,
    openRouterAppTitle,
    companyName,
    industry,
    slides,
    pageImages,
  } = params;

  if (slides.length === 0) {
    return {
      slides,
      reviewedCount: 0,
      droppedCount: 0,
      mismatchDropped: 0,
      marketingDropped: 0,
      weakSignalDropped: 0,
    };
  }

  const reviewCandidates = slides
    .map((slide) => ({
      ...slide,
      pageAsImage: pageImages[slide.selectedPageNumber - 1],
    }))
    .filter((slide) => hasNonEmptyString(slide.pageAsImage));

  if (reviewCandidates.length === 0) {
    return {
      slides,
      reviewedCount: 0,
      droppedCount: 0,
      mismatchDropped: 0,
      marketingDropped: 0,
      weakSignalDropped: 0,
    };
  }

  const reviewPrompt = buildSlideReviewPrompt(reviewCandidates, companyName, industry);

  let reviewRaw: any;
  try {
    reviewRaw =
      provider === PROVIDER_GEMINI
        ? await callGeminiJson({
            apiKey: geminiApiKey as string,
            vertexApiKey,
            providerPreference,
            requestId,
            model,
            contents: [
              {
                parts: [
                  { text: reviewPrompt },
                  ...reviewCandidates.map((slide) => ({
                    inlineData: {
                      mimeType: extractMimeType(slide.pageAsImage),
                      data: extractBase64(slide.pageAsImage),
                    },
                  })),
                ],
              },
            ],
            responseSchema: POINTS_SLIDE_REVIEW_SCHEMA,
          })
        : await callOpenRouterJson({
            apiKey: openRouterApiKey as string,
            model,
            requestId,
            referer: openRouterSiteUrl,
            appTitle: openRouterAppTitle || "The Chatter Analyst",
            messageContent: [
              {
                type: "text",
                text: reviewPrompt,
              },
              ...reviewCandidates.map((slide) => ({
                type: "image_url" as const,
                image_url: { url: slide.pageAsImage },
              })),
            ],
          });
  } catch (reviewError: any) {
    console.log(
      JSON.stringify({
        event: "points_slide_review_failed",
        requestId,
        model,
        provider,
        candidateCount: reviewCandidates.length,
        message: String(reviewError?.message || "Unknown slide review failure"),
      }),
    );
    return {
      slides,
      reviewedCount: 0,
      droppedCount: 0,
      mismatchDropped: 0,
      marketingDropped: 0,
      weakSignalDropped: 0,
    };
  }

  const reviewPayload = normalizeSlideReviewPayload(reviewRaw);
  if (!Array.isArray(reviewPayload.reviews) || reviewPayload.reviews.length === 0) {
    return {
      slides,
      reviewedCount: 0,
      droppedCount: 0,
      mismatchDropped: 0,
      marketingDropped: 0,
      weakSignalDropped: 0,
    };
  }

  const reviewByPage = new Map<number, SlideReviewEntry>();
  for (const review of reviewPayload.reviews) {
    if (!reviewCandidates.some((slide) => slide.selectedPageNumber === review.selectedPageNumber)) {
      continue;
    }
    reviewByPage.set(review.selectedPageNumber, review);
  }

  let mismatchDropped = 0;
  let marketingDropped = 0;
  let weakSignalDropped = 0;
  let droppedCount = 0;
  let reviewedCount = 0;

  const reviewedSlides: SlideEntry[] = [];
  for (const slide of slides) {
    const review = reviewByPage.get(slide.selectedPageNumber);
    if (!review) {
      reviewedSlides.push(slide);
      continue;
    }

    reviewedCount += 1;
    const reason = review.reasonCode.toLowerCase();
    const confidence = review.confidence;
    const reasonIsMismatch =
      reason.includes("mismatch") || reason.includes("wrong_slide") || reason.includes("wrong");
    const reasonIsMarketing =
      reason.includes("marketing") || reason.includes("promotional") || reason.includes("branding") || reason.includes("pr");
    const reasonIsWeak = reason.includes("weak") || reason.includes("generic") || reason.includes("low_signal");

    const shouldDropMismatch = reasonIsMismatch && confidence >= MIN_REVIEW_CONFIDENCE;
    const shouldDropMarketing = reasonIsMarketing && confidence >= MIN_REVIEW_CONFIDENCE;
    const shouldDropWeakSignal =
      reasonIsWeak && review.status === "drop" && confidence >= HIGH_CONFIDENCE_DROP_THRESHOLD;

    if (shouldDropMismatch || shouldDropMarketing || shouldDropWeakSignal) {
      droppedCount += 1;
      if (shouldDropMismatch) mismatchDropped += 1;
      if (shouldDropMarketing) marketingDropped += 1;
      if (shouldDropWeakSignal) weakSignalDropped += 1;
      continue;
    }

    const nextContext = hasNonEmptyString(review.context)
      ? sanitizeContext(clampContextLength(review.context))
      : slide.context;
    reviewedSlides.push({
      ...slide,
      context: nextContext,
    });
  }

  const heuristicFiltered = applyMarketingPrefilter(reviewedSlides);
  if (heuristicFiltered.droppedCount > 0) {
    marketingDropped += heuristicFiltered.droppedCount;
    droppedCount += heuristicFiltered.droppedCount;
  }

  return {
    slides: heuristicFiltered.slides,
    reviewedCount,
    droppedCount,
    mismatchDropped,
    marketingDropped,
    weakSignalDropped,
  };
};

const applyContextRewriteIfNeeded = async (params: {
  provider: string;
  requestId: string;
  model: string;
  providerPreference?: ReturnType<typeof normalizeGeminiProviderPreference>;
  geminiApiKey?: string;
  vertexApiKey?: string;
  openRouterApiKey?: string;
  openRouterSiteUrl?: string;
  openRouterAppTitle?: string;
  companyName: string;
  industry: string;
  slides: SlideEntry[];
}): Promise<{ slides: SlideEntry[]; rewriteAppliedCount: number }> => {
  const {
    provider,
    requestId,
    model,
    providerPreference,
    geminiApiKey,
    vertexApiKey,
    openRouterApiKey,
    openRouterSiteUrl,
    openRouterAppTitle,
    companyName,
    industry,
    slides,
  } = params;

  const candidates: ContextRewriteCandidate[] = slides
    .map((slide) => {
      const check = contextNeedsRewrite(slide.context);
      return {
        selectedPageNumber: slide.selectedPageNumber,
        context: slide.context,
        reason: check.reason,
        qualityScore: scoreContextQuality(slide.context),
        needsRewrite: check.needsRewrite,
      };
    })
    .filter((item) => item.needsRewrite)
    .sort((left, right) => left.qualityScore - right.qualityScore)
    .slice(0, MAX_CONTEXT_REWRITE_CANDIDATES)
    .map((item) => ({
      selectedPageNumber: item.selectedPageNumber,
      context: item.context,
      reason: item.reason,
      qualityScore: item.qualityScore,
    }));

  if (candidates.length === 0) {
    return { slides, rewriteAppliedCount: 0 };
  }

  const rewritePrompt = buildRewritePrompt(candidates, companyName, industry);
  let rewriteRaw: any;
  try {
    rewriteRaw =
      provider === PROVIDER_GEMINI
        ? await callGeminiJson({
            apiKey: geminiApiKey as string,
            vertexApiKey,
            providerPreference,
            requestId,
            model,
            contents: [{ parts: [{ text: rewritePrompt }] }],
            responseSchema: POINTS_CONTEXT_REWRITE_SCHEMA,
          })
        : await callOpenRouterJson({
            apiKey: openRouterApiKey as string,
            model,
            requestId,
            referer: openRouterSiteUrl,
            appTitle: openRouterAppTitle || "The Chatter Analyst",
            messageContent: rewritePrompt,
          });
  } catch (rewriteError: any) {
    console.log(
      JSON.stringify({
        event: "points_context_rewrite_failed",
        requestId,
        model,
        provider,
        candidateCount: candidates.length,
        message: String(rewriteError?.message || "Unknown rewrite failure"),
      }),
    );
    return { slides, rewriteAppliedCount: 0 };
  }

  const rewritePayload = normalizeRewritePayload(rewriteRaw);
  if (!Array.isArray(rewritePayload.rewrites) || rewritePayload.rewrites.length === 0) {
    return { slides, rewriteAppliedCount: 0 };
  }

  const rewriteByPage = new Map<number, string>();
  for (const rewrite of rewritePayload.rewrites) {
    rewriteByPage.set(rewrite.selectedPageNumber, rewrite.context);
  }

  let rewriteAppliedCount = 0;
  const rewrittenSlides = slides.map((slide) => {
    const candidateRewrite = rewriteByPage.get(slide.selectedPageNumber);
    if (!candidateRewrite) {
      return slide;
    }

    const previousScore = scoreContextQuality(slide.context);
    const nextScore = scoreContextQuality(candidateRewrite);
    const nextCheck = contextNeedsRewrite(candidateRewrite);
    if (!nextCheck.needsRewrite || nextScore >= previousScore) {
      rewriteAppliedCount += 1;
      return {
        ...slide,
        context: candidateRewrite,
      };
    }

    return slide;
  });

  return {
    slides: rewrittenSlides,
    rewriteAppliedCount,
  };
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

  const pageImages = Array.isArray(body?.pageImages) ? body.pageImages : [];
  if (pageImages.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'pageImages' is required.", "MISSING_PAGE_IMAGES");
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

  const primaryApiKey = env?.GEMINI_API_KEY;
  const openRouterApiKey = env?.OPENROUTER_API_KEY;
  if (provider === PROVIDER_GEMINI && !primaryApiKey) {
    return error(500, "INTERNAL", "Server is missing GEMINI_API_KEY.", "MISSING_GEMINI_KEY");
  }
  if (provider === PROVIDER_OPENROUTER && !openRouterApiKey) {
    return error(500, "INTERNAL", "Server is missing OPENROUTER_API_KEY.", "MISSING_OPENROUTER_KEY");
  }

  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;

  if (pageImages.length > MAX_PAGES) {
    return error(400, "BAD_REQUEST", `A maximum of ${MAX_PAGES} pages is supported.`, "TOO_MANY_PAGES");
  }

  if (!pageImages.every((value) => typeof value === "string" && value.length > 0)) {
    return error(400, "BAD_REQUEST", "All items in 'pageImages' must be non-empty strings.", "INVALID_PAGE_IMAGE");
  }

  const { chunkRange, errorMessage: chunkRangeError } = parseChunkRange(
    body?.chunkStartPage,
    body?.chunkEndPage,
    pageImages.length,
  );
  if (chunkRangeError) {
    return error(400, "BAD_REQUEST", chunkRangeError, "INVALID_CHUNK_RANGE");
  }

  const totalImageChars = pageImages.reduce((sum, item) => sum + item.length, 0);
  if (totalImageChars > MAX_TOTAL_IMAGE_CHARS) {
    return error(413, "BAD_REQUEST", "Total image payload is too large.", "PAYLOAD_TOO_LARGE");
  }

  const promptText = buildPointsPrompt(pageImages.length, chunkRange);

  const imageParts = pageImages.map((dataUri) => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: extractBase64(dataUri),
    },
  }));

  console.log(
    JSON.stringify({
      event: "points_request_start",
      requestId,
      provider,
      requestedModel: model,
      providerPreference,
      pageCount: pageImages.length,
      totalImageChars,
      chunkStartPage: chunkRange?.startPage ?? null,
      chunkEndPage: chunkRange?.endPage ?? null,
    }),
  );

  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);
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
                  parts: [{ text: promptText }, ...imageParts],
                },
              ],
              responseSchema: POINTS_RESPONSE_SCHEMA,
            })
          : await callOpenRouterJson({
              apiKey: openRouterApiKey as string,
              model: attemptModel,
              requestId,
              referer: env.OPENROUTER_SITE_URL,
              appTitle: env.OPENROUTER_APP_TITLE || "The Chatter Analyst",
              messageContent: [
                {
                  type: "text",
                  text:
                    `${promptText}\n\n` +
                    "FINAL OUTPUT REQUIREMENT: Return only one valid JSON object. No markdown, no explanation.",
                },
                ...pageImages.map((dataUri) => ({
                  type: "image_url" as const,
                  image_url: { url: dataUri },
                })),
              ],
            });

      const validation = validatePointsResult(result, pageImages.length, chunkRange);
      if (validation.error) {
        console.log(
          JSON.stringify({
            event: "points_request_validation_failed",
            requestId,
            model: attemptModel,
            validationError: validation.error,
            normalizedPageCount: validation.normalizedPageCount,
            chunkStartPage: chunkRange?.startPage ?? null,
            chunkEndPage: chunkRange?.endPage ?? null,
          }),
        );
        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Presentation analysis failed validation.",
          "VALIDATION_FAILED",
          {
            requestId,
            validationError: validation.error,
            model: attemptModel,
            normalizedPageCount: validation.normalizedPageCount,
          },
        );
      }

      const initialSlides: SlideEntry[] = (Array.isArray(result?.slides) ? result.slides : [])
        .filter((slide: any) => slide && Number.isInteger(slide.selectedPageNumber) && hasNonEmptyString(slide.context))
        .map((slide: any) => ({
          selectedPageNumber: Number(slide.selectedPageNumber),
          context: clampContextLength(sanitizeContext(slide.context)),
        }));

      const rewriteOutcome = await applyContextRewriteIfNeeded({
        provider,
        requestId,
        model: attemptModel,
        providerPreference,
        geminiApiKey: primaryApiKey,
        vertexApiKey: env.VERTEX_API_KEY,
        openRouterApiKey,
        openRouterSiteUrl: env.OPENROUTER_SITE_URL,
        openRouterAppTitle: env.OPENROUTER_APP_TITLE,
        companyName: hasNonEmptyString(result?.companyName) ? result.companyName : "",
        industry: hasNonEmptyString(result?.industry) ? result.industry : "",
        slides: initialSlides,
      });

      const normalizedSlides = rewriteOutcome.slides.map((slide) => ({
        selectedPageNumber: slide.selectedPageNumber,
        context: clampContextLength(sanitizeContext(slide.context)),
      }));

      const prefilterOutcome = applyMarketingPrefilter(normalizedSlides);
      const selectedSlides = selectBestSlides(prefilterOutcome.slides);

      const reviewOutcome = await applySlideReviewIfNeeded({
        provider,
        requestId,
        model: attemptModel,
        providerPreference,
        geminiApiKey: primaryApiKey,
        vertexApiKey: env.VERTEX_API_KEY,
        openRouterApiKey,
        openRouterSiteUrl: env.OPENROUTER_SITE_URL,
        openRouterAppTitle: env.OPENROUTER_APP_TITLE,
        companyName: hasNonEmptyString(result?.companyName) ? result.companyName : "",
        industry: hasNonEmptyString(result?.industry) ? result.industry : "",
        slides: selectedSlides,
        pageImages,
      });

      const reviewedSelectedSlides = selectBestSlides(
        reviewOutcome.slides.map((slide) => ({
          selectedPageNumber: slide.selectedPageNumber,
          context: clampContextLength(sanitizeContext(slide.context)),
        })),
      );

      if (reviewedSelectedSlides.length === 0) {
        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Presentation analysis returned no usable slides after slide-context verification.",
          "VALIDATION_FAILED",
          {
            requestId,
            model: attemptModel,
            initialSlides: initialSlides.length,
            selectedSlidesBeforeReview: selectedSlides.length,
            rewriteAppliedCount: rewriteOutcome.rewriteAppliedCount,
            prefilterDropped: prefilterOutcome.droppedCount,
            reviewDropped: reviewOutcome.droppedCount,
            reviewMismatchDropped: reviewOutcome.mismatchDropped,
            reviewMarketingDropped: reviewOutcome.marketingDropped,
            reviewWeakSignalDropped: reviewOutcome.weakSignalDropped,
          },
        );
      }

      result.slides = reviewedSelectedSlides;

      if (prefilterOutcome.droppedCount > 0 || reviewOutcome.droppedCount > 0) {
        console.log(
          JSON.stringify({
            event: "points_slide_drop_summary",
            requestId,
            model: attemptModel,
            prefilterDropped: prefilterOutcome.droppedCount,
            reviewDropped: reviewOutcome.droppedCount,
            reviewMismatchDropped: reviewOutcome.mismatchDropped,
            reviewMarketingDropped: reviewOutcome.marketingDropped,
            reviewWeakSignalDropped: reviewOutcome.weakSignalDropped,
          }),
        );
      }

      const selectedSlidePageSet = new Set(result.slides.map((slide: SlideEntry) => slide.selectedPageNumber));
      const unmatchedSlides = selectedSlides.filter((slide) => !selectedSlidePageSet.has(slide.selectedPageNumber));

      if (unmatchedSlides.length > 0) {
        console.log(
          JSON.stringify({
            event: "points_slide_removed_after_review",
            requestId,
            model: attemptModel,
            removedCount: unmatchedSlides.length,
            removedPages: unmatchedSlides.map((slide) => slide.selectedPageNumber),
          }),
        );
      }

      console.log(
        JSON.stringify({
          event: "points_request_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          slides: result.slides.length,
          initialSlides: initialSlides.length,
          rewriteAppliedCount: rewriteOutcome.rewriteAppliedCount,
          prefilterDropped: prefilterOutcome.droppedCount,
          reviewInputSlides: selectedSlides.length,
          reviewReviewedCount: reviewOutcome.reviewedCount,
          reviewDropped: reviewOutcome.droppedCount,
          reviewMismatchDropped: reviewOutcome.mismatchDropped,
          reviewMarketingDropped: reviewOutcome.marketingDropped,
          reviewWeakSignalDropped: reviewOutcome.weakSignalDropped,
          normalizedPageCount: validation.normalizedPageCount,
          chunkStartPage: chunkRange?.startPage ?? null,
          chunkEndPage: chunkRange?.endPage ?? null,
        }),
      );

      if (attemptModel !== model) {
        console.log(
          JSON.stringify({
            event: "points_model_fallback_success",
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
      const isRateLimited = isUpstreamRateLimit(message);
      const isOverload = isOverloadError(message);
      const isImageProcessing =
        provider === PROVIDER_GEMINI
          ? isImageProcessingError(message)
          : message.toLowerCase().includes("image");
      const isTimeout = isTimeoutError(message);
      const isLocationBlocked = provider === PROVIDER_GEMINI && isLocationUnsupportedError(message);
      const isTransient = isUpstreamTransientError(message);
      const shouldFallback =
        hasFallback &&
        (schemaConstraint ||
          isRateLimited ||
          isOverload ||
          isImageProcessing ||
          isTimeout ||
          isLocationBlocked ||
          isTransient);

      console.log(
        JSON.stringify({
          event: "points_model_attempt_failure",
          requestId,
          provider,
          model: attemptModel,
          hasFallback,
          schemaConstraint,
          isRateLimited,
          isOverload,
          isImageProcessing,
          isTimeout,
          isLocationBlocked,
          isTransient,
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

      if (isRateLimited) {
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

      if (isOverload) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream model/provider is temporarily overloaded. Please retry.",
          "UPSTREAM_OVERLOAD",
          details,
        );
      }

      if (isImageProcessing) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream model could not process one or more slide images for this chunk. Retrying may work.",
          "UPSTREAM_IMAGE_PROCESSING",
          details,
        );
      }

      if (isTimeout) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream request timed out. Please retry.",
          "UPSTREAM_TIMEOUT",
          details,
        );
      }

      if (isLocationBlocked) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Gemini request was blocked by provider location policy after retries and model failover. Retry shortly or configure VERTEX_API_KEY for provider-level failover.",
          "UPSTREAM_LOCATION_UNSUPPORTED",
          details,
        );
      }

      if (isTransient) {
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
        `Presentation analysis failed: ${message}`,
        "UPSTREAM_FAILURE",
        details,
      );
    }
  }

  return error(
    UPSTREAM_DEPENDENCY_STATUS,
    "UPSTREAM_ERROR",
    `Presentation analysis failed: ${lastMessage}`,
    "UPSTREAM_FAILURE",
    { requestId, provider, model },
  );
}
