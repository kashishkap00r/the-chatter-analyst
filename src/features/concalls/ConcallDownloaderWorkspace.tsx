import React from 'react';
import { formatConcallDate } from './concallDownloadUtils';
import type { ConcallDownloaderController } from './useConcallDownloaderFeature';

interface ConcallDownloaderWorkspaceProps {
  feature: ConcallDownloaderController;
  disabled?: boolean;
}

export const ConcallDownloaderWorkspace: React.FC<ConcallDownloaderWorkspaceProps> = ({
  feature,
  disabled = false,
}) => {
  const {
    companyInput,
    setCompanyInput,
    loading,
    error,
    hasSearched,
    groups,
    totalRows,
    selectedKeys,
    progress,
    search,
    toggleRow,
    toggleAll,
    clearSelection,
    downloadRow,
    downloadSelectedZip,
  } = feature;

  const busy = disabled || loading || progress.active;
  const selectedCount = selectedKeys.size;
  const allSelected = totalRows > 0 && selectedCount === totalRows;

  const handleKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void search();
    }
  };

  return (
    <section className="lg:col-span-12 space-y-5">
      <div className="rounded-z-lg border border-line bg-white p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Concall Downloader</h2>
          <p className="text-sm text-stone mt-1">
            Search Tijori for earnings-call transcripts and download the PDFs — one at a time or as a
            zip. Enter company names separated by commas or new lines.
          </p>
        </div>

        <textarea
          value={companyInput}
          onChange={(e) => setCompanyInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={busy}
          rows={3}
          placeholder="Dixon Technologies, Amber Enterprises, Kaynes Technology"
          className="w-full rounded-z-md border border-line bg-brand-soft px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand disabled:opacity-50"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={() => void search()}
            disabled={busy || companyInput.trim().length === 0}
            className="rounded-z-md bg-brand text-white text-sm font-semibold py-2 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
          >
            {loading ? 'Searching Tijori…' : 'Search'}
          </button>
          <span className="text-[11px] text-stone">⌘/Ctrl + Enter</span>
        </div>

        {error && (
          <div className="rounded-z-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}

        {progress.active && (
          <div className="rounded-z-md border border-brand/30 bg-brand-soft px-3 py-2 text-xs text-ink">
            {progress.label ? `${progress.label} — ` : ''}
            {progress.done}/{progress.total} downloaded
            {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
          </div>
        )}
      </div>

      {hasSearched && (
        <div className="rounded-z-lg border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={busy || totalRows === 0}
                className="h-4 w-4 accent-brand"
              />
              Select all
            </label>
            <div className="flex items-center gap-3">
              {selectedCount > 0 && (
                <button
                  onClick={clearSelection}
                  disabled={busy}
                  className="text-xs font-semibold text-stone hover:text-ink disabled:opacity-50"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => void downloadSelectedZip()}
                disabled={busy || selectedCount === 0}
                className="rounded-z-md bg-brand text-white text-xs font-semibold py-2 px-3 disabled:opacity-50 hover:bg-brand/90 transition"
              >
                {progress.active
                  ? 'Preparing…'
                  : `Download All (zip)${selectedCount > 0 ? ` · ${selectedCount}` : ''}`}
              </button>
            </div>
          </div>

          {totalRows === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-stone">
              No transcripts found. Try a different company name.
            </div>
          ) : (
            <div className="divide-y divide-line">
              {groups.map((group) => (
                <div key={group.name} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-semibold text-ink truncate">{group.name}</p>
                    <p className="text-[11px] text-stone whitespace-nowrap">
                      {group.sector || '—'} · {group.rows.length} concall
                      {group.rows.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <ul className="mt-2 divide-y divide-line/70">
                    {group.rows.map((row) => {
                      const checked = selectedKeys.has(row.rowKey);
                      return (
                        <li key={row.rowKey} className="flex items-center gap-3 py-1.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRow(row.rowKey)}
                            disabled={busy}
                            className="h-4 w-4 accent-brand"
                          />
                          <span className="flex-1 text-sm text-ink">
                            {formatConcallDate(row.eventTime)}
                          </span>
                          <button
                            onClick={() => void downloadRow(row)}
                            disabled={busy}
                            className="rounded-z-md border border-line bg-white px-3 py-1 text-xs font-semibold text-brand hover:bg-canvas disabled:opacity-50"
                          >
                            Download
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-line px-4 py-2 text-[11px] text-stone">
            {totalRows} transcript{totalRows === 1 ? '' : 's'} across {groups.length} compan
            {groups.length === 1 ? 'y' : 'ies'}
          </div>
        </div>
      )}
    </section>
  );
};
