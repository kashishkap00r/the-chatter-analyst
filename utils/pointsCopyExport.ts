import type { PointsAndFiguresResult } from "../types";

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

const getDeterministicZerodhaUrl = (result: PointsAndFiguresResult): string => {
  const scrip = normalizeScrip(result.nseScrip);
  if (scrip) {
    return `https://zerodha.com/markets/stocks/NSE/${encodeURIComponent(scrip)}/`;
  }

  const fallbackUrl = normalizeValue(result.zerodhaStockUrl, "");
  return isHttpUrl(fallbackUrl) ? fallbackUrl : "";
};

const buildHeaderText = (result: PointsAndFiguresResult): string => {
  const company = normalizeValue(result.companyName);
  const marketCap = normalizeValue(result.marketCapCategory);
  const industry = normalizeValue(result.industry);
  return `${company} | ${marketCap} | ${industry}`;
};

const buildCompanyHtml = (result: PointsAndFiguresResult): string => {
  const heading = escapeHtml(buildHeaderText(result));
  const companyDescription = escapeHtml(normalizeValue(result.companyDescription, "Company description not available."));
  const zerodhaUrl = getDeterministicZerodhaUrl(result);

  const headingHtml = isHttpUrl(zerodhaUrl)
    ? `<a href="${escapeHtml(zerodhaUrl)}" style="color:#1155cc;text-decoration:underline;">${heading}</a>`
    : heading;

  const slidesHtml = result.slides
    .map((slide) => {
      const context = escapeHtml(normalizeValue(slide.context));
      const slideNumber = Number.isFinite(slide.selectedPageNumber) ? slide.selectedPageNumber : "N/A";
      const pageImage = normalizeValue(slide.pageAsImage, "");

      if (!pageImage || pageImage === FALLBACK_TEXT) {
        return [
          `<p style="margin:0 0 10px 40px;line-height:1.6;border-left:2px solid #9ca3af;padding-left:12px;">${context}</p>`,
          `<p style="margin:0 0 18px 40px;line-height:1.6;font-style:italic;">[Slide ${slideNumber}]</p>`,
        ].join("");
      }

      return [
        `<p style="margin:0 0 10px 40px;line-height:1.6;border-left:2px solid #9ca3af;padding-left:12px;">${context}</p>`,
        `<figure style="margin:0 0 18px 40px;">`,
        `<img src="${pageImage}" alt="Slide ${slideNumber}" style="display:block;max-width:720px;width:100%;height:auto;border:1px solid #d1d5db;border-radius:8px;" />`,
        `</figure>`,
      ].join("");
    })
    .join("");

  return [
    `<section style="font-family:Arial,sans-serif;color:#111827;">`,
    `<h2 style="font-size:24px;font-weight:400;margin:0 0 12px 0;">${headingHtml}</h2>`,
    `<p style="margin:0 0 12px 0;line-height:1.6;">${companyDescription}</p>`,
    `<p style="margin:0 0 16px 0;line-height:1.6;">[Presentation]</p>`,
    slidesHtml,
    `</section>`,
  ].join("");
};

const buildCompanyText = (result: PointsAndFiguresResult): string => {
  const header = buildHeaderText(result);
  const description = normalizeValue(result.companyDescription, "Company description not available.");

  const slideBlocks = result.slides.map((slide) => {
    const context = normalizeValue(slide.context);
    return `    ${context}\n    [Slide ${slide.selectedPageNumber}]`;
  });

  return [header, description, "[Presentation]", "", ...slideBlocks].join("\n");
};

export const buildPointsClipboardExport = (
  results: PointsAndFiguresResult[],
): { html: string; text: string } => {
  const validResults = results.filter((result) => result && Array.isArray(result.slides) && result.slides.length > 0);
  const dividerHtml = `<hr style="border:none;border-top:2px solid #6b7280;margin:28px 0;" />`;
  const dividerText = "\n============================================================\n";

  const html = validResults.map(buildCompanyHtml).join(dividerHtml);
  const text = validResults.map(buildCompanyText).join(dividerText);

  return { html, text };
};
