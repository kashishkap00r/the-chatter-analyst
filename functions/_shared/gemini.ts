const AI_STUDIO_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const VERTEX_EXPRESS_API_BASE = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1/chat/completions";

export type GeminiProvider = "ai_studio" | "vertex_express";
export type GeminiProviderPreference = GeminiProvider;

export const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

export const CHATTER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    companyName: { type: "STRING" },
    fiscalPeriod: { type: "STRING" },
    nseScrip: { type: "STRING" },
    marketCapCategory: { type: "STRING" },
    industry: { type: "STRING" },
    companyDescription: { type: "STRING" },
    quotes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          quote: { type: "STRING" },
          summary: { type: "STRING" },
          speaker: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              designation: { type: "STRING" },
            },
            required: ["name", "designation"],
          },
          category: { type: "STRING" },
        },
        required: ["quote", "summary", "speaker", "category"],
      },
    },
  },
  required: [
    "companyName",
    "fiscalPeriod",
    "nseScrip",
    "marketCapCategory",
    "industry",
    "companyDescription",
    "quotes",
  ],
};

export const POINTS_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    companyName: { type: "STRING" },
    fiscalPeriod: { type: "STRING" },
    nseScrip: { type: "STRING" },
    marketCapCategory: { type: "STRING" },
    industry: { type: "STRING" },
    companyDescription: { type: "STRING" },
    zerodhaStockUrl: { type: "STRING" },
    slides: {
      type: "ARRAY",
      minItems: 1,
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
  required: [
    "companyName",
    "fiscalPeriod",
    "nseScrip",
    "marketCapCategory",
    "industry",
    "companyDescription",
    "slides",
  ],
};

export const THREAD_DRAFT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    introTweet: { type: "STRING" },
    insightTweets: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          quoteId: { type: "STRING" },
          tweet: { type: "STRING" },
        },
        required: ["quoteId", "tweet"],
      },
    },
    outroTweet: { type: "STRING" },
  },
  required: ["introTweet", "insightTweets", "outroTweet"],
};

export const THREAD_REGENERATE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    tweet: { type: "STRING" },
  },
  required: ["tweet"],
};

export const THREAD_SHORTLIST_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    shortlistedQuoteIds: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
  },
  required: ["shortlistedQuoteIds"],
};

export const PLOTLINE_EXTRACT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    companyName: { type: "STRING" },
    fiscalPeriod: { type: "STRING" },
    nseScrip: { type: "STRING" },
    marketCapCategory: { type: "STRING" },
    industry: { type: "STRING" },
    companyDescription: { type: "STRING" },
    quotes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          quote: { type: "STRING" },
          speakerName: { type: "STRING" },
          speakerDesignation: { type: "STRING" },
          matchedKeywords: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
          periodLabel: { type: "STRING" },
          periodSortKey: { type: "INTEGER" },
        },
        required: [
          "quote",
          "speakerName",
          "speakerDesignation",
          "matchedKeywords",
          "periodLabel",
          "periodSortKey",
        ],
      },
    },
  },
  required: [
    "companyName",
    "fiscalPeriod",
    "nseScrip",
    "marketCapCategory",
    "industry",
    "companyDescription",
    "quotes",
  ],
};

export const PLOTLINE_SUMMARIZE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    companyNarratives: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          companyKey: { type: "STRING" },
          narrative: { type: "STRING" },
        },
        required: ["companyKey", "narrative"],
      },
    },
    masterThemeBullets: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
  },
  required: ["companyNarratives", "masterThemeBullets"],
};

