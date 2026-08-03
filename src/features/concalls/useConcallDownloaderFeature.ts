import { useCallback, useMemo, useState } from 'react';
import JSZip from 'jszip';
import type { TijoriConcall, TijoriListResponse } from '../chatter/tijori/tijoriTypes';
import { downloadBlob } from '../../../utils/fileDownload';
import {
  buildConcallFileName,
  buildZipEntryPath,
  parseCompanyQueries,
  readNextOffset,
  toDownloadRows,
  type ConcallRow,
} from './concallDownloadUtils';

const LIST_ENDPOINT = '/api/chatter/tijori/list';
const PDF_ENDPOINT = '/api/chatter/tijori/pdf';
const PAGE_SIZE = 30;
// Safety cap so a mis-paginating upstream can never spin forever.
const MAX_PAGES_PER_COMPANY = 40;
const DOWNLOAD_CONCURRENCY = 4;

export interface ConcallGroup {
  name: string;
  sector: string;
  rows: ConcallRow[];
}

export interface DownloadProgress {
  active: boolean;
  total: number;
  done: number;
  failed: number;
  label: string;
}

export interface ConcallDownloaderController {
  companyInput: string;
  setCompanyInput: (value: string) => void;
  loading: boolean;
  error: string | null;
  hasSearched: boolean;
  groups: ConcallGroup[];
  totalRows: number;
  selectedKeys: Set<string>;
  progress: DownloadProgress;
  search: () => Promise<void>;
  toggleRow: (rowKey: string) => void;
  toggleAll: () => void;
  clearSelection: () => void;
  downloadRow: (row: ConcallRow) => Promise<void>;
  downloadSelectedZip: () => Promise<void>;
}

const IDLE_PROGRESS: DownloadProgress = { active: false, total: 0, done: 0, failed: 0, label: '' };

/** Fetch a single list page for a company query. */
const fetchListPage = async (query: string, offset: number): Promise<TijoriListResponse> => {
  const url = new URL(LIST_ENDPOINT, window.location.origin);
  url.searchParams.set('page_size', String(PAGE_SIZE));
  if (offset > 0) url.searchParams.set('offset', String(offset));
  if (query) url.searchParams.set('q', query);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new Error(body?.error?.message || `Tijori request failed (${resp.status}).`);
  }
  return (await resp.json()) as TijoriListResponse;
};

/** Page through every concall for one company query until the feed is exhausted. */
const fetchAllForCompany = async (query: string): Promise<TijoriConcall[]> => {
  const collected: TijoriConcall[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES_PER_COMPANY; page++) {
    const payload = await fetchListPage(query, offset);
    if (Array.isArray(payload.data)) collected.push(...payload.data);
    const next = readNextOffset(payload);
    if (next === null) break;
    offset = next;
  }
  return collected;
};

/** Fetch a transcript PDF through the server proxy and return its blob. */
const fetchTranscriptBlob = async (transcriptUrl: string): Promise<Blob> => {
  const url = new URL(PDF_ENDPOINT, window.location.origin);
  url.searchParams.set('url', transcriptUrl);
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new Error(body?.error?.message || `PDF fetch failed (${resp.status}).`);
  }
  return resp.blob();
};

/** Run async tasks with a bounded concurrency pool, preserving completion callbacks. */
const runPool = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
};

export const useConcallDownloaderFeature = (): ConcallDownloaderController => {
  const [companyInput, setCompanyInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [rows, setRows] = useState<ConcallRow[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<DownloadProgress>(IDLE_PROGRESS);

  const search = useCallback(async () => {
    const queries = parseCompanyQueries(companyInput);
    if (queries.length === 0) {
      setError('Enter at least one company name.');
      return;
    }

    setLoading(true);
    setError(null);
    setSelectedKeys(new Set());

    try {
      const all: TijoriConcall[] = [];
      const failures: string[] = [];
      for (const query of queries) {
        try {
          all.push(...(await fetchAllForCompany(query)));
        } catch (err) {
          failures.push(`${query} (${(err as Error).message})`);
        }
      }

      const downloadable = toDownloadRows(all).sort((a, b) =>
        b.eventTime.localeCompare(a.eventTime),
      );
      setRows(downloadable);
      setHasSearched(true);
      if (failures.length > 0) {
        setError(`Some searches failed: ${failures.join('; ')}`);
      }
    } catch (err) {
      setError((err as Error)?.message || 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, [companyInput]);

  const groups = useMemo<ConcallGroup[]>(() => {
    const byName = new Map<string, ConcallGroup>();
    for (const row of rows) {
      const existing = byName.get(row.slug);
      if (existing) {
        existing.rows.push(row);
      } else {
        byName.set(row.slug, { name: row.name, sector: row.sector, rows: [row] });
      }
    }
    return Array.from(byName.values());
  }, [rows]);

  const toggleRow = useCallback((rowKey: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedKeys((prev) => {
      if (prev.size === rows.length && rows.length > 0) return new Set();
      return new Set(rows.map((row) => row.rowKey));
    });
  }, [rows]);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  const downloadRow = useCallback(async (row: ConcallRow) => {
    setProgress({ active: true, total: 1, done: 0, failed: 0, label: row.name });
    try {
      const blob = await fetchTranscriptBlob(row.transcript);
      downloadBlob(blob, buildConcallFileName(row));
      setProgress({ active: false, total: 1, done: 1, failed: 0, label: '' });
    } catch (err) {
      setProgress({ active: false, total: 1, done: 0, failed: 1, label: '' });
      setError(`Could not download ${row.name}: ${(err as Error).message}`);
    }
  }, []);

  const downloadSelectedZip = useCallback(async () => {
    const selected = rows.filter((row) => selectedKeys.has(row.rowKey));
    if (selected.length === 0) return;

    setError(null);
    setProgress({ active: true, total: selected.length, done: 0, failed: 0, label: 'Fetching PDFs…' });

    const zip = new JSZip();
    let done = 0;
    let failed = 0;
    const failedNames: string[] = [];

    await runPool(selected, DOWNLOAD_CONCURRENCY, async (row: ConcallRow) => {
      try {
        const blob = await fetchTranscriptBlob(row.transcript);
        zip.file(buildZipEntryPath(row), blob);
        done += 1;
      } catch {
        failed += 1;
        failedNames.push(buildConcallFileName(row));
      }
      setProgress({
        active: true,
        total: selected.length,
        done,
        failed,
        label: row.name,
      });
    });

    if (done === 0) {
      setProgress(IDLE_PROGRESS);
      setError('None of the selected transcripts could be downloaded.');
      return;
    }

    setProgress({ active: true, total: selected.length, done, failed, label: 'Building zip…' });
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(zipBlob, `concalls_${stamp}.zip`);

    setProgress(IDLE_PROGRESS);
    if (failed > 0) {
      setError(`Downloaded ${done} of ${selected.length}. Skipped: ${failedNames.join(', ')}.`);
    }
  }, [rows, selectedKeys]);

  return {
    companyInput,
    setCompanyInput,
    loading,
    error,
    hasSearched,
    groups,
    totalRows: rows.length,
    selectedKeys,
    progress,
    search,
    toggleRow,
    toggleAll,
    clearSelection,
    downloadRow,
    downloadSelectedZip,
  };
};
