import {
  callGeminiJson,
  callOpenRouterJson,
  PLOTLINE_EXTRACT_PROMPT,
  PLOTLINE_EXTRACT_RESPONSE_SCHEMA,
} from '../../_shared/gemini';

interface PlotlineAnalyzeRequest {
  thesis: string;
  transcript: string;
  provider: 'gemini' | 'openrouter';
  model: string;
}

interface PlotlineQuoteRaw {
  quote: string;
  speakerName: string;
  speakerDesignation: string;
  periodLabel: string;
  periodSortKey: number;
}

interface PlotlineAnalyzeResponse {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  quotes: PlotlineQuoteRaw[];
}

const MAX_TRANSCRIPT_CHARS = 300_000;
const MAX_THESIS_CHARS = 2_000;

const DEDUPE_STRONG_SIMILARITY = 0.88;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been',
  'will', 'would', 'about', 'there', 'their', 'into', 'our', 'your',
  'which', 'while', 'were', 'are', 'has', 'had', 'also', 'just', 'more',
  'than', 'they', 'them', 'over', 'some', 'such',
]);

const toTokenSet = (text: string): Set<string> => {
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  return new Set(tokens.filter(t => t.length >= 3 && !STOP_WORDS.has(t)));
};

const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  const union = a.size + b.size - overlap;
  return union > 0 ? overlap / union : 0;
};

const dedupeQuotes = (quotes: PlotlineQuoteRaw[]): PlotlineQuoteRaw[] => {
  const deduped: PlotlineQuoteRaw[] = [];
  for (const candidate of quotes) {
    const candidateTokens = toTokenSet(candidate.quote);
    let isDuplicate = false;
    for (const existing of deduped) {
      if (jaccardSimilarity(candidateTokens, toTokenSet(existing.quote)) >= DEDUPE_STRONG_SIMILARITY) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) deduped.push(candidate);
  }
  return deduped;
};

const sanitizeString = (value: unknown, maxLen: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
};

const sanitizeNseScrip = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
};

const clampPeriodSortKey = (value: unknown): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(190001, Math.min(210012, Math.round(num)));
};

const sanitizeQuote = (raw: unknown): PlotlineQuoteRaw | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const quote = sanitizeString(r.quote, 1500);
  const speakerName = sanitizeString(r.speakerName, 200);
  const speakerDesignation = sanitizeString(r.speakerDesignation, 200);
  const periodLabel = sanitizeString(r.periodLabel, 30);
  const periodSortKey = clampPeriodSortKey(r.periodSortKey);
  if (!quote || !speakerName) return null;
  return { quote, speakerName, speakerDesignation, periodLabel, periodSortKey };
};

const buildUserContent = (thesis: string, transcript: string): string =>
  `THESIS\n${thesis}\n\nTRANSCRIPT\n${transcript}`;

export async function onRequestPost(context: any): Promise<Response> {
  const requestId = crypto.randomUUID().slice(0, 8);

  let body: PlotlineAnalyzeRequest;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { thesis, transcript, provider, model } = body;

  if (!thesis || typeof thesis !== 'string' || thesis.trim().length < 10) {
    return Response.json({ error: 'Thesis must be at least 10 characters.' }, { status: 400 });
  }
  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 100) {
    return Response.json({ error: 'Transcript must be at least 100 characters.' }, { status: 400 });
  }

  const clampedThesis = thesis.trim().slice(0, MAX_THESIS_CHARS);
  const clampedTranscript = transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  const userContent = buildUserContent(clampedThesis, clampedTranscript);

  let result: PlotlineAnalyzeResponse;

  try {
    if (provider === 'openrouter') {
      const apiKey = context.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return Response.json({ error: 'OpenRouter API key not configured.' }, { status: 500 });
      }
      result = await callOpenRouterJson({
        apiKey,
        model,
        messageContent: [
          { type: 'text', text: PLOTLINE_EXTRACT_PROMPT },
          { type: 'text', text: userContent },
        ],
        requestId,
        referer: context.env.OPENROUTER_SITE_URL,
        appTitle: context.env.OPENROUTER_APP_TITLE,
      });
    } else {
      const apiKey = context.env.GEMINI_API_KEY;
      if (!apiKey) {
        return Response.json({ error: 'Gemini API key not configured.' }, { status: 500 });
      }
      result = await callGeminiJson({
        apiKey,
        vertexApiKey: context.env.VERTEX_API_KEY,
        model,
        contents: [
          { role: 'user', parts: [{ text: PLOTLINE_EXTRACT_PROMPT + '\n\n' + userContent }] },
        ],
        responseSchema: PLOTLINE_EXTRACT_RESPONSE_SCHEMA,
        providerPreference: (context.env.GEMINI_PROVIDER as any) || 'ai_studio',
        requestId,
      });
    }
  } catch (error: any) {
    const message = error?.message || 'Unknown extraction error.';
    const isRetriable = /rate|limit|timeout|503|429|500/i.test(message);
    return Response.json(
      { error: message, retriable: isRetriable },
      { status: isRetriable ? 503 : 500 },
    );
  }

  const companyName = sanitizeString(result.companyName, 200);
  const fiscalPeriod = sanitizeString(result.fiscalPeriod, 30);
  const nseScrip = sanitizeNseScrip(result.nseScrip);
  const marketCapCategory = sanitizeString(result.marketCapCategory, 30);
  const industry = sanitizeString(result.industry, 100);

  const rawQuotes = Array.isArray(result.quotes) ? result.quotes : [];
  const sanitizedQuotes = rawQuotes.map(sanitizeQuote).filter((q): q is PlotlineQuoteRaw => q !== null);
  const dedupedQuotes = dedupeQuotes(sanitizedQuotes);

  return Response.json({
    companyName,
    fiscalPeriod,
    nseScrip,
    marketCapCategory,
    industry,
    quotes: dedupedQuotes,
  });
};