export const CHATTER_PROMPT = `
ROLE & AUDIENCE
You are a research analyst for "The Chatter | India Edition," a bi-weekly newsletter read by portfolio managers.

CORE MISSION
1. Identify the Company Name and Fiscal Period (for example, "Q3 FY25").
2. Identify the NSE trading scrip used in Zerodha URLs (for example, SBIN, RELIANCE, HDFCBANK).
3. Determine market cap category and industry as shown on Zerodha stock pages.
4. Provide a concise factual 2-sentence company description.
5. Extract high-signal management quotes that are materially important to investors.
   - Target 8 to 20 quotes.
   - Return fewer than 8 only when genuinely high-signal material is limited.
   - Never return more than 20 quotes.
6. Coverage target (balanced soft):
   - Represent both prepared remarks/business update section and management answers during Q&A when both are available.
   - Do not force fixed section quotas if transcript quality differs across sections.
7. Use transcript page markers (for example, "--- Page 12 ---") and avoid taking all quotes only from early pages.
   Prefer spread across early/middle/late pages whenever material exists.
8. For each quote, provide:
   a) verbatim management quote
   b) a two-sentence investor implication summary in simple English
   c) speaker name and designation

QUOTE QUALITY RULES
- Use only management remarks (do not include analyst questions as quotes).
- Prefer high-signal statements: guidance, demand trends, margins/profitability, capex/allocation, risks, competitive or regulatory shifts.
- Prioritize comments that explain structural change, strategic direction, industry shifts, or longer-term business implications.
- De-prioritize routine quarter updates that only report numbers without explanatory insight.
- Include business-update quotes only when they add meaningful forward-looking context or management conviction.
- Avoid repetitive quotes that convey the same point.
- Preserve original wording; do not paraphrase inside quote.

SUMMARY LANGUAGE RULES
- Write the summary for a normal reader in clear, simple English.
- Use short sentences and everyday wording; avoid unnecessary complex jargon.
- Sentence 1 should state the key business takeaway from the quote.
- Sentence 2 should state why that takeaway matters for investors.

OUTPUT RULES
- Use market cap labels like Large Cap, Mid Cap, Small Cap, or Micro Cap.
- nseScrip must be uppercase with only A-Z and 0-9 characters.
- quotes must not exceed 20 items.
- Return valid JSON only.

SELF-CHECK BEFORE FINALIZING
- Confirm quote count is at most 20, and target at least 8 when sufficient high-signal material exists.
- Confirm both prepared remarks and Q&A answers are represented where available.
- Confirm output is valid JSON with all required fields.
`.trim();

export const POINTS_PROMPT = `
ROLE & AUDIENCE
You are an analyst for "Points & Figures | India Edition," a newsletter for portfolio managers.

CORE MISSION
1. Identify companyName and fiscalPeriod from the deck.
2. Identify NSE trading scrip used in Zerodha URLs (for example: RELIANCE, SBIN, HDFCBANK).
3. Determine marketCapCategory and industry as shown on Zerodha stock pages.
4. Write a concise factual 2-sentence companyDescription.
5. Select the most insightful presentation slides with longer-term implications for the business/industry.

SLIDE SELECTION RULES
- Prioritize strategic signal and novelty over quarterly noise.
- Strict novelty-first: prefer slides that reveal something non-obvious, new, or structurally important versus standard recurring updates.
- Favor slides that reveal industry structure, durable demand/supply shifts, capital allocation, M&A, product mix change, moat/competition, unit economics, regulatory change, or management strategy pivot.
- De-prioritize generic slides likely repeated every quarter unless this quarter shows a meaningful inflection.
- Ignore cover pages, ESG slogans, awards, org charts, photo-heavy pages with little analytical value.
- Target at least 3 slides when enough quality material exists; return fewer only if the deck has limited high-signal content.
- Return at most 10 slides.

SLIDE OUTPUT FORMAT
- For each selected slide, return:
  a) selectedPageNumber (1-indexed local page number within the provided request images, not full-deck absolute page)
  b) context: one concise insight-first paragraph (ideally 2 sentences):
     - Sentence 1: explain the hidden signal, likely driver, or read-between-the-lines interpretation.
     - Sentence 2: explain investor implication (quality of growth, risk, durability, margins, strategy, or industry structure).

CONTEXT QUALITY RULES
- Do not narrate obvious visual content that the reader can already see.
- Do not explain how to read the chart/table.
- Do not start context with phrases like "In this slide", "This slide shows", or "The slide shows".
- Avoid vague narration; include concrete directionality or mix shift wherever visible (for example, share increase/decrease by segment).
- If a financial/result slide is selected, explicitly justify why it is included now (what changed beneath headline numbers and why that matters).
- Write in balanced simple English: plain words first, sharp logic, minimal jargon.
- Keep each sentence short and direct (roughly <= 22 words when possible).
- Use common finance terms (for example: margin, mix, pricing, demand) only when they add precision.
- Prefer concrete verbs (rose, fell, shifted, improved, weakened) over abstract wording.
- Avoid consultant-like phrasing or dense jargon stacks.

BAD VS GOOD EXAMPLES
- Bad: "This slide shows segment revenue growth and margin trends across business lines."
- Good: "Margin expansion despite slower headline growth suggests mix is moving toward higher-value products, not just cyclical demand support. If sustained, this points to better earnings quality and lower downside in a softer cycle."
- Bad: "The chart presents loan book composition by product."
- Good: "A rising share of unsecured/micro-ticket lending usually signals a push for yield and faster growth, but it also raises sensitivity to credit stress later in the cycle. That trade-off is central to judging whether current growth is durable."
- Bad: "The portfolio displays a structurally accretive trajectory with calibrated operating leverage normalization."
- Good: "Profit growth looks stronger because fixed costs are being spread over higher volumes. If this continues, earnings can stay resilient even if demand cools a bit."

OUTPUT RULES
- Return one JSON object with companyName, fiscalPeriod, nseScrip, marketCapCategory, industry, companyDescription, and slides.
- nseScrip must be uppercase and contain only A-Z and 0-9.
- Use market cap labels like Large Cap, Mid Cap, Small Cap, or Micro Cap.
- Return valid JSON only.
`.trim();

