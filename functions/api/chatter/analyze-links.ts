import { callGeminiJson, CHATTER_PROMPT, CHATTER_RESPONSE_SCHEMA } from "../../_shared/gemini";

interface Env {
  GEMINI_API_KEY?: string;
}

interface ChatterAnalysisResult {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  zerodhaStockUrl: string;
  concallUrl: string;
  quotes: Array<{
    quote: string;
    summary: string;
    speaker: {
      name: string;
      designation: string;
    };
    category: string;
  }>;
}

interface LinkFailure {
  link: string;
  reason: string;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LINKS = 25;
const MAX_LINK_LENGTH = 2000;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const DEFAULT_MODEL = "gemini-2.5-flash";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-3-pro-preview"]);

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

const error = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status);

const toStringValue = (value: unknown, fallback = "N/A"): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
};

const normalizeScrip = (value: unknown): string =>
  toStringValue(value, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const buildZerodhaUrl = (nseScrip: string): string =>
  `https://zerodha.com/markets/stocks/NSE/${encodeURIComponent(nseScrip)}/`;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const extractMessage = (err: unknown): string => {
  const message = String((err as any)?.message || "Unknown error");
  return message.trim() || "Unknown error";
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const fetchPdfAsBase64 = async (link: string): Promise<{ base64: string; resolvedUrl: string }> => {
  const response = await fetch(link, {
    method: "GET",
    headers: {
      accept: "application/pdf,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`URL fetch failed with status ${response.status}.`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = Number(contentLengthHeader || "0");
  if (contentLength > MAX_PDF_BYTES) {
    throw new Error("PDF is too large (max 15MB).");
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const resolvedUrl = response.url || link;
  const looksLikePdf =
    contentType.includes("pdf") || new URL(resolvedUrl).pathname.toLowerCase().endsWith(".pdf");

  if (!looksLikePdf) {
    throw new Error("URL does not appear to be a direct PDF transcript.");
  }

  const pdfBuffer = await response.arrayBuffer();
  if (pdfBuffer.byteLength === 0) {
    throw new Error("Downloaded PDF is empty.");
  }
  if (pdfBuffer.byteLength > MAX_PDF_BYTES) {
    throw new Error("PDF is too large (max 15MB).");
  }

  return {
    base64: arrayBufferToBase64(pdfBuffer),
    resolvedUrl,
  };
};

const buildResult = (analysis: any, concallUrl: string): ChatterAnalysisResult => {
  const nseScrip = normalizeScrip(analysis?.nseScrip);
  if (!nseScrip) {
    throw new Error("Missing or invalid NSE scrip in model response.");
  }

  const quotes = Array.isArray(analysis?.quotes) ? analysis.quotes : [];
  if (quotes.length === 0) {
    throw new Error("No quotes were extracted.");
  }

  return {
    companyName: toStringValue(analysis?.companyName),
    fiscalPeriod: toStringValue(analysis?.fiscalPeriod),
    nseScrip,
    marketCapCategory: toStringValue(analysis?.marketCapCategory),
    industry: toStringValue(analysis?.industry),
    companyDescription: toStringValue(analysis?.companyDescription, "Company description not available."),
    zerodhaStockUrl: buildZerodhaUrl(nseScrip),
    concallUrl,
    quotes,
  };
};

export async function onRequestPost(context: any): Promise<Response> {
  const request = context.request as Request;
  const env = context.env as Env;

  if (!env?.GEMINI_API_KEY) {
    return error(500, "INTERNAL", "Server is missing GEMINI_API_KEY.");
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return error(413, "BAD_REQUEST", "Request body is too large.");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return error(400, "BAD_REQUEST", "Request body must be valid JSON.");
  }

  const model = typeof body?.model === "string" ? body.model : DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) {
    return error(400, "BAD_REQUEST", "Field 'model' is invalid.");
  }

  const links = Array.isArray(body?.links) ? body.links : [];
  if (links.length === 0) {
    return error(400, "BAD_REQUEST", "Field 'links' is required.");
  }
  if (links.length > MAX_LINKS) {
    return error(400, "BAD_REQUEST", `A maximum of ${MAX_LINKS} links is supported per run.`);
  }

  const normalizedLinks: string[] = [];
  for (const value of links) {
    const link = typeof value === "string" ? value.trim() : "";
    if (!link || link.length > MAX_LINK_LENGTH || !isHttpUrl(link)) {
      return error(400, "BAD_REQUEST", "All links must be valid http/https URLs.");
    }
    normalizedLinks.push(link);
  }

  const results: ChatterAnalysisResult[] = [];
  const failures: LinkFailure[] = [];

  for (const link of normalizedLinks) {
    try {
      const { base64, resolvedUrl } = await fetchPdfAsBase64(link);
      const analysis = await callGeminiJson({
        apiKey: env.GEMINI_API_KEY,
        model,
        contents: [
          {
            parts: [
              { text: `${CHATTER_PROMPT}\n\nINPUT: Earnings call transcript PDF.` },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: base64,
                },
              },
            ],
          },
        ],
        responseSchema: CHATTER_RESPONSE_SCHEMA,
      });
      results.push(buildResult(analysis, resolvedUrl));
    } catch (err: any) {
      failures.push({
        link,
        reason: extractMessage(err),
      });
    }
  }

  return json({ results, failures });
}
