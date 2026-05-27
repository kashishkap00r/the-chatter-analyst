import React from 'react';
import type { TijoriConcall } from './tijoriTypes';
import { useTijoriFeed } from './useTijoriFeed';

interface TijoriPickerProps {
  disabled: boolean;
  isIngesting: boolean;
  onAnalyze: (selected: TijoriConcall[]) => void | Promise<void>;
}

const formatRelative = (iso: string): string => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
};

export const TijoriPicker: React.FC<TijoriPickerProps> = ({ disabled, isIngesting, onAnalyze }) => {
  const feed = useTijoriFeed();
  const {
    loading,
    loadingMore,
    error,
    searchQuery,
    selectedSlugs,
    filteredConcalls,
    nextOffset,
    totalResults,
    setSearchQuery,
    searchAllOnTijori,
    loadMore,
    toggle,
    clearSelection,
    getSelected,
  } = feed;

  const selectedCount = selectedSlugs.size;
  const interactionDisabled = disabled || isIngesting;

  const handleAnalyzeClick = () => {
    const selected = getSelected();
    if (selected.length === 0) return;
    void onAnalyze(selected);
  };

  const handleSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void searchAllOnTijori();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKey}
          disabled={interactionDisabled}
          placeholder="Filter loaded concalls..."
          className="flex-1 rounded-z-md border border-line bg-brand-soft px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand disabled:opacity-50"
        />
        <button
          onClick={() => void searchAllOnTijori()}
          disabled={interactionDisabled || loading}
          className="rounded-z-md border border-line bg-white px-3 py-2 text-xs font-semibold text-ink hover:bg-canvas disabled:opacity-50"
          title="Search all of Tijori (server-side)"
        >
          Search all of Tijori
        </button>
      </div>

      {error && (
        <div className="rounded-z-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}

      <div className="max-h-[360px] overflow-y-auto thin-scrollbar rounded-z-md border border-line bg-white">
        {loading && filteredConcalls.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-stone">Loading latest concalls...</div>
        )}

        {!loading && filteredConcalls.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-stone">
            {searchQuery.trim()
              ? 'No matches in the loaded list. Try "Search all of Tijori".'
              : 'No concalls available.'}
          </div>
        )}

        <ul className="divide-y divide-line">
          {filteredConcalls.map((c) => {
            const checked = selectedSlugs.has(c.slug);
            const hasTranscript = c.transcript.length > 0;
            const rowDisabled = interactionDisabled || !hasTranscript;
            return (
              <li key={c.slug || c.concall_event_time} className={`px-3 py-2.5 ${!hasTranscript ? 'opacity-60' : ''}`}>
                <label className={`flex items-start gap-3 ${rowDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={checked && hasTranscript}
                    onChange={() => hasTranscript && toggle(c.slug)}
                    disabled={rowDisabled}
                    className="mt-1 h-4 w-4 accent-brand"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-semibold text-ink truncate">{c.name}</p>
                      <p className="text-[11px] text-stone whitespace-nowrap">
                        {formatRelative(c.concall_event_time)}
                      </p>
                    </div>
                    <p className="text-[11px] text-stone truncate">
                      {c.sector || '—'}{c.isin ? ` · ${c.isin}` : ''}
                      {!hasTranscript && <span className="ml-1 text-amber-700">· transcript pending</span>}
                    </p>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>

        {nextOffset !== null && (
          <div className="border-t border-line px-3 py-2 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={interactionDisabled || loadingMore || loading}
              className="text-xs font-semibold text-brand hover:text-ink disabled:opacity-50"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-stone">
        <span>
          {filteredConcalls.length} shown
          {totalResults > filteredConcalls.length ? ` · ${totalResults.toLocaleString()} total` : ''}
        </span>
        {selectedCount > 0 && (
          <button
            onClick={clearSelection}
            disabled={interactionDisabled}
            className="font-semibold text-stone hover:text-ink disabled:opacity-50"
          >
            Clear selection
          </button>
        )}
      </div>

      <button
        onClick={handleAnalyzeClick}
        disabled={interactionDisabled || selectedCount === 0}
        className="w-full rounded-z-md bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
      >
        {isIngesting
          ? 'Fetching transcripts...'
          : selectedCount === 0
            ? 'Select concalls to analyze'
            : `Fetch & queue ${selectedCount} transcript${selectedCount === 1 ? '' : 's'}`}
      </button>
    </div>
  );
};
