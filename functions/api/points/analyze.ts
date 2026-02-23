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
        ]
      : [
          "REQUEST PAGE WINDOW",
          `- You are seeing only a chunk of the full deck: absolute pages ${chunkRange.startPage}-${chunkRange.endPage}.`,
          `- selectedPageNumber MUST be local to this chunk: 1 to ${chunkPageCount} (not absolute deck page).`,
          `- Mapping: local page 1 = absolute page ${chunkRange.startPage}; local page ${chunkPageCount} = absolute page ${chunkRange.endPage}.`,
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

      console.log(
        JSON.stringify({
          event: "points_request_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          slides: Array.isArray(result?.slides) ? result.slides.length : null,
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
