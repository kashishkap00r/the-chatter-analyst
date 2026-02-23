interface ThreadQuoteCandidate {
  id: string;
  companyName: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  summary: string;
  quote: string;
  speakerName: string;
  speakerDesignation: string;
  sourceOrder: number;
}

interface ThreadCompanyGroup {
  companyName: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  quotes: ThreadQuoteCandidate[];
}

interface ThreadEditionSource {
  editionTitle: string;
  editionUrl?: string;
  editionDate?: string;
  companiesCovered?: number;
  industriesCovered?: number;
  sourceKind: "substack_url" | "pdf_text";
  companies: ThreadCompanyGroup[];
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_HTML_BYTES = 6 * 1024 * 1024;
const MAX_EDITION_TEXT_CHARS = 2_000_000;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

const error = (status: number, code: string, message: string, reasonCode?: string, details?: unknown): Response =>
  json({ error: { code, message, reasonCode, details } }, status);

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, num) => {
      const parsed = Number(num);
      if (!Number.isFinite(parsed)) return _;
      try {
        return String.fromCodePoint(parsed);
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const parsed = Number.parseInt(hex, 16);
      if (!Number.isFinite(parsed)) return _;
      try {
        return String.fromCodePoint(parsed);
      } catch {
        return _;
      }
    });

const convertHtmlToPlainText = (html: string): string => {
  let normalized = html;
  normalized = normalized.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  normalized = normalized.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  normalized = normalized.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  normalized = normalized.replace(/<br\s*\/?\s*>/gi, "\n");
  normalized = normalized.replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|blockquote)>/gi, "\n");
  normalized = normalized.replace(/<li\b[^>]*>/gi, "\n• ");
  normalized = normalized.replace(/<[^>]+>/g, " ");
  normalized = decodeHtmlEntities(normalized);
  normalized = normalized.replace(/\r/g, "");
  normalized = normalized.replace(/\t/g, " ");
  normalized = normalized.replace(/[ ]{2,}/g, " ");
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return normalized.trim();
};

const extractEmbeddedBodyHtml = (html: string): string | null => {
  const bodyHtmlMatch = html.match(/"body_html"\s*:\s*"([\s\S]*?)"\s*,\s*"body_markdown"/i);
  if (!bodyHtmlMatch) {
    return null;
  }

  const escapedHtml = bodyHtmlMatch[1];
  const unescaped = escapedHtml
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\n/g, "\n")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');

  return unescaped;
};

const normalizeTextInput = (value: string): string =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const companyHeaderRegex = /^(.+?)\s*\|\s*(Large Cap|Mid Cap|Small Cap|Micro Cap)\s*\|\s*(.+)$/i;
const speakerLineRegex = /^[-]\s*(.+)$/;

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const cleanupParagraph = (value: string): string =>
  value
    .replace(/[ ]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

const extractQuotedText = (raw: string): string => {
  const singleLine = cleanupParagraph(raw.replace(/\n/g, " "));
  const quotedMatch = singleLine.match(/"([\s\S]*?)"/);
  if (quotedMatch && quotedMatch[1]) {
    return cleanupParagraph(quotedMatch[1]);
  }
  return cleanupParagraph(singleLine.replace(/^"/, "").replace(/"$/, ""));
};

const extractEditionTitle = (lines: string[]): string => {
  const chatterLine = lines.find((line) => /the chatter/i.test(line));
  if (chatterLine) {
    return chatterLine.slice(0, 140);
  }
  const first = lines[0] || "The Chatter";
  return first.slice(0, 140);
};

const extractEditionDate = (lines: string[]): string | undefined => {
  const dateRegex = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i;
  const hit = lines.find((line) => dateRegex.test(line));
  if (!hit) return undefined;
  const match = hit.match(dateRegex);
  return match ? match[0] : undefined;
};

const extractCoverageStats = (text: string): { companiesCovered?: number; industriesCovered?: number } => {
  const match = text.match(/covered\s+(\d+)\s+companies?\s+across\s+(\d+)\s+industr/i);
  if (!match) return {};

  const companiesCovered = Number(match[1]);
  const industriesCovered = Number(match[2]);

  return {
    companiesCovered: Number.isFinite(companiesCovered) ? companiesCovered : undefined,
    industriesCovered: Number.isFinite(industriesCovered) ? industriesCovered : undefined,
  };
};

const looksLikeNoiseHeading = (line: string): boolean => {
  if (!line) return true;
  if (/^\d+\s*\/\s*\d+$/.test(line)) return true;
  if (/^(fmcg|it|energy|healthcare|retail|diversified|auto ancillary|engineering|capital goods)$/i.test(line)) {
    return true;
  }
  if (line.length < 4) return true;
  return false;
};

const isConcallLine = (line: string): boolean => /\bconcall\b/i.test(line);
const looksLikeQuoteStart = (line: string): boolean => line.includes('"');
const inlineSpeakerRegex = /^(.*")\s*-\s*([^"].+)$/;

