interface Env {
  GEMINI_API_KEY?: string;
}

type HealthState =
  | "ok"
  | "missing_key"
  | "invalid_key"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "upstream_error";

interface ModelHealth {
  model: string;
  state: HealthState;
  httpStatus?: number;
  message: string;
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
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

const classifyGeminiError = (status: number, message: string): HealthState => {
  const normalized = message.toLowerCase();

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

const runModelProbe = async (apiKey: string, model: string): Promise<ModelHealth> => {
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
        state: "ok",
        httpStatus: response.status,
        message: "Model responded successfully.",
      };
    }

    const message = await parseGeminiMessage(response);
    return {
      model,
      state: classifyGeminiError(response.status, message),
      httpStatus: response.status,
      message,
    };
  } catch (error: any) {
    const message = String(error?.message || "Unknown request failure");
    const state: HealthState = message.toLowerCase().includes("abort") ? "timeout" : "upstream_error";
    return {
      model,
      state,
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
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
  return "upstream_error";
};

const handleGeminiHealth = async (context: any): Promise<Response> => {
  const env = context.env as Env;

  if (!env?.GEMINI_API_KEY) {
    return json(
      {
        service: "gemini",
        timestamp: new Date().toISOString(),
        overallState: "missing_key",
        keyConfigured: false,
        message: "GEMINI_API_KEY is not configured in Cloudflare Pages secrets.",
        models: [],
      },
      200,
    );
  }

  const modelResults: ModelHealth[] = [];
  for (const model of MODELS) {
    modelResults.push(await runModelProbe(env.GEMINI_API_KEY, model));
  }

  const overallState = evaluateOverallState(modelResults);
  const keyState = overallState === "invalid_key" ? "invalid" : "configured";

  return json({
    service: "gemini",
    timestamp: new Date().toISOString(),
    overallState,
    keyConfigured: true,
    keyState,
    models: modelResults,
    guidance:
      overallState === "ok"
        ? "Gemini key and model endpoints are reachable."
        : "Check models[].state for root cause (invalid_key, rate_limited, overloaded, timeout, or upstream_error).",
  });
};

export const onRequestGet = handleGeminiHealth;
export const onRequestPost = handleGeminiHealth;
