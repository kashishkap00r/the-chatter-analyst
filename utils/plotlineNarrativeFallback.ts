import type { PlotlineQuoteMatch } from "../types";

const firstNonEmpty = (...values: Array<string | undefined>): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const buildTopKeywords = (quotes: PlotlineQuoteMatch[], fallbackKeywords: string[]): string[] => {
  const counts = new Map<string, number>();

  for (const quote of quotes) {
    for (const keyword of quote.matchedKeywords || []) {
      const normalized = keyword.trim();
      if (!normalized) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }

  if (counts.size === 0) {
    return fallbackKeywords.slice(0, 2);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([keyword]) => keyword);
};

export const buildPlotlineNarrativeFallback = (
  companyName: string,
  quotes: PlotlineQuoteMatch[],
  fallbackKeywords: string[] = [],
): string => {
  const safeCompany = firstNonEmpty(companyName, "This company");
  const validQuotes = Array.isArray(quotes) ? quotes : [];
  const topKeywords = buildTopKeywords(validQuotes, fallbackKeywords);
  const themeText = topKeywords.length > 0 ? topKeywords.join(" and ") : "the selected theme";

  if (validQuotes.length === 0) {
    return `${safeCompany} commentary does not contain enough explicit references to ${themeText} in this run.`;
  }

  const sorted = [...validQuotes].sort((left, right) => {
    if (left.periodSortKey !== right.periodSortKey) return left.periodSortKey - right.periodSortKey;
    return left.periodLabel.localeCompare(right.periodLabel);
  });
  const firstPeriod = firstNonEmpty(sorted[0]?.periodLabel);
  const lastPeriod = firstNonEmpty(sorted[sorted.length - 1]?.periodLabel);
  const periodText =
    firstPeriod && lastPeriod && firstPeriod !== lastPeriod
      ? `${firstPeriod} to ${lastPeriod}`
      : firstNonEmpty(firstPeriod, lastPeriod, "recent calls");

  return [
    `Across ${periodText}, management repeatedly links ${themeText} to strategic direction rather than one-off commentary.`,
    `Taken together, the quotes suggest ${safeCompany} sees this as a continuing business driver to track over coming quarters.`,
  ].join(" ");
};
