const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
      minItems: 20,
      maxItems: 20,
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
          category: {
            type: "STRING",
            enum: [
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
            ],
          },
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
    slides: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          selectedPageNumber: { type: "INTEGER" },
          whyThisSlide: { type: "STRING" },
          whatThisSlideReveals: { type: "STRING" },
        },
        required: ["selectedPageNumber", "whyThisSlide", "whatThisSlideReveals"],
      },
    },
  },
  required: ["companyName", "fiscalPeriod", "slides"],
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
You are an analyst for Points & Figures, a Zerodha newsletter.
Look at an investor presentation (provided as slide images) and pick the top 3 most insightful slides.

Selection rules:
1. Choose slides with material signal (business, sector, profitability, risks, long-term opportunity).
2. Prefer slides with measurable change (YoY, CAGR, segment/geography contrast).
3. Prioritize archetypes: market structure, unit economics, geo/customer mix, product mix, TAM + growth.
4. Ignore values/mission-only slides, decorative covers, awards, factory photos without data, and org charts.
5. Rank top 3 by materiality, signal-to-noise, and narrative clarity.

Output:
- Return one JSON object with companyName, fiscalPeriod, and slides.
- slides must contain exactly 3 objects.
- Each slide object includes selectedPageNumber (1-indexed), whyThisSlide, whatThisSlideReveals.
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

const parseErrorMessage = (payload: any, status: number): string => {
  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
    return payload.error.message;
  }
  return `Gemini request failed with status ${status}.`;
};

export const callGeminiJson = async (params: {
  apiKey: string;
  model: string;
  contents: unknown;
  responseSchema: unknown;
}): Promise<any> => {
  const { apiKey, model, contents, responseSchema } = params;
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
    throw new Error(parseErrorMessage(payload, response.status));
  }

  const text = parseGeminiText(payload);
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  try {
    return JSON.parse(stripJsonFence(text));
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }
};
