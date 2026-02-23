import {
  callGeminiJson,
  callOpenRouterJson,
  POINTS_PROMPT,
  POINTS_RESPONSE_SCHEMA,
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

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_TOTAL_IMAGE_CHARS = 20 * 1024 * 1024;
const PROVIDER_GEMINI = "gemini";
const PROVIDER_OPENROUTER = "openrouter";
const DEFAULT_PROVIDER = PROVIDER_GEMINI;
const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_3_MODEL = "gemini-3-flash-preview";
const PRO_MODEL = "gemini-3-pro-preview";
const OPENROUTER_PRIMARY_MODEL = "minimax/minimax-01";
const OPENROUTER_BACKUP_MODEL = "qwen/qwen3-vl-235b-a22b-instruct";
const DEFAULT_MODEL = FLASH_MODEL;
const ALLOWED_MODELS = new Set([FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL]);
const OPENROUTER_ALLOWED_MODELS = new Set([OPENROUTER_PRIMARY_MODEL]);
const IS_STRICT_VALIDATION: boolean = false;
const UPSTREAM_DEPENDENCY_STATUS = 424;
const VALIDATION_STATUS = 422;
const MAX_SELECTED_SLIDES = 10;
const MAX_CONTEXT_SENTENCES = 2;
const MAX_CONTEXT_CHARACTERS = 420;
const MAX_CONTEXT_REWRITE_CANDIDATES = 6;

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

interface ChunkRange {
  startPage: number;
  endPage: number;
}

interface PointsValidationResult {
  error: string | null;
  normalizedPageCount: number;
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

const error = (status: number, code: string, message: string, reasonCode?: string, details?: unknown): Response =>
  json(
    {
      error: {
        code,
        message,
        reasonCode,
        details,
      },
    },
    status,
  );

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

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

const isImageProcessingError = (message: string): boolean =>
  message.toLowerCase().includes("unable to process input image");

const isUpstreamTransientError = (message: string): boolean =>
  isOverloadError(message) ||
  isTimeoutError(message) ||
  message.includes("500") ||
  message.includes("502") ||
  message.includes("504");

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
  if (requestedModel === OPENROUTER_BACKUP_MODEL) {
    return [OPENROUTER_BACKUP_MODEL, OPENROUTER_PRIMARY_MODEL];
  }
  return [OPENROUTER_PRIMARY_MODEL, OPENROUTER_BACKUP_MODEL];
};

const isStructuredOutputError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("invalid json") || normalized.includes("empty response");
};

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

const contextNeedsRewrite = (value: string): { needsRewrite: boolean; reason: string } => {
  const lower = value.toLowerCase();
  const descriptiveHits = countTermHits(lower, DESCRIPTIVE_TERMS);
  const inferenceHits = countTermHits(lower, INFERENCE_TERMS);
  const financialHits = countTermHits(lower, FINANCIAL_TERMS);
  const sentenceCount = splitSentences(value).length;
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

  return { needsRewrite: false, reason: "ok" };
};

const scoreContextQuality = (value: string): number => {
  const lower = value.toLowerCase();
  const inferenceHits = countTermHits(lower, INFERENCE_TERMS);
  const noveltyHits = countTermHits(lower, NOVELTY_TERMS);
  const descriptiveHits = countTermHits(lower, DESCRIPTIVE_TERMS);
  const routineHits = countTermHits(lower, ROUTINE_TERMS);
  const sentencePenalty = Math.max(0, splitSentences(value).length - MAX_CONTEXT_SENTENCES);
  const financialPenalty = containsFinancialLanguage(value) && inferenceHits === 0 ? 2 : 0;

  return (
    inferenceHits * 3 +
    noveltyHits * 2 -
    descriptiveHits * 2 -
    routineHits -
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
    "You are rewriting slide context for a portfolio-manager audience.",
    `Company: ${companyName || "Unknown"}`,
    `Industry: ${industry || "Unknown"}`,
    "",
    "Rewrite each context to be insight-first, concise, and not descriptive.",
    "Rules:",
    "- Keep each context to exactly 2 short sentences where possible.",
    "- Sentence 1: hidden signal, likely driver, or read-between-the-lines interpretation.",
    "- Sentence 2: investor implication (durability, risk, margins, strategy, or industry structure).",
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

  const pageImages = Array.isArray(body?.pageImages) ? body.pageImages : [];
  if (pageImages.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'pageImages' is required.", "MISSING_PAGE_IMAGES");
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

      const selectedSlides = selectBestSlides(
        rewriteOutcome.slides.map((slide) => ({
          selectedPageNumber: slide.selectedPageNumber,
          context: clampContextLength(sanitizeContext(slide.context)),
        })),
      );

      if (selectedSlides.length === 0) {
        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Presentation analysis returned no usable slides after quality filtering.",
          "VALIDATION_FAILED",
          {
            requestId,
            model: attemptModel,
            initialSlides: initialSlides.length,
            rewriteAppliedCount: rewriteOutcome.rewriteAppliedCount,
          },
        );
      }

      result.slides = selectedSlides;

      console.log(
        JSON.stringify({
          event: "points_request_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          slides: selectedSlides.length,
          initialSlides: initialSlides.length,
          rewriteAppliedCount: rewriteOutcome.rewriteAppliedCount,
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
