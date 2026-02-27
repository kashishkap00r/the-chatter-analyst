import {
  callGeminiJson,
  callOpenRouterJson,
  CHATTER_PROMPT,
  CHATTER_REPAIR_PROMPT,
  CHATTER_REPAIR_RESPONSE_SCHEMA,
  CHATTER_RESPONSE_SCHEMA,
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
  isLocationUnsupportedError,
  isOverloadError,
  isSchemaConstraintError,
  isStructuredOutputError,
  isTimeoutError,
  isUpstreamRateLimit as isUpstreamRateLimitBase,
  isUpstreamTransientError as isUpstreamTransientErrorBase,
} from "../../_shared/retryPolicy";
import { hasNonEmptyString } from "../../_shared/validation";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_TITLE?: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 800000;
const PROVIDER_GEMINI = "gemini";
const PROVIDER_OPENROUTER = "openrouter";
const DEFAULT_PROVIDER = PROVIDER_GEMINI;
const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_3_MODEL = "gemini-3-flash-preview";
const PRO_MODEL = "gemini-3-pro-preview";
const OPENROUTER_STANDARD_PRIMARY_MODEL = "deepseek/deepseek-v3.2";
const OPENROUTER_STANDARD_BACKUP_MODEL = "minimax/minimax-m2.1";
const OPENROUTER_PREMIUM_PRIMARY_MODEL = "anthropic/claude-sonnet-4";
const OPENROUTER_PREMIUM_BACKUP_MODEL = "openai/gpt-4.1-mini";
const DEFAULT_MODEL = FLASH_3_MODEL;
const ALLOWED_MODELS = new Set([FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL]);
const OPENROUTER_STANDARD_MODELS = new Set([
  OPENROUTER_STANDARD_PRIMARY_MODEL,
  OPENROUTER_STANDARD_BACKUP_MODEL,
]);
const OPENROUTER_PREMIUM_MODELS = new Set([
  OPENROUTER_PREMIUM_PRIMARY_MODEL,
  OPENROUTER_PREMIUM_BACKUP_MODEL,
]);
const OPENROUTER_ALLOWED_MODELS = new Set([
  ...OPENROUTER_STANDARD_MODELS,
  ...OPENROUTER_PREMIUM_MODELS,
]);
const MAX_QUOTES_COUNT = 20;
const UPSTREAM_DEPENDENCY_STATUS = 424;
const VALIDATION_STATUS = 422;
const ALLOWED_CATEGORIES = new Set([
  "Financial Guidance",
  "Capital Allocation",
  "Cost & Supply Chain",
  "Tech & Disruption",
  "Regulation & Policy",
  "Macro & Geopolitics",
  "ESG & Climate",
  "Legal & Governance",
  "Competitive Landscape",
  "Other Material",
]);
const CATEGORY_NORMALIZATION_RULES: Array<{ match: RegExp; normalized: string }> = [
  { match: /(financial|guidance|margin|profit|revenue|ebitda)/i, normalized: "Financial Guidance" },
  { match: /(capital|capex|allocation|buyback|dividend)/i, normalized: "Capital Allocation" },
  { match: /(cost|supply|procurement|input)/i, normalized: "Cost & Supply Chain" },
  { match: /(tech|technology|digital|automation|ai)/i, normalized: "Tech & Disruption" },
  { match: /(regulat|policy|compliance|government)/i, normalized: "Regulation & Policy" },
  { match: /(macro|geopolitic|inflation|currency|demand cycle)/i, normalized: "Macro & Geopolitics" },
  { match: /(esg|climate|sustainab)/i, normalized: "ESG & Climate" },
  { match: /(legal|governance|litigation|audit)/i, normalized: "Legal & Governance" },
  { match: /(competitive|competition|market share|peer)/i, normalized: "Competitive Landscape" },
];

const normalizeNseScrip = (value: unknown): string => {
  if (!hasNonEmptyString(value)) return "";

  const raw = value.trim().toUpperCase();
  let candidate = raw;

  if (candidate.includes(":")) {
    const lastSegment = candidate.split(":").pop();
    if (lastSegment) {
      candidate = lastSegment;
    }
  }

  candidate = candidate
    .replace(/^NSE[\s\-_/]*/i, "")
    .replace(/^BSE[\s\-_/]*/i, "")
    .replace(/\.NS$/i, "")
    .replace(/\(NSE\)/i, "")
    .trim();

  const strict = candidate.replace(/[^A-Z0-9]/g, "");
  if (strict) return strict;

  const tokenMatches = raw.match(/[A-Z0-9]{2,15}/g) || [];
  const filtered = tokenMatches.filter((token) => token !== "NSE" && token !== "BSE");
  if (filtered.length === 0) return "";
  return filtered[filtered.length - 1];
};

