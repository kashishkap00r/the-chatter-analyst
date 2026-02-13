import type { ChatterAnalysisResult } from "../types";

const FALLBACK_TEXT = "N/A";

const normalizeValue = (value: string | undefined, fallback = FALLBACK_TEXT): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const normalizeScrip = (value: string | undefined): string =>
  normalizeValue(value, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const getDeterministicZerodhaUrl = (result: ChatterAnalysisResult): string => {
  const scrip = normalizeScrip(result.nseScrip);
  if (scrip) {
    return `https://zerodha.com/markets/stocks/NSE/${encodeURIComponent(scrip)}/`;
  }
  const fallbackUrl = normalizeValue(result.zerodhaStockUrl, "");
  return isHttpUrl(fallbackUrl) ? fallbackUrl : "";
};

const getSpeakerLine = (name: string, designation: string): string => {
  const normalizedName = normalizeValue(name);
  const normalizedDesignation = normalizeValue(designation);

  if (normalizedName === FALLBACK_TEXT && normalizedDesignation === FALLBACK_TEXT) {
    return "— N/A";
  }

  if (normalizedDesignation === FALLBACK_TEXT) {
    return `— ${normalizedName}`;
  }

  return `— ${normalizedName}, ${normalizedDesignation}`;
};

const buildHeaderText = (result: ChatterAnalysisResult): string => {
  const company = normalizeValue(result.companyName);
  const marketCap = normalizeValue(result.marketCapCategory);
  const industry = normalizeValue(result.industry);
  return `${company} | ${marketCap} | ${industry}`;
};

const buildCompanyHtml = (result: ChatterAnalysisResult): string => {
  const heading = escapeHtml(buildHeaderText(result));
  const companyDescription = escapeHtml(normalizeValue(result.companyDescription, "Company description not available."));
  const zerodhaUrl = getDeterministicZerodhaUrl(result);
  const concallUrl = normalizeValue(result.concallUrl);
  const headingHtml = isHttpUrl(zerodhaUrl)
    ? `<a href="${escapeHtml(zerodhaUrl)}" style="color:#1155cc;text-decoration:underline;">${heading}</a>`
    : heading;
  const concallHtml = isHttpUrl(concallUrl)
    ? `[<a href="${escapeHtml(concallUrl)}" style="color:#1155cc;text-decoration:underline;">Concall</a>]`
    : `[Concall]`;

  const quotesHtml = result.quotes
    .map((quote) => {
      const summary = escapeHtml(normalizeValue(quote.summary));
      const rawQuote = escapeHtml(normalizeValue(quote.quote));
      const speakerLine = escapeHtml(getSpeakerLine(quote.speaker?.name, quote.speaker?.designation));

      return [
        `<p style="margin:0 0 12px 0;line-height:1.6;">${summary}</p>`,
        `<p style="margin:0 0 8px 40px;line-height:1.6;font-style:italic;">"${rawQuote}"</p>`,
        `<p style="margin:0 0 16px 40px;line-height:1.6;font-style:italic;">${speakerLine}</p>`,
      ].join("");
    })
    .join("");

  return [
    `<section style="font-family:Arial,sans-serif;color:#111827;">`,
    `<h2 style="font-size:24px;font-weight:400;margin:0 0 12px 0;">${headingHtml}</h2>`,
    `<p style="margin:0 0 12px 0;line-height:1.6;">${companyDescription}</p>`,
    `<p style="margin:0 0 14px 0;line-height:1.6;">${concallHtml}</p>`,
    quotesHtml,
    `</section>`,
  ].join("");
};

const buildCompanyText = (result: ChatterAnalysisResult): string => {
  const header = buildHeaderText(result);
  const description = normalizeValue(result.companyDescription, "Company description not available.");
  const concallUrl = normalizeValue(result.concallUrl);
  const concallLine = isHttpUrl(concallUrl) ? `[Concall] ${concallUrl}` : `[Concall]`;

  const quoteBlocks = result.quotes.map((quote) => {
    const summary = normalizeValue(quote.summary);
    const textQuote = normalizeValue(quote.quote);
    const speakerLine = getSpeakerLine(quote.speaker?.name, quote.speaker?.designation);
    return `${summary}\n\n    "${textQuote}"\n    ${speakerLine}`;
  });

  return [header, description, concallLine, "", ...quoteBlocks].join("\n");
};

export const buildChatterClipboardExport = (
  results: ChatterAnalysisResult[],
): { html: string; text: string } => {
  const validResults = results.filter((result) => result && Array.isArray(result.quotes));
  const dividerHtml = `<hr style="border:none;border-top:1px solid #a0a0a0;margin:28px 0;" />`;
  const dividerText = "\n------------------------------------------------------------\n";

  const html = validResults.map(buildCompanyHtml).join(dividerHtml);
  const text = validResults.map(buildCompanyText).join(dividerText);

  return { html, text };
};
