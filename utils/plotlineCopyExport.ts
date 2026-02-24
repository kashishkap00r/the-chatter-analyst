import type { PlotlineCompanyResult, PlotlineSummaryResult } from "../types";

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
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const normalizeScrip = (value: string | undefined): string =>
  normalizeValue(value, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const buildCompanyHeader = (company: PlotlineCompanyResult): string => {
  const name = normalizeValue(company.companyName);
  const marketCap = normalizeValue(company.marketCapCategory);
  const industry = normalizeValue(company.industry);
  return `${name} | ${marketCap} | ${industry}`;
};

const getZerodhaUrl = (company: PlotlineCompanyResult): string => {
  const scrip = normalizeScrip(company.nseScrip);
  if (!scrip) return "";
  return `https://zerodha.com/markets/stocks/NSE/${encodeURIComponent(scrip)}/`;
};

const buildSpeakerLine = (name: string, designation: string): string => {
  const normalizedName = normalizeValue(name);
  const normalizedDesignation = normalizeValue(designation);
  if (normalizedDesignation === FALLBACK_TEXT) return `— ${normalizedName}`;
  return `— ${normalizedName}, ${normalizedDesignation}`;
};

const buildCompanyHtml = (company: PlotlineCompanyResult): string => {
  const headingText = escapeHtml(buildCompanyHeader(company));
  const companyDescription = escapeHtml(normalizeValue(company.companyDescription, "Company description not available."));
  const companyNarrative = escapeHtml(normalizeValue(company.companyNarrative, "Narrative not available."));
  const zerodhaUrl = getZerodhaUrl(company);
  const headingHtml = zerodhaUrl
    ? `<a href="${escapeHtml(zerodhaUrl)}" style="color:#1155cc;text-decoration:underline;">${headingText}</a>`
    : headingText;

  const quotesHtml = company.quotes
    .map((quote) => {
      const quoteText = escapeHtml(normalizeValue(quote.quote));
      const periodLabel = escapeHtml(normalizeValue(quote.periodLabel, "Unknown Period"));
      const matchedKeywords = quote.matchedKeywords.length > 0 ? quote.matchedKeywords.join(", ") : "N/A";
      const speakerLine = escapeHtml(buildSpeakerLine(quote.speakerName, quote.speakerDesignation));
      return [
        `<p style="margin:0 0 8px 0;color:#374151;font-size:12px;">${periodLabel} | ${escapeHtml(matchedKeywords)}</p>`,
        `<p style="margin:0 0 8px 36px;line-height:1.6;font-style:italic;">"${quoteText}"</p>`,
        `<p style="margin:0 0 14px 36px;line-height:1.6;font-style:italic;">${speakerLine}</p>`,
      ].join("");
    })
    .join("");

  return [
    `<section style="font-family:Arial,sans-serif;color:#111827;">`,
    `<h2 style="font-size:24px;font-weight:400;margin:0 0 12px 0;">${headingHtml}</h2>`,
    `<p style="margin:0 0 10px 0;line-height:1.6;">${companyDescription}</p>`,
    `<p style="margin:0 0 14px 0;line-height:1.6;">${companyNarrative}</p>`,
    quotesHtml,
    `</section>`,
  ].join("");
};

const buildCompanyText = (company: PlotlineCompanyResult): string => {
  const lines: string[] = [];
  lines.push(buildCompanyHeader(company));
  lines.push(normalizeValue(company.companyDescription, "Company description not available."));
  lines.push(normalizeValue(company.companyNarrative, "Narrative not available."));
  lines.push("");

  for (const quote of company.quotes) {
    const keywordLine = quote.matchedKeywords.length > 0 ? quote.matchedKeywords.join(", ") : "N/A";
    lines.push(`${normalizeValue(quote.periodLabel, "Unknown Period")} | ${keywordLine}`);
    lines.push(`    "${normalizeValue(quote.quote)}"`);
    lines.push(`    ${buildSpeakerLine(quote.speakerName, quote.speakerDesignation)}`);
    lines.push("");
  }

  return lines.join("\n").trim();
};

const buildThemeHtml = (summary: PlotlineSummaryResult): string => {
  if (!Array.isArray(summary.masterThemeBullets) || summary.masterThemeBullets.length === 0) {
    return "";
  }

  const keywordTitle = summary.keywords.length > 0 ? summary.keywords.join(", ") : "Theme";
  const bulletsHtml = summary.masterThemeBullets
    .map((bullet) => `<li style="margin:0 0 6px 0;line-height:1.5;">${escapeHtml(bullet)}</li>`)
    .join("");

  return [
    `<section style="font-family:Arial,sans-serif;color:#111827;">`,
    `<h2 style="font-size:22px;font-weight:600;margin:0 0 10px 0;">Plotline Theme: ${escapeHtml(keywordTitle)}</h2>`,
    `<ul style="margin:0 0 18px 20px;padding:0;">${bulletsHtml}</ul>`,
    `</section>`,
  ].join("");
};

const buildThemeText = (summary: PlotlineSummaryResult): string => {
  if (!Array.isArray(summary.masterThemeBullets) || summary.masterThemeBullets.length === 0) {
    return "";
  }
  const keywordTitle = summary.keywords.length > 0 ? summary.keywords.join(", ") : "Theme";
  const bulletLines = summary.masterThemeBullets.map((bullet) => `- ${bullet}`);
  return [`Plotline Theme: ${keywordTitle}`, ...bulletLines, ""].join("\n");
};

export const buildPlotlineClipboardExport = (
  summary: PlotlineSummaryResult,
): { html: string; text: string } => {
  const companies = Array.isArray(summary.companies)
    ? summary.companies.filter((company) => company && Array.isArray(company.quotes) && company.quotes.length > 0)
    : [];

  const dividerHtml = `<hr style="border:none;border-top:1px solid #9ca3af;margin:24px 0;" />`;
  const dividerText = "\n------------------------------------------------------------\n";

  const htmlParts = [buildThemeHtml(summary), ...companies.map((company) => buildCompanyHtml(company))].filter(Boolean);
  const textParts = [buildThemeText(summary), ...companies.map((company) => buildCompanyText(company))].filter(Boolean);

  return {
    html: htmlParts.join(dividerHtml),
    text: textParts.join(dividerText),
  };
};