export const THREAD_DRAFT_PROMPT = `
ROLE
You are writing an X (Twitter) thread for "The Chatter" edition in a crisp, witty, investor-aware voice.

GOAL
- Produce thread-ready text from selected quotes.
- Write a dynamic intro tweet, one insight tweet per selected quote, and a dynamic outro tweet.

VOICE & STYLE
- Crisp + witty, but still professional and clear.
- No jargon-heavy wording.
- No emojis.
- Avoid hashtags unless absolutely necessary.
- Keep each tweet readable in one glance.

INSIGHT TWEET RULES
- Exactly one insight tweet per selected quoteId.
- Each insight tweet must be 1 or 2 short lines.
- Explain the signal (what changed / why it matters), not generic quarter updates.
- Do not repeat phrasing across tweets.
- Keep under 260 characters per tweet.
- Do not include quote marks in the tweet line itself.

INTRO RULES
- Hook the reader with edition-level context.
- Mention this is from The Chatter and companies are discussing important shifts.
- Keep under 260 characters.

OUTRO RULES
- End with a clear CTA to read the full edition.
- If editionUrl is present in input, naturally include it in the outro text.
- Keep under 260 characters.

OUTPUT RULES
- Return strict JSON only.
- insightTweets must contain every quoteId exactly once.
`.trim();

export const THREAD_REGENERATE_PROMPT = `
ROLE
You rewrite one X (Twitter) thread line for The Chatter in a crisp, witty, investor-aware voice.

GOAL
- Regenerate only the target tweet.
- Keep it distinct from already used thread lines.

STYLE
- 1 to 2 short lines.
- Clear, simple English.
- No emojis.
- Avoid hashtags unless necessary.
- Keep under 260 characters.
- Do not use quote marks.

QUALITY BAR
- Focus on investor signal, not generic quarter commentary.
- Do not repeat openings or key phrases from usedTweetTexts.
- Keep tone sharp but factual.

OUTPUT
- Return strict JSON only with: { "tweet": "..." }.
`.trim();

