import React from 'react';
import AnalysisProgressPanel from '../../../components/AnalysisProgressPanel';
import PointsCard from '../../../components/PointsCard';
import { statusLabels, statusStyles } from '../../shared/ui/batchStatus';
import { SlideSkeleton } from '../../shared/ui/skeletons';
import type { PointsFeatureController } from './usePointsFeature';

interface PointsWorkspaceProps {
  feature: PointsFeatureController;
  disabled: boolean;
}

export const PointsWorkspace: React.FC<PointsWorkspaceProps> = ({ feature, disabled }) => {
  const {
    pointsBatchFiles,
    pointsBatchProgress,
    pointsCopyAllStatus,
    pointsCopyAllErrorMessage,
    pointsFileInputRef,
    completedPointsResults,
    pointsReadyCount,
    isPointsLoading,
    handlePointsFileUpload,
    handleAnalyzePointsBatch,
    handleCopyAllPoints,
    removePointsBatchFile,
    retryPointsBatchFile,
    clearPoints,
  } = feature;

  return (
    <>
      <section className="lg:col-span-5 lg:sticky lg:top-24 self-start">
        <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6">
          <header className="mb-5">
            <p className="text-xs uppercase tracking-[0.16em] text-stone font-semibold">Input Desk</p>
            <h2 className="font-serif text-2xl mt-1">Presentation Input</h2>
          </header>

          <div className="relative rounded-xl border-2 border-dashed border-line bg-canvas/45 px-4 py-7 text-center hover:border-brand/45 transition-colors">
            <p className="text-sm font-medium text-stone">Drop or select presentation files</p>
            <p className="text-xs text-stone/80 mt-1">PDF only, batch supported</p>
            <input
              ref={pointsFileInputRef}
              type="file"
              accept=".pdf"
              multiple
              onChange={handlePointsFileUpload}
              disabled={disabled}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          <div className="mt-4 space-y-2 max-h-[320px] overflow-y-auto pr-1 thin-scrollbar">
            {pointsBatchFiles.length === 0 && (
              <div className="rounded-xl border border-line bg-canvas px-4 py-5 text-center text-sm text-stone">
                No presentation files queued yet.
              </div>
            )}

            {pointsBatchFiles.map((file) => (
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
                      onClick={() => retryPointsBatchFile(file.id)}
                      disabled={disabled}
                      className="text-xs font-semibold text-brand hover:text-ink"
                      title="Retry file"
                    >
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => removePointsBatchFile(file.id)}
                    disabled={disabled || isPointsLoading}
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
              onClick={clearPoints}
              disabled={isPointsLoading || disabled}
              className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={() => {
                void handleAnalyzePointsBatch();
              }}
              disabled={pointsReadyCount === 0 || isPointsLoading || disabled}
              className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
            >
              {isPointsLoading ? 'Processing Batch...' : `Analyze ${pointsReadyCount} File${pointsReadyCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </section>

      <section className="lg:col-span-7 space-y-6">
        {completedPointsResults.length > 0 && (
          <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-stone">
              {completedPointsResults.length} compan{completedPointsResults.length === 1 ? 'y' : 'ies'} ready for Points export.
            </p>
            <button
              onClick={() => {
                void handleCopyAllPoints();
              }}
              className={`inline-flex items-center justify-center rounded-xl border px-4 py-2 text-sm font-semibold transition ${
                pointsCopyAllStatus === 'copied'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-brand bg-brand text-white hover:bg-brand/90'
              }`}
            >
              {pointsCopyAllStatus === 'copied' ? 'Copied All' : 'Copy All'}
            </button>
          </div>
        )}

        {pointsCopyAllStatus === 'error' && pointsCopyAllErrorMessage && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{pointsCopyAllErrorMessage}</div>
        )}

        {isPointsLoading && (
          <>
            <AnalysisProgressPanel
              title="Presentation Batch Analysis Running"
              subtitle="Decks are processed sequentially and high-signal slides are selected."
              progress={pointsBatchProgress?.progress}
              batchStats={{
                completed: pointsBatchProgress?.completed ?? 0,
                failed: pointsBatchProgress?.failed ?? 0,
                total: pointsBatchProgress?.total ?? 0,
                currentLabel: pointsBatchProgress?.currentLabel,
              }}
            />
            <SlideSkeleton />
            <SlideSkeleton />
          </>
        )}

        {completedPointsResults.length === 0 && !isPointsLoading && (
          <div className="studio-empty rounded-2xl border border-dashed border-line bg-white/70 p-10 text-center shadow-panel">
            <h3 className="font-serif text-2xl text-ink">Ready to analyze a presentation</h3>
            <p className="text-sm text-stone mt-2">
              Upload one or more investor decks and we will surface the most meaningful long-term insight slides.
            </p>
          </div>
        )}

        {pointsBatchFiles
          .filter((file) => file.result)
          .map((file) => (
            <div key={file.id} className="space-y-5">
              <header>
                <h2 className="font-serif text-3xl text-ink">{file.result?.companyName}</h2>
                <p className="text-sm text-stone">
                  {file.result?.fiscalPeriod} | {file.result?.marketCapCategory} | {file.result?.industry}
                </p>
              </header>
              <div className="space-y-5">
                {file.result?.slides.map((slide, index) => (
                  <PointsCard key={`${file.id}-${slide.selectedPageNumber}-${index}`} slide={slide} index={index + 1} />
                ))}
              </div>
            </div>
          ))}
      </section>
    </>
  );
};