const parseSpeaker = (line: string): { speakerName: string; speakerDesignation: string } => {
  const speakerRaw = line.replace(speakerLineRegex, "$1").trim();
  if (!speakerRaw) {
    return { speakerName: "Management", speakerDesignation: "Management" };
  }

  const commaIndex = speakerRaw.indexOf(",");
  if (commaIndex === -1) {
    return {
      speakerName: speakerRaw.slice(0, 80),
      speakerDesignation: "Management",
    };
  }

  const speakerName = cleanupParagraph(speakerRaw.slice(0, commaIndex)).slice(0, 80) || "Management";
  const speakerDesignation = cleanupParagraph(speakerRaw.slice(commaIndex + 1)).slice(0, 180) || "Management";
  return { speakerName, speakerDesignation };
};

const parseCompanyQuotes = (
  lines: string[],
  base: {
    companyName: string;
    marketCapCategory: string;
    industry: string;
    companyDescription: string;
  },
  startingOrder: number,
): { quotes: ThreadQuoteCandidate[]; nextOrder: number } => {
  const quotes: ThreadQuoteCandidate[] = [];
  const seenQuotes = new Set<string>();

  let summaryBuffer: string[] = [];
  let quoteBuffer: string[] | null = null;
  let sourceOrder = startingOrder;
  const pushQuote = (quoteRaw: string, speakerRaw: string) => {
    const quoteText = extractQuotedText(quoteRaw);
    if (!quoteText || seenQuotes.has(quoteText.toLowerCase())) {
      return;
    }

    const speaker = parseSpeaker(`- ${speakerRaw}`);
    const summaryText = cleanupParagraph(summaryBuffer.join(" "));
    const quoteId = `${slugify(base.companyName)}-${sourceOrder}`;
    quotes.push({
      id: quoteId,
      companyName: base.companyName,
      marketCapCategory: base.marketCapCategory,
      industry: base.industry,
      companyDescription: base.companyDescription,
      summary: summaryText || "Management highlighted a business signal worth tracking.",
      quote: quoteText,
      speakerName: speaker.speakerName,
      speakerDesignation: speaker.speakerDesignation,
      sourceOrder,
    });
    seenQuotes.add(quoteText.toLowerCase());
    sourceOrder += 1;
    summaryBuffer = [];
  };

  for (const rawLine of lines) {
    const line = cleanupParagraph(rawLine);
    if (!line) continue;
    if (isConcallLine(line)) continue;

    const speakerMatch = line.match(speakerLineRegex);
    if (speakerMatch && quoteBuffer && quoteBuffer.length > 0) {
      pushQuote(quoteBuffer.join(" "), speakerMatch[1]);
      quoteBuffer = null;
      continue;
    }

    if (quoteBuffer) {
      const inlineSpeaker = line.match(inlineSpeakerRegex);
      if (inlineSpeaker) {
        quoteBuffer.push(inlineSpeaker[1]);
        pushQuote(quoteBuffer.join(" "), inlineSpeaker[2]);
        quoteBuffer = null;
        continue;
      }
      quoteBuffer.push(line);
      continue;
    }

    if (looksLikeQuoteStart(line)) {
      const inlineSpeaker = line.match(inlineSpeakerRegex);
      if (inlineSpeaker) {
        pushQuote(inlineSpeaker[1], inlineSpeaker[2]);
        continue;
      }
      quoteBuffer = [line];
      continue;
    }

    summaryBuffer.push(line);
    if (summaryBuffer.length > 5) {
      summaryBuffer = summaryBuffer.slice(summaryBuffer.length - 5);
    }
  }

  return {
    quotes,
    nextOrder: sourceOrder,
  };
};

