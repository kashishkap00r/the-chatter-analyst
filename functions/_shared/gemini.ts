const AI_STUDIO_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const VERTEX_EXPRESS_API_BASE = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models";

export type GeminiProvider = "ai_studio" | "vertex_express";
export type GeminiProviderPreference = GeminiProvider | "auto";

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

export const CHATTER_PROMPT = `
ROLE & AUDIENCE
You are a research analyst for "The Chatter | India Edition," a bi-weekly newsletter read by portfolio managers.

CORE MISSION
1. Identify the Company Name and Fiscal Period (for example, "Q3 FY25").
2. Identify the NSE trading scrip used in Zerodha URLs (for example, SBIN, RELIANCE, HDFCBANK).
3. Determine market cap category and industry as shown on Zerodha stock pages.
4. Provide a concise factual 2-sentence company description.
5. Extract exactly twenty management quotes that are materially important to investors.
6. Coverage target (balanced soft):
   - At least 6 quotes from prepared remarks/business update section.
   - At least 6 quotes from management answers during Q&A.
   - Remaining 8 quotes from best available material across either section.
   - If Q&A material is thin, backfill from prepared remarks while still returning exactly 20 quotes.
7. Use transcript page markers (for example, "--- Page 12 ---") and avoid taking all quotes only from early pages.
   Prefer spread across early/middle/late pages whenever material exists.
8. For each quote, provide:
   a) verbatim management quote
   b) one-sentence investor implication summary
   c) speaker name and designation

QUOTE QUALITY RULES
- Use only management remarks (do not include analyst questions as quotes).
- Prefer high-signal statements: guidance, demand trends, margins/profitability, capex/allocation, risks, competitive or regulatory shifts.
- Avoid repetitive quotes that convey the same point.
- Preserve original wording; do not paraphrase inside quote.

OUTPUT RULES
- Use market cap labels like Large Cap, Mid Cap, Small Cap, or Micro Cap.
- nseScrip must be uppercase with only A-Z and 0-9 characters.
- quotes must contain exactly 20 items (not fewer, not more).
- Return valid JSON only.

SELF-CHECK BEFORE FINALIZING
- Confirm quotes length is exactly 20.
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
- Prioritize strategic signal over quarterly noise.
- Favor slides that reveal industry structure, durable demand/supply shifts, capital allocation, M&A, product mix change, moat/competition, unit economics, regulatory change, or management strategy pivot.
- Avoid generic update slides that only restate routine quarterly revenue/profit movement without structural insight.
- Ignore cover pages, ESG slogans, awards, org charts, photo-heavy pages with little analytical value.
- Target at least 3 slides when enough quality material exists; return fewer only if the deck has limited high-signal content.
- No upper cap on slide count.

SLIDE OUTPUT FORMAT
- For each selected slide, return:
  a) selectedPageNumber (1-indexed)
  b) context: one insight-first paragraph with this structure:
     - Start directly with what has changed or what stands out in the slide data.
     - Include 2-3 concrete observations from the slide (mix, trend, comparison, composition shift, concentration, etc.).
     - End with one investor implication sentence (what this means for business quality, risk, growth durability, margins, or industry structure).

CONTEXT QUALITY RULES
- Do not explain how to read the chart/table.
- Do not start context with phrases like "In this slide", "This slide shows", or "The slide shows".
- Avoid vague narration; include concrete directionality or mix shift wherever visible (for example, share increase/decrease by segment).

OUTPUT RULES
- Return one JSON object with companyName, fiscalPeriod, nseScrip, marketCapCategory, industry, companyDescription, and slides.
- nseScrip must be uppercase and contain only A-Z and 0-9.
- Use market cap labels like Large Cap, Mid Cap, Small Cap, or Micro Cap.
- Return valid JSON only.
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

const stripJsonFence = (text: string): string =>
  text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

const parseErrorMessage = (payload: any, status: number, provider: GeminiProvider): string => {
  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
    return `Gemini (${provider}) request failed with status ${status}: ${payload.error.message.trim()}`;
  }
  return `Gemini (${provider}) request failed with status ${status}.`;
};

const isLocationUnsupportedError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user location is not supported for the api use") ||
    normalized.includes("location is not supported for the api use")
  );
};

export const normalizeGeminiProviderPreference = (value: unknown): GeminiProviderPreference => {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "ai_studio") return "ai_studio";
  if (normalized === "vertex_express") return "vertex_express";
  return "auto";
};

const resolveProviderOrder = (preference: GeminiProviderPreference): GeminiProvider[] => {
  if (preference === "ai_studio") return ["ai_studio"];
  if (preference === "vertex_express") return ["vertex_express"];
  return ["ai_studio", "vertex_express"];
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
}): Promise<any> => {
  const { apiKey, vertexApiKey, model, contents, responseSchema } = params;
  const providerPreference = normalizeGeminiProviderPreference(params.providerPreference);
  const providers = resolveProviderOrder(providerPreference);
  const providerErrors: string[] = [];

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    const keyForProvider = provider === "vertex_express" ? vertexApiKey || apiKey : apiKey;
    const endpoint = endpointForProvider(provider, model, keyForProvider);
    const isLastAttempt = index === providers.length - 1;

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
      });

      let payload: any = null;
      try {
        payload = await response.json();
      } catch {
        // Keep null payload; handled below.
      }

      if (!response.ok) {
        const message = parseErrorMessage(payload, response.status, provider);
        providerErrors.push(message);

        const shouldFallbackToVertex =
          !isLastAttempt && provider === "ai_studio" && providers[index + 1] === "vertex_express" && isLocationUnsupportedError(message);
        if (shouldFallbackToVertex) {
          continue;
        }

        throw new Error(providerErrors.join(" | "));
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

      const shouldFallbackToVertex =
        !isLastAttempt && provider === "ai_studio" && providers[index + 1] === "vertex_express" && isLocationUnsupportedError(message);
      if (shouldFallbackToVertex) {
        continue;
      }

      throw new Error(providerErrors.join(" | "));
    }
  }

  throw new Error(providerErrors.join(" | ") || "Unknown Gemini request failure.");
};