const normalizeCategory = (rawCategory: string): string => {
  const trimmed = rawCategory.trim();
  if (!trimmed) {
    return "Other Material";
  }
  if (ALLOWED_CATEGORIES.has(trimmed)) {
    return trimmed;
  }
  for (const rule of CATEGORY_NORMALIZATION_RULES) {
    if (rule.match.test(trimmed)) {
      return rule.normalized;
    }
  }
  return "Other Material";
};

const parseProvider = (value: unknown): ReturnType<typeof parseProviderValue> =>
  parseProviderValue(value, DEFAULT_PROVIDER);

const getModelAttemptOrder = (requestedModel: string): string[] =>
  getPrimarySecondaryTertiaryAttemptOrder(requestedModel, FLASH_MODEL, FLASH_3_MODEL, PRO_MODEL);

const getOpenRouterAttemptOrder = (requestedModel: string): string[] =>
  OPENROUTER_PREMIUM_MODELS.has(requestedModel)
    ? getPrimaryBackupAttemptOrder(
        requestedModel,
        OPENROUTER_PREMIUM_PRIMARY_MODEL,
        OPENROUTER_PREMIUM_BACKUP_MODEL,
      )
    : getPrimaryBackupAttemptOrder(
        requestedModel,
        OPENROUTER_STANDARD_PRIMARY_MODEL,
        OPENROUTER_STANDARD_BACKUP_MODEL,
      );

const isUpstreamRateLimit = (message: string): boolean =>
  isUpstreamRateLimitBase(message, { includeFreeTierRateLimitToken: true });

const isUpstreamTransientError = (message: string): boolean => isUpstreamTransientErrorBase(message);

interface OpenRouterRepairCandidate {
  index: number;
  quote: string;
  summary?: string;
  category?: string;
  speakerName?: string;
  speakerDesignation?: string;
  missingFields: string[];
}

interface OpenRouterRepairInspection {
  fatalError: string | null;
  candidates: OpenRouterRepairCandidate[];
}

const inspectOpenRouterRepairability = (result: any): OpenRouterRepairInspection => {
  if (!result || typeof result !== "object") {
    return { fatalError: "Gemini response is not a JSON object.", candidates: [] };
  }

  const requiredRootFields = [
    "companyName",
    "fiscalPeriod",
    "marketCapCategory",
    "industry",
    "companyDescription",
  ];
  for (const field of requiredRootFields) {
    if (!hasNonEmptyString(result[field])) {
      return { fatalError: `Missing or invalid field '${field}'.`, candidates: [] };
    }
  }

  result.nseScrip = normalizeNseScrip(result.nseScrip);

  if (!Array.isArray(result.quotes)) {
    return { fatalError: "Field 'quotes' must be an array.", candidates: [] };
  }
  if (result.quotes.length < 1) {
    return { fatalError: "Field 'quotes' must contain at least 1 item.", candidates: [] };
  }
  if (result.quotes.length > MAX_QUOTES_COUNT) {
    return {
      fatalError: `Field 'quotes' must contain at most ${MAX_QUOTES_COUNT} items, got ${result.quotes.length}.`,
      candidates: [],
    };
  }

  const candidates: OpenRouterRepairCandidate[] = [];
  for (let i = 0; i < result.quotes.length; i++) {
    const quoteItem = result.quotes[i];
    const quoteIndex = i + 1;
    if (!quoteItem || typeof quoteItem !== "object") {
      return { fatalError: `Quote #${quoteIndex} is invalid.`, candidates: [] };
    }
    if (!hasNonEmptyString(quoteItem.quote)) {
      return { fatalError: `Quote #${quoteIndex} is missing 'quote'.`, candidates: [] };
    }

    const missingFields: string[] = [];
    if (!hasNonEmptyString(quoteItem.summary)) {
      missingFields.push("summary");
    }
    if (!hasNonEmptyString(quoteItem.category)) {
      missingFields.push("category");
    }
    if (!quoteItem.speaker || typeof quoteItem.speaker !== "object") {
      missingFields.push("speaker.name");
      missingFields.push("speaker.designation");
    } else {
      if (!hasNonEmptyString(quoteItem.speaker.name)) {
        missingFields.push("speaker.name");
      }
      if (!hasNonEmptyString(quoteItem.speaker.designation)) {
        missingFields.push("speaker.designation");
      }
    }

    if (missingFields.length > 0) {
      candidates.push({
        index: i,
        quote: quoteItem.quote,
        summary: hasNonEmptyString(quoteItem.summary) ? quoteItem.summary : undefined,
        category: hasNonEmptyString(quoteItem.category) ? quoteItem.category : undefined,
        speakerName: hasNonEmptyString(quoteItem?.speaker?.name) ? quoteItem.speaker.name : undefined,
        speakerDesignation: hasNonEmptyString(quoteItem?.speaker?.designation)
          ? quoteItem.speaker.designation
          : undefined,
        missingFields,
      });
    }
  }

  return {
    fatalError: null,
    candidates,
  };
};