const parseThreadEdition = (
  rawText: string,
  metadata: {
    editionUrl?: string;
    sourceKind: "substack_url" | "pdf_text";
  },
): ThreadEditionSource => {
  const normalizedText = normalizeTextInput(rawText).slice(0, MAX_EDITION_TEXT_CHARS);
  const lines = normalizedText
    .split("\n")
    .map((line) => cleanupParagraph(line))
    .filter((line) => line.length > 0);

  const editionTitle = extractEditionTitle(lines);
  const editionDate = extractEditionDate(lines);
  const coverageStats = extractCoverageStats(normalizedText);

  const companyLineIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (companyHeaderRegex.test(lines[i])) {
      companyLineIndexes.push(i);
    }
  }

  const companies: ThreadCompanyGroup[] = [];
  let sourceOrder = 1;

  for (let index = 0; index < companyLineIndexes.length; index++) {
    const headerIndex = companyLineIndexes[index];
    const nextHeaderIndex = companyLineIndexes[index + 1] ?? lines.length;
    const headerLine = lines[headerIndex];
    const headerMatch = headerLine.match(companyHeaderRegex);
    if (!headerMatch) continue;

    const companyName = cleanupParagraph(headerMatch[1]);
    const marketCapCategory = cleanupParagraph(headerMatch[2]);
    const industry = cleanupParagraph(headerMatch[3]);

    const sectionLines = lines.slice(headerIndex + 1, nextHeaderIndex);

    const concallIndex = sectionLines.findIndex((line) => isConcallLine(line));
    const descriptionLines = sectionLines
      .slice(0, concallIndex >= 0 ? concallIndex : Math.min(sectionLines.length, 4))
      .filter((line) => !looksLikeNoiseHeading(line));
    const companyDescription = cleanupParagraph(descriptionLines.join(" ")) || "Company overview not available.";

    const quoteRegionStart = concallIndex >= 0 ? concallIndex + 1 : 0;
    const quoteRegion = sectionLines.slice(quoteRegionStart);

    const base = {
      companyName,
      marketCapCategory,
      industry,
      companyDescription,
    };

    const parsed = parseCompanyQuotes(quoteRegion, base, sourceOrder);
    sourceOrder = parsed.nextOrder;

    if (parsed.quotes.length === 0) {
      continue;
    }

    companies.push({
      ...base,
      quotes: parsed.quotes,
    });
  }

  return {
    editionTitle,
    editionUrl: metadata.editionUrl,
    editionDate,
    companiesCovered: coverageStats.companiesCovered,
    industriesCovered: coverageStats.industriesCovered,
    sourceKind: metadata.sourceKind,
    companies,
  };
};

const fetchTextFromUrl = async (substackUrl: string): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 20_000);

  try {
    const response = await fetch(substackUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ChatterAnalystBot/1.0)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Unable to fetch URL. Status ${response.status}.`);
    }

    const html = await response.text();
    if (!html.trim()) {
      throw new Error("Fetched page is empty.");
    }

    if (html.length > MAX_REMOTE_HTML_BYTES) {
      throw new Error("Fetched page is too large to process.");
    }

    const articleMatch = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i);
    const embeddedBodyHtml = extractEmbeddedBodyHtml(html);

    const candidate = articleMatch?.[0] || embeddedBodyHtml || html;
    return convertHtmlToPlainText(candidate);
  } finally {
    clearTimeout(timeout);
  }
};

export async function onRequestPost(context: any): Promise<Response> {
  const request = context.request as Request;

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

  const substackUrl = hasNonEmptyString(body?.substackUrl) ? body.substackUrl.trim() : "";
  const editionText = hasNonEmptyString(body?.editionText) ? body.editionText.trim() : "";

  if (!substackUrl && !editionText) {
    return error(
      400,
      "BAD_REQUEST",
      "Provide either 'substackUrl' or 'editionText'.",
      "MISSING_INPUT",
    );
  }

  if (substackUrl && !isHttpUrl(substackUrl)) {
    return error(400, "BAD_REQUEST", "Field 'substackUrl' must be a valid HTTP(S) URL.", "INVALID_URL");
  }

  try {
    const sourceText = substackUrl ? await fetchTextFromUrl(substackUrl) : editionText;
    const parsed = parseThreadEdition(sourceText, {
      editionUrl: substackUrl || undefined,
      sourceKind: substackUrl ? "substack_url" : "pdf_text",
    });

    const totalQuotes = parsed.companies.reduce((sum, company) => sum + company.quotes.length, 0);

    if (parsed.companies.length === 0 || totalQuotes === 0) {
      return error(
        422,
        "VALIDATION_FAILED",
        "Could not extract company quote blocks from this edition source.",
        "THREAD_PARSE_EMPTY",
      );
    }

    return json(parsed);
  } catch (ingestError: any) {
    const message = String(ingestError?.message || "Failed to ingest thread source.");
    return error(424, "UPSTREAM_FAILED", message, "THREAD_INGEST_FAILED");
  }
}