export const THREAD_SHORTLIST_PROMPT = `
ROLE
You are selecting the best candidate quotes for an X (Twitter) thread from The Chatter edition.

GOAL
- Build a high-signal shortlist from a larger quote universe.
- Prefer quotes that are tweet-worthy, specific, and insight-rich.

SELECTION PRINCIPLES
- Prioritize non-obvious investor signal over routine quarter commentary.
- Prefer quotes that reveal change, strategy, risk, competitive shift, capital allocation, demand trend, or business inflection.
- Avoid repetitive points that say the same thing in different wording.
- Keep company coverage reasonably diverse when quality is similar.

OUTPUT RULES
- Return JSON only in this shape: { "shortlistedQuoteIds": string[] }.
- Include only quote IDs that are present in input.
- Do not include duplicates.
- Return up to maxCandidates IDs.
`.trim();

export const PLOTLINE_EXTRACT_PROMPT = `
ROLE
You are extracting Plotline evidence from an earnings call transcript.

GOAL
- Find only management quotes that explicitly mention any user-provided keyword (or close textual variant).
- Keep focus on long-term structural signals, not routine quarter noise.

INPUT
- You will receive:
  1) a keyword list
  2) transcript content, often as keyword-focused excerpts plus header metadata

EXTRACTION RULES
- Include only management remarks (exclude analyst questions).
- A quote is valid only if keyword presence is explicit in the quote text.
- Use only the provided transcript text; do not invent unseen lines.
- For each quote, return a short paragraph-style excerpt (ideally 2-3 sentences):
  1) one sentence before keyword sentence (if available)
  2) keyword sentence
  3) one sentence after keyword sentence (if available)
- Do not paraphrase the quote text.
- Return matchedKeywords as the exact keyword(s) from user list that were matched.
- Infer periodLabel from transcript context; prefer short label like Jun'26, Mar'26, Sep'25.
- Infer periodSortKey as integer YYYYMM (for Jun'26 => 202606). If uncertain, use best estimate from transcript metadata.
- Keep output concise and precise; avoid generic non-keyword commentary.
- If the same context is repeated multiple times in the transcript, keep only the strongest one and drop repeats.

OUTPUT
- Return valid JSON only with:
  companyName, fiscalPeriod, nseScrip, marketCapCategory, industry, companyDescription, quotes.
- nseScrip must be uppercase A-Z0-9.
- quotes should include only keyword-matching management remarks.
`.trim();

export const PLOTLINE_SUMMARIZE_PROMPT = `
ROLE
You are writing Plotline synthesis from extracted management quotes.

GOAL
- For each company, write one simple narrative paragraph (4-6 sentences) that explains what the chronological quotes mean collectively.
- Then write master theme bullets across all companies for the keyword edition.

STYLE
- Simple English. No dense jargon.
- Narrative should explain strategic direction, not repeat each quote verbatim.
- Keep company narratives practical and easy to understand.
- Master bullets should be executive-style and cross-company.

OUTPUT RULES
- Return strict JSON only with:
  1) companyNarratives: [{ companyKey, narrative }]
  2) masterThemeBullets: string[]
- masterThemeBullets target: 5 to 8 bullets.
`.trim();

const parseGeminiText = (payload: any): string => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
};

const parseOpenRouterText = (payload: any): string => {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item: any) => {
        if (typeof item?.text === "string") {
          return item.text;
        }
        if (typeof item?.content === "string") {
          return item.content;
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
};

const stripJsonFence = (text: string): string =>
  text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

const REQUEST_TIMEOUT_MS = 30000;
const MAX_AI_STUDIO_ATTEMPTS = 6;
const MAX_VERTEX_EXPRESS_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 1600;
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const OPENROUTER_REQUEST_TIMEOUT_MS = 45000;

const parseErrorMessage = (payload: any, status: number, provider: GeminiProvider): string => {
  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
    return `Gemini (${provider}) request failed with status ${status}: ${payload.error.message.trim()}`;
  }
  return `Gemini (${provider}) request failed with status ${status}.`;
};

const parseOpenRouterErrorMessage = (payload: any, status: number): string => {
  const payloadMessage =
    payload?.error?.message ||
    payload?.error?.metadata?.raw ||
    payload?.message;

  if (typeof payloadMessage === "string" && payloadMessage.trim()) {
    return `OpenRouter request failed with status ${status}: ${payloadMessage.trim()}`;
  }

  return `OpenRouter request failed with status ${status}.`;
};