const repairOpenRouterChatterResult = async (params: {
  result: any;
  candidates: OpenRouterRepairCandidate[];
  model: string;
  requestId: string;
  apiKey: string;
  referer?: string;
  appTitle?: string;
}): Promise<{ repairedCount: number }> => {
  const { result, candidates, model, requestId, apiKey, referer, appTitle } = params;
  if (!Array.isArray(result?.quotes) || candidates.length === 0) {
    return { repairedCount: 0 };
  }

  const repairInput = {
    companyName: result.companyName,
    fiscalPeriod: result.fiscalPeriod,
    marketCapCategory: result.marketCapCategory,
    industry: result.industry,
    companyDescription: result.companyDescription,
    quotes: candidates.map((candidate) => ({
      index: candidate.index,
      quote: candidate.quote,
      summary: candidate.summary,
      category: candidate.category,
      speakerName: candidate.speakerName,
      speakerDesignation: candidate.speakerDesignation,
      missingFields: candidate.missingFields,
    })),
  };

  const repairResponse = await callOpenRouterJson({
    apiKey,
    model,
    requestId,
    referer,
    appTitle: appTitle || "The Chatter Analyst",
    messageContent:
      `${CHATTER_REPAIR_PROMPT}\n\nINPUT JSON:\n${JSON.stringify(repairInput)}\n\n` +
      `RESPONSE JSON SCHEMA:\n${JSON.stringify(CHATTER_REPAIR_RESPONSE_SCHEMA)}\n\n` +
      "FINAL OUTPUT REQUIREMENT: Return only one valid JSON object. No markdown, no explanation.",
  });

  const repairedItems = Array.isArray(repairResponse?.quotes) ? repairResponse.quotes : [];
  let repairedCount = 0;

  for (const rawItem of repairedItems) {
    if (!rawItem || !Number.isInteger(rawItem.index)) continue;
    const quoteIndex = Number(rawItem.index);
    if (quoteIndex < 0 || quoteIndex >= result.quotes.length) continue;

    const quote = result.quotes[quoteIndex];
    if (!quote || typeof quote !== "object") continue;

    let changed = false;

    if (hasNonEmptyString(rawItem.summary)) {
      quote.summary = rawItem.summary.trim();
      changed = true;
    }
    if (hasNonEmptyString(rawItem.category)) {
      quote.category = normalizeCategory(rawItem.category);
      changed = true;
    }

    const speakerName = hasNonEmptyString(rawItem?.speaker?.name)
      ? rawItem.speaker.name.trim()
      : undefined;
    const speakerDesignation = hasNonEmptyString(rawItem?.speaker?.designation)
      ? rawItem.speaker.designation.trim()
      : undefined;
    if (speakerName || speakerDesignation) {
      quote.speaker = {
        name:
          speakerName ||
          (hasNonEmptyString(quote?.speaker?.name) ? quote.speaker.name : "Management"),
        designation:
          speakerDesignation ||
          (hasNonEmptyString(quote?.speaker?.designation) ? quote.speaker.designation : "Company Management"),
      };
      changed = true;
    }

    if (changed) {
      repairedCount += 1;
    }
  }

  return { repairedCount };
};

