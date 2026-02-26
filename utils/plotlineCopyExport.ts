import type { PlotlineSummaryResult, PlotlineStorySection } from "../types";

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

const buildSpeakerLine = (name: string, designation: string): string => {
  const normalizedName = normalizeValue(name);
  const normalizedDesignation = normalizeValue(designation);
  if (normalizedDesignation === FALLBACK_TEXT) return `— ${normalizedName}`;
  return `— ${normalizedName}, ${normalizedDesignation}`;
};

const buildStoryHeaderHtml = (summary: PlotlineSummaryResult): string =>
  [
    `<section style="font-family:Arial,sans-serif;color:#111827;">`,
    `<h1 style="font-size:28px;line-height:1.3;font-weight:600;margin:0 0 8px 0;">${escapeHtml(normalizeValue(summary.title, "Plotline"))}</h1>`,
    `<p style="margin:0;line-height:1.65;color:#4b5563;">${escapeHtml(normalizeValue(summary.dek, ""))}</p>`,
    `</section>`,
  ].join("");

const buildStoryHeaderText = (summary: PlotlineSummaryResult): string =>
  [normalizeValue(summary.title, "Plotline"), normalizeValue(summary.dek, ""), ""].join("\n");

const buildSectionHtml = (section: PlotlineStorySection, index: number): string => {
  const paragraphsHtml = section.narrativeParagraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 10px 0;line-height:1.7;color:#1f2937;">${escapeHtml(normalizeValue(paragraph, ""))}</p>`,
    )
    .join("");

  const quotesHtml = section.quoteBlocks
    .map((quote) => {
      const periodLabel = escapeHtml(normalizeValue(quote.periodLabel, "Unknown Period"));
      const quoteText = escapeHtml(normalizeValue(quote.quote));
      const speakerLine = escapeHtml(buildSpeakerLine(quote.speakerName, quote.speakerDesignation));
      return [
        `<p style="margin:0 0 8px 0;color:#4b5563;font-size:12px;">${periodLabel}</p>`,
        `<p style="margin:0 0 8px 36px;line-height:1.6;font-style:italic;">"${quoteText}"</p>`,
        `<p style="margin:0 0 14px 36px;line-height:1.6;font-style:italic;">${speakerLine}</p>`,
      ].join("");
    })
    .join("");

  return [
    `<section style="font-family:Arial,sans-serif;color:#111827;">`,
    `<p style="margin:0 0 6px 0;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">Section ${index + 1}</p>`,
    `<h2 style="font-size:24px;font-weight:500;margin:0 0 8px 0;">${escapeHtml(normalizeValue(section.companyName))}</h2>`,
    `<p style="margin:0 0 14px 0;color:#4b5563;line-height:1.6;">${escapeHtml(normalizeValue(section.subhead, ""))}</p>`,
    paragraphsHtml,
    quotesHtml,
    `</section>`,
  ].join("");
};

const buildSectionText = (section: PlotlineStorySection, index: number): string => {
  const lines: string[] = [];
  lines.push(`Section ${index + 1}`);
  lines.push(normalizeValue(section.companyName));
  lines.push(normalizeValue(section.subhead, ""));
  lines.push("");

  for (const paragraph of section.narrativeParagraphs) {
    lines.push(normalizeValue(paragraph, ""));
    lines.push("");
  }

  for (const quote of section.quoteBlocks) {
    lines.push(normalizeValue(quote.periodLabel, "Unknown Period"));
    lines.push(`    "${normalizeValue(quote.quote)}"`);
    lines.push(`    ${buildSpeakerLine(quote.speakerName, quote.speakerDesignation)}`);
    lines.push("");
  }

  return lines.join("\n").trim();
};

const buildWatchlistHtml = (summary: PlotlineSummaryResult): string => {
  if (!Array.isArray(summary.closingWatchlist) || summary.closingWatchlist.length === 0) {
    return "";
  }

  const listItems = summary.closingWatchlist
    .map((line) => `<li style="margin:0 0 6px 0;line-height:1.6;">${escapeHtml(normalizeValue(line, ""))}</li>`)
    .join("");

  return [
    `<section style="font-family:Arial,sans-serif;color:#111827;">`,
    `<h2 style="font-size:22px;font-weight:600;margin:0 0 10px 0;">What to Watch</h2>`,
    `<ul style="margin:0 0 4px 20px;padding:0;">${listItems}</ul>`,
    `</section>`,
  ].join("");
};

const buildWatchlistText = (summary: PlotlineSummaryResult): string => {
  if (!Array.isArray(summary.closingWatchlist) || summary.closingWatchlist.length === 0) {
    return "";
  }

  return ["What to Watch", ...summary.closingWatchlist.map((line) => `- ${normalizeValue(line, "")}`), ""].join("\n");
};

export const buildPlotlineClipboardExport = (
  summary: PlotlineSummaryResult,
): { html: string; text: string } => {
  const sections = Array.isArray(summary.sections)
    ? summary.sections.filter(
        (section) =>
          section &&
          Array.isArray(section.narrativeParagraphs) &&
          section.narrativeParagraphs.length > 0 &&
          Array.isArray(section.quoteBlocks) &&
          section.quoteBlocks.length > 0,
      )
    : [];

  const dividerHtml = `<hr style="border:none;border-top:1px solid #9ca3af;margin:24px 0;" />`;
  const dividerText = "\n------------------------------------------------------------\n";

  const htmlParts = [
    buildStoryHeaderHtml(summary),
    ...sections.map((section, index) => buildSectionHtml(section, index)),
    buildWatchlistHtml(summary),
  ].filter(Boolean);

  const textParts = [
    buildStoryHeaderText(summary),
    ...sections.map((section, index) => buildSectionText(section, index)),
    buildWatchlistText(summary),
  ].filter(Boolean);

  return {
    html: htmlParts.join(dividerHtml),
    text: textParts.join(dividerText),
  };
};