const isLocationUnsupportedError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user location is not supported for the api use") ||
    normalized.includes("location is not supported for the api use")
  );
};

const isTimeoutOrNetworkError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("abort") ||
    normalized.includes("network") ||
    normalized.includes("fetch failed")
  );
};

const isRetryableGeminiFailure = (status: number | null, message: string): boolean => {
  const normalized = message.toLowerCase();
  if (isLocationUnsupportedError(message)) return true;
  if (isTimeoutOrNetworkError(message)) return true;
  if (typeof status === "number" && TRANSIENT_STATUS_CODES.has(status)) return true;
  return (
    normalized.includes("rate limit") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("quota") ||
    normalized.includes("high demand") ||
    normalized.includes("overload") ||
    normalized.includes("temporarily unavailable")
  );
};

const isRetryableGeminiOutputFailure = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("returned an empty response") || normalized.includes("returned invalid json");
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const computeRetryDelayMs = (attempt: number): number => {
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.max(50, Math.floor(exponential / 3)));
  return exponential + jitter;
};

export const normalizeGeminiProviderPreference = (value: unknown): GeminiProviderPreference => {
  if (typeof value !== "string") return "ai_studio";
  const normalized = value.trim().toLowerCase();
  if (normalized === "ai_studio") return "ai_studio";
  if (normalized === "vertex_express") return "vertex_express";
  return "ai_studio";
};

const resolveProviderOrder = (
  preference: GeminiProviderPreference,
  hasAiStudioCredential: boolean,
  hasVertexCredential: boolean,
): GeminiProvider[] => {
  const ordered: GeminiProvider[] = [];

  if (preference === "ai_studio") {
    if (hasAiStudioCredential) ordered.push("ai_studio");
    if (hasVertexCredential) ordered.push("vertex_express");
  } else {
    if (hasVertexCredential) ordered.push("vertex_express");
    if (hasAiStudioCredential) ordered.push("ai_studio");
  }

  return ordered;
};

