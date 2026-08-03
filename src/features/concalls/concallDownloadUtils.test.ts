import { describe, expect, it } from 'vitest';
import type { TijoriConcall } from '../chatter/tijori/tijoriTypes';
import {
  buildConcallFileName,
  buildZipEntryPath,
  formatConcallDate,
  parseCompanyQueries,
  readNextOffset,
  sanitizeSegment,
  toDownloadRows,
} from './concallDownloadUtils';

const makeConcall = (overrides: Partial<TijoriConcall> = {}): TijoriConcall => ({
  slug: 'dixon-technologies',
  name: 'Dixon Technologies',
  sector: 'Electronics',
  isin: 'INE935N01012',
  concall_event_time: '2025-05-20T10:30:00Z',
  transcript: 'https://files.tijoristack.ai/dixon-q4fy25.pdf',
  status: 'available',
  ...overrides,
});

describe('parseCompanyQueries', () => {
  it('splits on commas and newlines, trims, and drops empties', () => {
    expect(parseCompanyQueries('Dixon, Amber\nKaynes,  ')).toEqual(['Dixon', 'Amber', 'Kaynes']);
  });

  it('dedupes case-insensitively while keeping first-seen casing', () => {
    expect(parseCompanyQueries('Dixon, dixon, DIXON')).toEqual(['Dixon']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseCompanyQueries('   \n , ')).toEqual([]);
  });
});

describe('toDownloadRows', () => {
  it('keeps only rows with a transcript URL and attaches a stable rowKey', () => {
    const rows = toDownloadRows([
      makeConcall(),
      makeConcall({ slug: 'amber', name: 'Amber', transcript: '' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowKey).toBe('dixon-technologies|2025-05-20T10:30:00Z');
    expect(rows[0].transcript).toContain('.pdf');
  });

  it('dedupes rows that share a slug and event time', () => {
    const rows = toDownloadRows([makeConcall(), makeConcall()]);
    expect(rows).toHaveLength(1);
  });
});

describe('formatConcallDate', () => {
  it('formats an ISO timestamp to YYYY-MM-DD', () => {
    expect(formatConcallDate('2025-05-20T10:30:00Z')).toBe('2025-05-20');
  });

  it('falls back to a placeholder for an unparseable value', () => {
    expect(formatConcallDate('not-a-date')).toBe('undated');
    expect(formatConcallDate('')).toBe('undated');
  });
});

describe('sanitizeSegment', () => {
  it('replaces filesystem-unsafe characters with underscores', () => {
    expect(sanitizeSegment('Bajaj Finance Ltd. / NBFC')).toBe('Bajaj_Finance_Ltd_NBFC');
  });

  it('never returns an empty string', () => {
    expect(sanitizeSegment('***')).toBe('company');
  });
});

describe('buildConcallFileName / buildZipEntryPath', () => {
  it('builds a readable per-file name', () => {
    expect(buildConcallFileName(toDownloadRows([makeConcall()])[0])).toBe(
      'Dixon_Technologies_2025-05-20_transcript.pdf',
    );
  });

  it('nests the file under a company folder in the zip', () => {
    expect(buildZipEntryPath(toDownloadRows([makeConcall()])[0])).toBe(
      'Dixon_Technologies/Dixon_Technologies_2025-05-20_transcript.pdf',
    );
  });
});

describe('readNextOffset', () => {
  it('returns the numeric next offset when present', () => {
    expect(readNextOffset({ pagination: { next_offset: 30 }, data: [] })).toBe(30);
  });

  it('returns null when next_offset is null or missing', () => {
    expect(readNextOffset({ pagination: { next_offset: null }, data: [] })).toBeNull();
    expect(readNextOffset({ pagination: {}, data: [] })).toBeNull();
  });
});
