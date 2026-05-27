import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TijoriConcall, TijoriListResponse } from './tijoriTypes';

const LIST_ENDPOINT = '/api/chatter/tijori/list';
const DEFAULT_PAGE_SIZE = 30;

interface FetchOptions {
  q?: string;
  offset?: number;
  append?: boolean;
}

export interface TijoriFeedController {
  concalls: TijoriConcall[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  searchQuery: string;
  selectedSlugs: Set<string>;
  filteredConcalls: TijoriConcall[];
  totalResults: number;
  nextOffset: number | null;
  setSearchQuery: (q: string) => void;
  searchAllOnTijori: () => Promise<void>;
  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  toggle: (slug: string) => void;
  toggleMany: (slugs: string[]) => void;
  clearSelection: () => void;
  getSelected: () => TijoriConcall[];
}

export const useTijoriFeed = (): TijoriFeedController => {
  const [concalls, setConcalls] = useState<TijoriConcall[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [totalResults, setTotalResults] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  const lastServerQueryRef = useRef<string>('');
  const hasInitialized = useRef(false);

  const fetchPage = useCallback(async ({ q = '', offset = 0, append = false }: FetchOptions) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);

    try {
      const url = new URL(LIST_ENDPOINT, window.location.origin);
      url.searchParams.set('page_size', String(DEFAULT_PAGE_SIZE));
      if (offset > 0) url.searchParams.set('offset', String(offset));
      if (q) url.searchParams.set('q', q);

      const resp = await fetch(url.toString());
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(body?.error?.message || `Request failed (${resp.status}).`);
      }
      const payload = (await resp.json()) as TijoriListResponse;

      setConcalls((prev) => (append ? [...prev, ...payload.data] : payload.data));
      setTotalResults(payload.pagination?.total_results ?? payload.data.length);
      const next = payload.pagination?.next_offset;
      setNextOffset(typeof next === 'number' ? next : null);
      lastServerQueryRef.current = q;
    } catch (err: unknown) {
      setError((err as { message?: string })?.message || 'Failed to load concalls.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const loadInitial = useCallback(async () => {
    await fetchPage({ q: '', offset: 0, append: false });
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMore || loading) return;
    await fetchPage({ q: lastServerQueryRef.current, offset: nextOffset, append: true });
  }, [fetchPage, loading, loadingMore, nextOffset]);

  const searchAllOnTijori = useCallback(async () => {
    await fetchPage({ q: searchQuery.trim(), offset: 0, append: false });
  }, [fetchPage, searchQuery]);

  const toggle = useCallback((slug: string) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const toggleMany = useCallback((slugs: string[]) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      const allSelected = slugs.every((s) => next.has(s));
      if (allSelected) slugs.forEach((s) => next.delete(s));
      else slugs.forEach((s) => next.add(s));
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedSlugs(new Set()), []);

  const filteredConcalls = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return concalls;
    return concalls.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.sector.toLowerCase().includes(q) ||
        c.isin.toLowerCase().includes(q),
    );
  }, [concalls, searchQuery]);

  const getSelected = useCallback(
    (): TijoriConcall[] => concalls.filter((c) => selectedSlugs.has(c.slug)),
    [concalls, selectedSlugs],
  );

  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    void loadInitial();
  }, [loadInitial]);

  return {
    concalls,
    loading,
    loadingMore,
    error,
    searchQuery,
    selectedSlugs,
    filteredConcalls,
    totalResults,
    nextOffset,
    setSearchQuery,
    searchAllOnTijori,
    loadInitial,
    loadMore,
    toggle,
    toggleMany,
    clearSelection,
    getSelected,
  };
};