const validateChatterResult = (result: any): string | null => {
  if (!result || typeof result !== "object") {
    return "Gemini response is not a JSON object.";
  }

  const requiredRootFields = [
    "companyName",
    "fiscalPeriod",
    "marketCapCategory",
    "industry",
    "companyDescription",
  ];
  for (const field of requiredRootFields) {
    if (!hasNonEmptyString(result[field])) {
      return `Missing or invalid field '${field}'.`;
    }
  }

  result.nseScrip = normalizeNseScrip(result.nseScrip);

  if (!Array.isArray(result.quotes)) {
    return "Field 'quotes' must be an array.";
  }

  if (result.quotes.length < 1) {
    return "Field 'quotes' must contain at least 1 item.";
  }

  if (result.quotes.length > MAX_QUOTES_COUNT) {
    return `Field 'quotes' must contain at most ${MAX_QUOTES_COUNT} items, got ${result.quotes.length}.`;
  }

  for (let i = 0; i < result.quotes.length; i++) {
    const quoteItem = result.quotes[i];
    const quoteIndex = i + 1;

    if (!quoteItem || typeof quoteItem !== "object") {
      return `Quote #${quoteIndex} is invalid.`;
    }
    if (!hasNonEmptyString(quoteItem.quote)) {
      return `Quote #${quoteIndex} is missing 'quote'.`;
    }
    if (!hasNonEmptyString(quoteItem.summary)) {
      return `Quote #${quoteIndex} is missing 'summary'.`;
    }
    if (!hasNonEmptyString(quoteItem.category)) {
      return `Quote #${quoteIndex} is missing 'category'.`;
    }
    quoteItem.category = normalizeCategory(quoteItem.category);
    if (!quoteItem.speaker || typeof quoteItem.speaker !== "object") {
      return `Quote #${quoteIndex} is missing 'speaker'.`;
    }
    if (!hasNonEmptyString(quoteItem.speaker.name)) {
      return `Quote #${quoteIndex} is missing 'speaker.name'.`;
    }
    if (!hasNonEmptyString(quoteItem.speaker.designation)) {
      return `Quote #${quoteIndex} is missing 'speaker.designation'.`;
    }
  }

  return null;
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

  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return error(400, "BAD_REQUEST", "Field 'transcript' is required.", "MISSING_TRANSCRIPT");
  }

  const provider = parseProvider(body?.provider);
  if (!provider) {
    return error(400, "BAD_REQUEST", "Field 'provider' is invalid.", "INVALID_PROVIDER");
  }

  const model = resolveRequestedModel(body?.model, provider, {
    gemini: DEFAULT_MODEL,
    openrouter: OPENROUTER_STANDARD_PRIMARY_MODEL,
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

  const modelAttemptOrder =
    provider === PROVIDER_GEMINI ? getModelAttemptOrder(model) : getOpenRouterAttemptOrder(model);
  const providerPreference =
    provider === PROVIDER_GEMINI ? normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER) : undefined;
  const inputText = `${CHATTER_PROMPT}\n\nINPUT TRANSCRIPT:\n${transcript.substring(0, MAX_TRANSCRIPT_CHARS)}`;

  console.log(
    JSON.stringify({
      event: "chatter_request_start",
      requestId,
      provider,
      requestedModel: model,
      providerPreference,
      transcriptChars: transcript.length,
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
              apiKey: primaryApiKey as string,
              vertexApiKey: env.VERTEX_API_KEY,
              providerPreference,
              requestId,
              model: attemptModel,
              contents: [
                {
                  parts: [{ text: inputText }],
                },
              ],
              responseSchema: CHATTER_RESPONSE_SCHEMA,
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

      let repairPhase: "none" | "openrouter_repair" = "none";
      if (provider === PROVIDER_OPENROUTER) {
        const inspection = inspectOpenRouterRepairability(result);
        if (inspection.fatalError) {
          console.log(
            JSON.stringify({
              event: "chatter_openrouter_validation_issue",
              requestId,
              model: attemptModel,
              phase: "validate_initial",
              fatalError: inspection.fatalError,
            }),
          );

          if (hasFallback) {
            console.log(
              JSON.stringify({
                event: "chatter_openrouter_fallback_phase",
                requestId,
                requestedModel: model,
                failedModel: attemptModel,
                phase: "validate_initial",
              }),
            );
            lastMessage = inspection.fatalError;
            continue;
          }
        } else if (inspection.candidates.length > 0) {
          repairPhase = "openrouter_repair";
          const missingFieldsCount = inspection.candidates.reduce(
            (sum, candidate) => sum + candidate.missingFields.length,
            0,
          );
          console.log(
            JSON.stringify({
              event: "chatter_openrouter_repair_attempt",
              requestId,
              model: attemptModel,
              candidates: inspection.candidates.length,
              missingFieldsCount,
            }),
          );

          try {
            const repairOutcome = await repairOpenRouterChatterResult({
              result,
              candidates: inspection.candidates,
              model: attemptModel,
              requestId,
              apiKey: openRouterApiKey as string,
              referer: env.OPENROUTER_SITE_URL,
              appTitle: env.OPENROUTER_APP_TITLE,
            });

            console.log(
              JSON.stringify({
                event: "chatter_openrouter_repair_success",
                requestId,
                model: attemptModel,
                repairedCount: repairOutcome.repairedCount,
                candidates: inspection.candidates.length,
              }),
            );
          } catch (repairError: any) {
            const repairMessage = String(repairError?.message || "Unknown repair failure.");
            console.log(
              JSON.stringify({
                event: "chatter_openrouter_repair_failure",
                requestId,
                model: attemptModel,
                message: repairMessage,
              }),
            );

            if (hasFallback) {
              console.log(
                JSON.stringify({
                  event: "chatter_openrouter_fallback_phase",
                  requestId,
                  requestedModel: model,
                  failedModel: attemptModel,
                  phase: "openrouter_repair",
                }),
              );
              lastMessage = repairMessage;
              continue;
            }
          }
        }
      }

      const validationError = validateChatterResult(result);
      if (validationError) {
        const phase = repairPhase === "openrouter_repair" ? "validate_after_repair" : "validate_initial";
        console.log(
          JSON.stringify({
            event: "chatter_request_validation_failed",
            requestId,
            model: attemptModel,
            validationError,
            phase,
          }),
        );

        if (provider === PROVIDER_OPENROUTER && hasFallback) {
          console.log(
            JSON.stringify({
              event: "chatter_openrouter_fallback_phase",
              requestId,
              requestedModel: model,
              failedModel: attemptModel,
              phase,
            }),
          );
          lastMessage = validationError;
          continue;
        }

        return error(
          VALIDATION_STATUS,
          "UPSTREAM_ERROR",
          "Transcript analysis failed validation.",
          "VALIDATION_FAILED",
          { requestId, validationError, model: attemptModel, phase },
        );
      }

      console.log(
        JSON.stringify({
          event: "chatter_request_success",
          requestId,
          provider,
          requestedModel: model,
          resolvedModel: attemptModel,
          quotes: Array.isArray(result?.quotes) ? result.quotes.length : null,
        }),
      );

      if (attemptModel !== model) {
        console.log(
          JSON.stringify({
            event: "chatter_model_fallback_success",
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
      const shouldFallback =
        hasFallback && (schemaConstraint || upstreamRateLimit || transientUpstream || locationUnsupported);

      console.log(
        JSON.stringify({
          event: "chatter_model_attempt_failure",
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

      if (isOverloadError(message)) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream model/provider is temporarily overloaded. Please retry.",
          "UPSTREAM_OVERLOAD",
          details,
        );
      }

      if (isTimeoutError(message)) {
        return error(
          UPSTREAM_DEPENDENCY_STATUS,
          "UPSTREAM_ERROR",
          "Upstream request timed out. Please retry.",
          "UPSTREAM_TIMEOUT",
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
          "Upstream model request failed transiently. Please retry.",
          "UPSTREAM_TRANSIENT",
          details,
        );
      }

      return error(
        UPSTREAM_DEPENDENCY_STATUS,
        "UPSTREAM_ERROR",
        `Transcript analysis failed: ${message}`,
        "UPSTREAM_FAILURE",
        details,
      );
    }
  }

  return error(
    UPSTREAM_DEPENDENCY_STATUS,
    "UPSTREAM_ERROR",
    `Transcript analysis failed: ${lastMessage}`,
    "UPSTREAM_FAILURE",
    { requestId, provider, model },
  );
}
