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
    marketCapCategory: { type: "STRING" },
    industry: { type: "STRING" },
    companyDescription: { type: "STRING" },
    zerodhaStockUrl: { type: "STRING" },
    concallUrl: { type: "STRING" },
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
    "marketCapCategory",
    "industry",
    "companyDescription",
    "zerodhaStockUrl",
    "concallUrl",
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
1. Identify the Company Name and the Fiscal Period (for example, "Q3 FY25").
2. Determine the market cap category and industry as shown on Zerodha stock pages.
3. Provide a concise 2-sentence description of the company.
4. Provide a canonical Zerodha stock URL and a concall transcript URL.
5. Extract no more than twenty management remarks that are material to investors.
6. Ensure at least five of these remarks are from management answers in the Q&A section.
7. For each remark, provide:
   a. The verbatim quote.
   b. A one-sentence summary of the implication for an investor.
   c. Speaker name and designation.

RULES
- Prioritize insightful answers to analyst questions from Q&A.
- Prioritize surprise factors and strategic shifts.
- Use market cap labels like Large Cap, Mid Cap, Small Cap, or Micro Cap.
- Keep companyDescription factual and concise.
- zerodhaStockUrl and concallUrl must be absolute https URLs. If unknown, return "N/A".
- Return valid JSON only.
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
