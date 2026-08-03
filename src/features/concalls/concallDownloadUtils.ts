import type { TijoriConcall, TijoriListResponse } from '../chatter/tijori/tijoriTypes';

/**
 * A concall that is actually downloadable (has a transcript PDF URL), tagged
 * with a stable key for selection/dedup.
 */
export interface ConcallRow {
  rowKey: string;
  slug: string;
  name: string;
  sector: string;
  isin: string;
  eventTime: string;
  transcript: string;
}

/** Split a comma/newline separated company list into deduped, trimmed queries. */
export const parseCompanyQueries = (raw: string): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of raw.split(/[,\n]/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
};

/** Keep only concalls with a transcript URL, dedup by (slug, event time). */
export const toDownloadRows = (concalls: TijoriConcall[]): ConcallRow[] => {
  const seen = new Set<string>();
  const rows: ConcallRow[] = [];
  for (const c of concalls) {
    if (!c.transcript) continue;
    const rowKey = `${c.slug}|${c.concall_event_time}`;
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    rows.push({
      rowKey,
      slug: c.slug,
      name: c.name,
      sector: c.sector,
      isin: c.isin,
      eventTime: c.concall_event_time,
      transcript: c.transcript,
    });
  }
  return rows;
};

/** ISO timestamp -> YYYY-MM-DD, or 'undated' when unparseable. */
export const formatConcallDate = (iso: string): string => {
  if (!iso) return 'undated';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'undated';
  return parsed.toISOString().slice(0, 10);
};

/** Make a value safe for a file/folder name; never returns empty. */
export const sanitizeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'company';

export const buildConcallFileName = (row: ConcallRow): string =>
  `${sanitizeSegment(row.name)}_${formatConcallDate(row.eventTime)}_transcript.pdf`;

export const buildZipEntryPath = (row: ConcallRow): string =>
  `${sanitizeSegment(row.name)}/${buildConcallFileName(row)}`;

/** Pull the numeric next_offset from a list response, or null when exhausted. */
export const readNextOffset = (payload: TijoriListResponse): number | null => {
  const next = payload.pagination?.next_offset;
  return typeof next === 'number' ? next : null;
};