const endpointForProvider = (provider: GeminiProvider, model: string, apiKey: string): string => {
  const base = provider === "ai_studio" ? AI_STUDIO_API_BASE : VERTEX_EXPRESS_API_BASE;
  return `${base}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
};

export const callGeminiJson = async (params: {
  apiKey: string;
  vertexApiKey?: string;
  model: string;
  contents: unknown;
  responseSchema: unknown;
  providerPreference?: GeminiProviderPreference;
  requestId?: string;
}): Promise<any> => {
  const { apiKey, vertexApiKey, model, contents, responseSchema, requestId } = params;
  const providerPreference = normalizeGeminiProviderPreference(params.providerPreference);
  const trimmedAiStudioKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const trimmedVertexKey = typeof vertexApiKey === "string" ? vertexApiKey.trim() : "";
  const hasAiStudioCredential = Boolean(trimmedAiStudioKey);
  const hasVertexCredential = Boolean(trimmedVertexKey || trimmedAiStudioKey);
  const providers = resolveProviderOrder(providerPreference, hasAiStudioCredential, hasVertexCredential);
  const providerErrors: string[] = [];

  if (providers.length === 0) {
    throw new Error("Gemini request failed: no provider credential is configured.");
  }

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    const keyForProvider = provider === "vertex_express" ? trimmedVertexKey || trimmedAiStudioKey : trimmedAiStudioKey;
    const hasProviderFallback = providers.length > 1;
    const maxAttempts =
      provider === "ai_studio"
        ? (hasProviderFallback ? Math.min(MAX_AI_STUDIO_ATTEMPTS, 4) : MAX_AI_STUDIO_ATTEMPTS)
        : MAX_VERTEX_EXPRESS_ATTEMPTS;

    if (!keyForProvider) {
      const missingKeyMessage =
        provider === "vertex_express"
          ? "Gemini (vertex_express) request failed: VERTEX_API_KEY is missing."
          : "Gemini (ai_studio) request failed: GEMINI_API_KEY is missing.";
      if (!providerErrors.includes(missingKeyMessage)) {
        providerErrors.push(missingKeyMessage);
      }
      continue;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const endpoint = endpointForProvider(provider, model, keyForProvider);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
      let status: number | null = null;

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            contents,
            safetySettings: SAFETY_SETTINGS,
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema,
            },
          }),
          signal: controller.signal,
        });
        status = response.status;

        let payload: any = null;
        try {
          payload = await response.json();
        } catch {
          // Keep null payload; handled below.
        }

        if (!response.ok) {
          const message = parseErrorMessage(payload, response.status, provider);
          if (!providerErrors.includes(message)) {
            providerErrors.push(message);
          }

          const shouldRetry =
            attempt < maxAttempts &&
            (isRetryableGeminiFailure(response.status, message) || isRetryableGeminiOutputFailure(message));
          if (shouldRetry) {
            const waitMs = computeRetryDelayMs(attempt);
            console.log(
              JSON.stringify({
                event: "gemini_retry",
                requestId,
                provider,
                model,
                attempt,
                maxAttempts,
                reason: "http_error",
                status: response.status,
                waitMs,
              }),
            );
            await sleep(waitMs);
            if (hasProviderFallback && isLocationUnsupportedError(message) && attempt >= 2) {
              break;
            }
            continue;
          }

          break;
        }

        const text = parseGeminiText(payload);
        if (!text) {
          throw new Error(`Gemini (${provider}) returned an empty response.`);
        }

        try {
          return JSON.parse(stripJsonFence(text));
        } catch {
          throw new Error(`Gemini (${provider}) returned invalid JSON.`);
        }
      } catch (error: any) {
        const message = String(error?.message || "Unknown Gemini request failure.");
        if (!providerErrors.includes(message)) {
          providerErrors.push(message);
        }

        const shouldRetry =
          attempt < maxAttempts &&
          (isRetryableGeminiFailure(status, message) || isRetryableGeminiOutputFailure(message));
        if (shouldRetry) {
          const waitMs = computeRetryDelayMs(attempt);
          console.log(
            JSON.stringify({
              event: "gemini_retry",
              requestId,
              provider,
              model,
              attempt,
              maxAttempts,
              reason: "network_or_timeout",
              status,
                waitMs,
              }),
            );
          await sleep(waitMs);
          if (hasProviderFallback && isLocationUnsupportedError(message) && attempt >= 2) {
            break;
          }
          continue;
        }

        break;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  throw new Error(providerErrors.join(" | ") || "Unknown Gemini request failure.");
};

export type OpenRouterMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export const callOpenRouterJson = async (params: {
  apiKey: string;
  model: string;
  messageContent: OpenRouterMessageContent;
  requestId?: string;
  referer?: string;
  appTitle?: string;
}): Promise<any> => {
  const { apiKey, model, messageContent, requestId, referer, appTitle } = params;

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (typeof referer === "string" && referer.trim()) {
    headers["HTTP-Referer"] = referer.trim();
  }
  if (typeof appTitle === "string" && appTitle.trim()) {
    headers["X-Title"] = appTitle.trim();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), OPENROUTER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_API_BASE, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: messageContent,
          },
        ],
      }),
      signal: controller.signal,
    });

    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      // Keep null payload; handled below.
    }

    if (!response.ok) {
      throw new Error(parseOpenRouterErrorMessage(payload, response.status));
    }

    const text = parseOpenRouterText(payload);
    if (!text) {
      throw new Error("OpenRouter returned an empty response.");
    }

    try {
      return JSON.parse(stripJsonFence(text));
    } catch {
      throw new Error("OpenRouter returned invalid JSON.");
    }
  } catch (error: any) {
    const message = String(error?.message || "Unknown OpenRouter request failure.");
    console.log(
      JSON.stringify({
        event: "openrouter_request_failure",
        requestId,
        model,
        message,
      }),
    );
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
};
