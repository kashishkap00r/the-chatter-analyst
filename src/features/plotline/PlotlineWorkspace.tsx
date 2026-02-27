import React from 'react';
import AnalysisProgressPanel from '../../../components/AnalysisProgressPanel';
import { QuoteSkeleton } from '../../shared/ui/skeletons';
import { statusLabels, statusStyles } from '../../shared/ui/batchStatus';
import type { PlotlineFeatureController } from './usePlotlineFeature';

const PLOTLINE_MAX_KEYWORDS = 20;

interface PlotlineWorkspaceProps {
  feature: PlotlineFeatureController;
  disabled: boolean;
}

export const PlotlineWorkspace: React.FC<PlotlineWorkspaceProps> = ({ feature, disabled }) => {
  const {
    plotlineBatchFiles,
    plotlineBatchProgress,
    plotlineKeywords,
    plotlineKeywordInput,
    plotlineSummary,
    plotlineCopyAllStatus,
    plotlineCopyAllErrorMessage,
    plotlineFileInputRef,
    plotlineReadyCount,
    plotlineCompanyCount,
    isPlotlineLoading,
    setPlotlineKeywordInput,
    handlePlotlineKeywordInputKeyDown,
    handlePlotlineKeywordInputBlur,
    removePlotlineKeyword,
    handlePlotlineFileUpload,
    handleAnalyzePlotlineBatch,
    handleCopyAllPlotline,
    removePlotlineBatchFile,
    retryPlotlineBatchFile,
    clearPlotline,
  } = feature;

  return (
    <>
      <section className="lg:col-span-5 lg:sticky lg:top-24 self-start">
        <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6">
          <header className="mb-5">
            <p className="text-xs uppercase tracking-[0.16em] text-stone font-semibold">Input Desk</p>
            <h2 className="font-serif text-2xl mt-1">Plotline Input</h2>
          </header>

          <div className="rounded-xl border border-line bg-canvas/45 p-4 mb-4">
            <label className="block text-xs uppercase tracking-[0.14em] text-stone font-semibold mb-2">Theme Keywords</label>
            <input
              value={plotlineKeywordInput}
              onChange={(event) => setPlotlineKeywordInput(event.target.value)}
              onKeyDown={handlePlotlineKeywordInputKeyDown}
              onBlur={handlePlotlineKeywordInputBlur}
              disabled={disabled}
              placeholder="Add keywords (press Enter or comma)"
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-brand/35"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {plotlineKeywords.length === 0 && <p className="text-xs text-stone">Add at least one keyword to run Plotline.</p>}
              {plotlineKeywords.map((keyword) => (
                <span
                  key={keyword}
                  className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-xs font-semibold text-brand"
                >
                  {keyword}
                  <button
                    onClick={() => removePlotlineKeyword(keyword)}
                    disabled={disabled || isPlotlineLoading}
                    className="text-brand/75 hover:text-ink"
                    aria-label={`Remove ${keyword}`}
                    title="Remove keyword"
                  >
                    X
                  </button>
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-stone">{plotlineKeywords.length}/{PLOTLINE_MAX_KEYWORDS} keywords</p>
          </div>

          <div className="relative rounded-xl border-2 border-dashed border-line bg-canvas/45 px-4 py-7 text-center hover:border-brand/45 transition-colors">
            <p className="text-sm font-medium text-stone">Drop or select transcript files</p>
            <p className="text-xs text-stone/80 mt-1">Supports PDF and TXT</p>
            <input
              ref={plotlineFileInputRef}
              type="file"
              accept=".pdf,.txt"
              multiple
              onChange={(event) => {
                void handlePlotlineFileUpload(event);
              }}
              disabled={disabled}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          <div className="mt-4 space-y-2 max-h-[320px] overflow-y-auto pr-1 thin-scrollbar">
            {plotlineBatchFiles.length === 0 && (
              <div className="rounded-xl border border-line bg-canvas px-4 py-5 text-center text-sm text-stone">
                No Plotline files queued yet.
              </div>
            )}

            {plotlineBatchFiles.map((file) => (
              <div key={file.id} className="rounded-xl border border-line bg-white px-3 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{file.result?.companyName || file.name}</p>
                    {file.error && (
                      <p className={`text-xs mt-1 whitespace-normal break-words ${file.status === 'complete' ? 'text-amber-700' : 'text-rose-700'}`}>
                        {file.status === 'complete' ? `Warning: ${file.error}` : file.error}
                      </p>
                    )}
                    {file.progress?.message && file.status === 'analyzing' && (
                      <p className="text-xs text-stone mt-1 truncate">{file.progress.message}</p>
                    )}
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.09em] ${
                      statusStyles[file.status]
                    }`}
                  >
                    {statusLabels[file.status]}
                  </span>
                  {file.status === 'error' && (
                    <button
                      onClick={() => retryPlotlineBatchFile(file.id)}
                      disabled={disabled}
                      className="text-xs font-semibold text-brand hover:text-ink"
                      title="Retry file"
                    >
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => removePlotlineBatchFile(file.id)}
                    disabled={disabled || isPlotlineLoading}
                    className="text-stone hover:text-rose-700 text-sm leading-none"
                    title="Remove file"
                    aria-label="Remove file"
                  >
                    X
                  </button>
                </div>
                {file.status === 'analyzing' && typeof file.progress?.percent === 'number' && (
                  <div className="h-1.5 rounded-full bg-line mt-2 overflow-hidden">
                    <div className="h-full bg-brand transition-all duration-300" style={{ width: `${file.progress.percent}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-5 pt-4 border-t border-line flex gap-3">
            <button
              onClick={clearPlotline}
              disabled={isPlotlineLoading || disabled}
              className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={() => {
                void handleAnalyzePlotlineBatch();
              }}
              disabled={plotlineReadyCount === 0 || plotlineKeywords.length === 0 || isPlotlineLoading || disabled}
              className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
            >
              {isPlotlineLoading
                ? 'Processing Batch...'
                : `Analyze ${plotlineReadyCount} File${plotlineReadyCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </section>

      <section className="lg:col-span-7 space-y-6">
        {plotlineCompanyCount > 0 && (
          <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-stone">
              {plotlineCompanyCount} compan{plotlineCompanyCount === 1 ? 'y' : 'ies'} included in the current Plotline story.
            </p>
            <button
              onClick={() => {
                void handleCopyAllPlotline();
              }}
              className={`inline-flex items-center justify-center rounded-xl border px-4 py-2 text-sm font-semibold transition ${
                plotlineCopyAllStatus === 'copied'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-brand bg-brand text-white hover:bg-brand/90'
              }`}
            >
              {plotlineCopyAllStatus === 'copied' ? 'Copied All' : 'Copy All'}
            </button>
          </div>
        )}

        {plotlineCopyAllStatus === 'error' && plotlineCopyAllErrorMessage && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{plotlineCopyAllErrorMessage}</div>
        )}

        {isPlotlineLoading && (
          <>
            <AnalysisProgressPanel
              title="Plotline Batch Analysis Running"
              subtitle="Matching keyword-led management remarks and building a cross-company narrative."
              progress={plotlineBatchProgress?.progress}
              batchStats={{
                completed: plotlineBatchProgress?.completed ?? 0,
                failed: plotlineBatchProgress?.failed ?? 0,
                total: plotlineBatchProgress?.total ?? 0,
                currentLabel: plotlineBatchProgress?.currentLabel,
              }}
            />
            <QuoteSkeleton />
            <QuoteSkeleton />
          </>
        )}

        {!isPlotlineLoading && plotlineSummary && plotlineSummary.sections.length === 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            No keyword matches were found across the uploaded transcripts. Try broader or alternate keywords.
          </div>
        )}

        {!isPlotlineLoading && !plotlineSummary && (
          <div className="studio-empty rounded-2xl border border-dashed border-line bg-white/70 p-10 text-center shadow-panel">
            <h3 className="font-serif text-2xl text-ink">Ready for Plotline</h3>
            <p className="text-sm text-stone mt-2">
              Upload transcript files, add target keywords, and generate cross-company plotline evidence with synthesis.
            </p>
          </div>
        )}

        {plotlineSummary && (
          <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6">
            <h3 className="font-serif text-2xl text-ink">{plotlineSummary.title}</h3>
            <p className="mt-2 text-sm text-stone leading-relaxed">{plotlineSummary.dek}</p>
          </div>
        )}

        {plotlineSummary?.sections.map((section, index) => {
          return (
            <div key={section.companyKey} className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6 space-y-5">
              <header>
                <p className="text-xs font-semibold uppercase tracking-[0.09em] text-stone">Section {index + 1}</p>
                <h2 className="font-serif text-3xl text-ink">{section.companyName}</h2>
                <p className="text-sm text-stone">{section.subhead}</p>
              </header>

              <div className="space-y-3">
                {section.narrativeParagraphs.map((paragraph, paragraphIndex) => (
                  <p
                    key={`${section.companyKey}-paragraph-${paragraphIndex}`}
                    className="rounded-xl border border-brand/20 bg-brand-soft/60 px-4 py-3 text-sm leading-relaxed text-ink"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>

              <div className="space-y-4">
                {section.quoteBlocks.map((quote, quoteIndex) => (
                  <article key={`${section.companyKey}-${quoteIndex}`} className="rounded-xl border border-line bg-canvas/45 px-4 py-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone">{quote.periodLabel}</p>
                    <blockquote className="mt-2 text-[15px] leading-relaxed italic text-ink">"{quote.quote}"</blockquote>
                    <p className="mt-2 text-xs text-stone italic">
                      - {quote.speakerName}, {quote.speakerDesignation}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          );
        })}

        {plotlineSummary && plotlineSummary.closingWatchlist.length > 0 && (
          <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6">
            <h3 className="font-serif text-2xl text-ink">What To Watch</h3>
            <ul className="mt-4 space-y-2 list-disc pl-5 text-sm text-stone leading-relaxed">
              {plotlineSummary.closingWatchlist.map((line, index) => (
                <li key={`plotline-watch-${index}`}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {plotlineSummary && plotlineSummary.skippedCompanies.length > 0 && (
          <div className="rounded-xl border border-line bg-white/70 px-4 py-3 text-xs text-stone">
            Skipped for weak evidence: {plotlineSummary.skippedCompanies.join(', ')}
          </div>
        )}
      </section>
    </>
  );
};
