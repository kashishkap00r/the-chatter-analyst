import React from 'react';
import AnalysisProgressPanel from '../../../components/AnalysisProgressPanel';
import QuoteCard from '../../../components/QuoteCard';
import ThreadComposer from '../../../components/ThreadComposer';
import { ModelType, ProviderType } from '../../../types';
import { statusLabels, statusStyles } from '../../shared/ui/batchStatus';
import { QuoteSkeleton } from '../../shared/ui/skeletons';
import type { ChatterFeatureController } from './useChatterFeature';

interface ChatterWorkspaceProps {
  feature: ChatterFeatureController;
  provider: ProviderType;
  selectedModel: ModelType;
  disabled: boolean;
}

export const ChatterWorkspace: React.FC<ChatterWorkspaceProps> = ({
  feature,
  provider,
  selectedModel,
  disabled,
}) => {
  const {
    inputMode,
    chatterPane,
    textInput,
    batchFiles,
    isAnalyzingBatch,
    batchProgress,
    chatterSingleState,
    copyAllStatus,
    copyAllErrorMessage,
    chatterFileInputRef,
    completedResults,
    readyCount,
    isTextLoading,
    isChatterLoading,
    setInputMode,
    setChatterPane,
    setTextInput,
    handleAnalyzeText,
    handleAnalyzeBatch,
    handleChatterFileUpload,
    handleCopyAllChatter,
    removeBatchFile,
    retryBatchFile,
    clearChatter,
  } = feature;

  return (
    <>
      <section className="lg:col-span-5 lg:sticky lg:top-24 self-start">
        <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6">
          <header className="mb-5">
            <p className="text-xs uppercase tracking-[0.16em] text-stone font-semibold">Input Desk</p>
            <h2 className="font-serif text-2xl mt-1">Transcript Input</h2>
          </header>

          <div className="inline-flex rounded-xl border border-line bg-canvas p-1 mb-4 w-full">
            <button
              onClick={() => setInputMode('file')}
              disabled={disabled}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                inputMode === 'file' ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink'
              } disabled:opacity-50`}
            >
              Files (Batch)
            </button>
            <button
              onClick={() => setInputMode('text')}
              disabled={disabled}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                inputMode === 'text' ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink'
              } disabled:opacity-50`}
            >
              Paste Text
            </button>
          </div>

          {inputMode === 'text' ? (
            <textarea
              className="w-full min-h-[290px] rounded-xl border border-line bg-canvas/40 p-4 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-brand/40"
              placeholder="Paste earnings call transcript here..."
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
              disabled={disabled}
            />
          ) : (
            <>
              <div className="relative rounded-xl border-2 border-dashed border-line bg-canvas/45 px-4 py-7 text-center hover:border-brand/45 transition-colors">
                <p className="text-sm font-medium text-stone">Drop or select transcript files</p>
                <p className="text-xs text-stone/80 mt-1">Supports PDF and TXT</p>
                <input
                  ref={chatterFileInputRef}
                  type="file"
                  accept=".txt,.pdf"
                  multiple
                  onChange={(event) => {
                    void handleChatterFileUpload(event);
                  }}
                  disabled={disabled}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>

              <div className="mt-4 space-y-2 max-h-[320px] overflow-y-auto pr-1 thin-scrollbar">
                {batchFiles.length === 0 && (
                  <div className="rounded-xl border border-line bg-canvas px-4 py-5 text-center text-sm text-stone">
                    No files queued yet.
                  </div>
                )}

                {batchFiles.map((file) => (
                  <div key={file.id} className="rounded-xl border border-line bg-white px-3 py-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{file.result?.companyName || file.name}</p>
                        {file.error && <p className="text-xs text-rose-700 mt-1 whitespace-normal break-words">{file.error}</p>}
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
                      {file.status === 'error' && file.content.trim().length > 0 && (
                        <button
                          onClick={() => retryBatchFile(file.id)}
                          disabled={disabled}
                          className="text-xs font-semibold text-brand hover:text-ink"
                          title="Retry file"
                        >
                          Retry
                        </button>
                      )}
                      <button
                        onClick={() => removeBatchFile(file.id)}
                        disabled={disabled || isAnalyzingBatch}
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
            </>
          )}

          <div className="mt-5 pt-4 border-t border-line flex gap-3">
            <button
              onClick={clearChatter}
              disabled={isChatterLoading || disabled}
              className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
            >
              Clear
            </button>
            {inputMode === 'text' ? (
              <button
                onClick={() => {
                  void handleAnalyzeText();
                }}
                disabled={!textInput.trim() || isTextLoading || disabled}
                className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
              >
                {isTextLoading ? 'Analyzing...' : 'Extract Insights'}
              </button>
            ) : (
              <button
                onClick={() => {
                  void handleAnalyzeBatch();
                }}
                disabled={readyCount === 0 || isAnalyzingBatch || disabled}
                className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
              >
                {isAnalyzingBatch ? 'Processing Batch...' : `Analyze ${readyCount} File${readyCount === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="lg:col-span-7 space-y-6">
        <div className="inline-flex rounded-xl border border-line bg-white p-1">
          <button
            onClick={() => setChatterPane('analysis')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              chatterPane === 'analysis' ? 'bg-canvas text-ink shadow-sm' : 'text-stone hover:text-ink'
            }`}
          >
            Quote Analysis
          </button>
          <button
            onClick={() => setChatterPane('thread')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              chatterPane === 'thread' ? 'bg-canvas text-ink shadow-sm' : 'text-stone hover:text-ink'
            }`}
          >
            Tweet Generator
          </button>
        </div>

        {chatterPane === 'thread' ? (
          <ThreadComposer provider={provider} model={selectedModel} disabled={disabled} />
        ) : (
          <>
            {completedResults.length > 0 && (
              <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <p className="text-sm text-stone">
                  {completedResults.length} compan{completedResults.length === 1 ? 'y' : 'ies'} ready for newsletter export.
                </p>
                <button
                  onClick={() => {
                    void handleCopyAllChatter();
                  }}
                  className={`inline-flex items-center justify-center rounded-xl border px-4 py-2 text-sm font-semibold transition ${
                    copyAllStatus === 'copied'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-brand bg-brand text-white hover:bg-brand/90'
                  }`}
                >
                  {copyAllStatus === 'copied' ? 'Copied All' : 'Copy All'}
                </button>
              </div>
            )}

            {copyAllStatus === 'error' && copyAllErrorMessage && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{copyAllErrorMessage}</div>
            )}

            {isTextLoading && (
              <>
                <AnalysisProgressPanel
                  title="Transcript Analysis Running"
                  subtitle="We are extracting the highest-signal quotes and context."
                  progress={chatterSingleState.progress}
                />
                <QuoteSkeleton />
                <QuoteSkeleton />
                <QuoteSkeleton />
              </>
            )}

            {isAnalyzingBatch && batchProgress && (
              <>
                <AnalysisProgressPanel
                  title="Batch Analysis Running"
                  subtitle="Files are processed sequentially for cleaner, deterministic results."
                  progress={batchProgress.progress}
                  batchStats={{
                    completed: batchProgress.completed,
                    failed: batchProgress.failed,
                    total: batchProgress.total,
                    currentLabel: batchProgress.currentLabel,
                  }}
                />
                <QuoteSkeleton />
                <QuoteSkeleton />
              </>
            )}

            {chatterSingleState.status === 'error' && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                {chatterSingleState.errorMessage}
              </div>
            )}

            {completedResults.length === 0 && !isChatterLoading && chatterSingleState.status !== 'error' && (
              <div className="studio-empty rounded-2xl border border-dashed border-line bg-white/70 p-10 text-center shadow-panel">
                <h3 className="font-serif text-2xl text-ink">Ready to analyze</h3>
                <p className="text-sm text-stone mt-2">
                  Upload transcripts or paste text, then run analysis to generate quote-ready insight cards.
                </p>
              </div>
            )}

            {chatterSingleState.status === 'complete' && chatterSingleState.result && (
              <div className="space-y-4">
                <div>
                  <h2 className="font-serif text-3xl text-ink">{chatterSingleState.result.companyName}</h2>
                  <p className="text-sm text-stone">{chatterSingleState.result.fiscalPeriod}</p>
                </div>
                <div className="space-y-4">
                  {chatterSingleState.result.quotes.map((quote, index) => (
                    <QuoteCard key={`single-${index}`} quoteData={quote} index={index} />
                  ))}
                </div>
              </div>
            )}

            {batchFiles
              .filter((file) => file.result)
              .map((file) => (
                <div key={file.id} className="space-y-4">
                  <div>
                    <h2 className="font-serif text-3xl text-ink">{file.result?.companyName}</h2>
                    <p className="text-sm text-stone">{file.result?.fiscalPeriod}</p>
                  </div>
                  <div className="space-y-4">
                    {file.result?.quotes.map((quote, index) => (
                      <QuoteCard key={`${file.id}-${index}`} quoteData={quote} index={index} />
                    ))}
                  </div>
                </div>
              ))}
          </>
        )}
      </section>
    </>
  );
};
