import { normalizeGeminiProviderPreference } from "../../_shared/gemini";
import type { GeminiProvider, GeminiProviderPreference } from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
}

type HealthState =
  | "ok"
  | "missing_key"
  | "invalid_key"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "location_unsupported"
  | "upstream_error";

interface ModelHealth {
  model: string;
  provider: GeminiProvider;
  state: HealthState;
  httpStatus?: number;
  message: string;
}

const AI_STUDIO_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const VERTEX_EXPRESS_API_BASE = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models";
const MODELS = ["gemini-2.5-flash", "gemini-3-pro-preview"] as const;
const REQUEST_TIMEOUT_MS = 15000;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const isLocationUnsupported = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user location is not supported for the api use") ||
    normalized.includes("location is not supported for the api use")
  );
};

const classifyGeminiError = (status: number, message: string): HealthState => {
  const normalized = message.toLowerCase();

  if (isLocationUnsupported(message)) {
    return "location_unsupported";
  }

  if (
    status === 401 ||
    status === 403 ||
    normalized.includes("api key not valid") ||
    normalized.includes("permission denied") ||
    normalized.includes("api_key_invalid")
  ) {
    return "invalid_key";
  }

  if (
    status === 429 ||
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("resource exhausted")
  ) {
    return "rate_limited";
  }

  if (
    status === 503 ||
    normalized.includes("high demand") ||
    normalized.includes("overload") ||
    normalized.includes("temporarily unavailable")
  ) {
    return "overloaded";
  }

  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "timeout";
  }

  return "upstream_error";
};

const parseGeminiMessage = async (response: Response): Promise<string> => {
  let payload: any = null;
  try {
    payload = await response.clone().json();
  } catch {
    // Ignore JSON parse failures and fallback to text.
  }

  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
    return payload.error.message.trim();
  }

  try {
    const text = (await response.text()).trim();
    if (text) {
      return text.length > 300 ? `${text.slice(0, 300)}...` : text;
    }
  } catch {
    // Ignore text read failures.
  }

  return `Gemini responded with status ${response.status}.`;
};

const resolveProviderOrder = (preference: GeminiProviderPreference): GeminiProvider[] => {
  if (preference === "ai_studio") return ["ai_studio"];
  if (preference === "vertex_express") return ["vertex_express"];
  return ["ai_studio", "vertex_express"];
};

const providerBase = (provider: GeminiProvider): string =>
  provider === "ai_studio" ? AI_STUDIO_API_BASE : VERTEX_EXPRESS_API_BASE;

const runSingleProbe = async (apiKey: string, model: string, provider: GeminiProvider): Promise<ModelHealth> => {
  const endpoint = `${providerBase(provider)}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Health check probe. Reply with OK.",
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8,
        },
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        model,
        provider,
        state: "ok",
        httpStatus: response.status,
        message: "Model responded successfully.",
      };
    }

    const message = await parseGeminiMessage(response);
    return {
      model,
      provider,
      state: classifyGeminiError(response.status, message),
      httpStatus: response.status,
      message,
    };
  } catch (error: any) {
    const message = String(error?.message || "Unknown request failure");
    const normalized = message.toLowerCase();
    const state: HealthState =
      normalized.includes("abort") || normalized.includes("timeout") ? "timeout" : "upstream_error";
    return {
      model,
      provider,
      state,
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const runModelProbe = async (params: {
  model: string;
  geminiApiKey?: string;
  vertexApiKey?: string;
  providerPreference: GeminiProviderPreference;
}): Promise<ModelHealth> => {
  const { model, geminiApiKey, vertexApiKey, providerPreference } = params;
  const providers = resolveProviderOrder(providerPreference);
  let lastResult: ModelHealth | null = null;

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    const key = provider === "vertex_express" ? vertexApiKey || geminiApiKey : geminiApiKey;

    if (!key) {
      lastResult = {
        model,
        provider,
        state: "missing_key",
        message: provider === "vertex_express" ? "Missing VERTEX_API_KEY (or GEMINI_API_KEY fallback)." : "Missing GEMINI_API_KEY.",
      };
      continue;
    }

    const result = await runSingleProbe(key, model, provider);
    lastResult = result;

    const shouldTryFallback =
      index < providers.length - 1 && result.provider === "ai_studio" && result.state === "location_unsupported";

    if (shouldTryFallback) {
      continue;
    }

    return result;
  }

  return (
    lastResult || {
      model,
      provider: "ai_studio",
      state: "upstream_error",
      message: "No provider attempt was executed.",
    }
  );
};

const evaluateOverallState = (results: ModelHealth[]): HealthState => {
  if (results.every((result) => result.state === "ok")) {
    return "ok";
  }
  if (results.some((result) => result.state === "invalid_key")) {
    return "invalid_key";
  }
  if (results.some((result) => result.state === "rate_limited")) {
    return "rate_limited";
  }
  if (results.some((result) => result.state === "overloaded")) {
    return "overloaded";
  }
  if (results.some((result) => result.state === "timeout")) {
    return "timeout";
  }
  if (results.some((result) => result.state === "location_unsupported")) {
    return "location_unsupported";
  }
  return "upstream_error";
};

const handleGeminiHealth = async (context: any): Promise<Response> => {
  const env = context.env as Env;
  const geminiApiKey = env?.GEMINI_API_KEY;
  const vertexApiKey = env?.VERTEX_API_KEY;
  const providerPreference = normalizeGeminiProviderPreference(env?.GEMINI_PROVIDER);

  if (!geminiApiKey && !vertexApiKey) {
    return json(
      {
        service: "gemini",
        timestamp: new Date().toISOString(),
        overallState: "missing_key",
        keyConfigured: false,
        message: "Set GEMINI_API_KEY and optionally VERTEX_API_KEY in Cloudflare Pages secrets.",
        models: [],
      },
      200,
    );
  }

  const modelResults: ModelHealth[] = [];
  for (const model of MODELS) {
    modelResults.push(
      await runModelProbe({
        model,
        geminiApiKey,
        vertexApiKey,
        providerPreference,
      }),
    );
  }

  const overallState = evaluateOverallState(modelResults);
  const keyState = overallState === "invalid_key" ? "invalid" : "configured";

  let guidance: string;
  if (overallState === "ok") {
    const usedVertex = modelResults.some((result) => result.provider === "vertex_express");
    guidance = usedVertex
      ? "Gemini is reachable via Vertex Express (fallback path active)."
      : "Gemini key and model endpoints are reachable.";
  } else if (overallState === "location_unsupported") {
    guidance =
      "AI Studio endpoint is blocked by location policy. Set VERTEX_API_KEY and keep GEMINI_PROVIDER=auto (or set GEMINI_PROVIDER=vertex_express).";
  } else {
    guidance =
      "Check models[].state for root cause (invalid_key, rate_limited, overloaded, timeout, location_unsupported, or upstream_error).";
  }

  return json({
    service: "gemini",
    timestamp: new Date().toISOString(),
    overallState,
    keyConfigured: Boolean(geminiApiKey || vertexApiKey),
    keyState,
    providerPreference,
    models: modelResults,
    guidance,
  });
};

export const onRequestGet = handleGeminiHealth;
export const onRequestPost = handleGeminiHealth;
