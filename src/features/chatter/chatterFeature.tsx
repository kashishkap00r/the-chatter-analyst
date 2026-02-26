import React, { useCallback, useMemo, useRef, useState } from 'react';
import AnalysisProgressPanel from '../../../components/AnalysisProgressPanel';
import QuoteCard from '../../../components/QuoteCard';
import ThreadComposer from '../../../components/ThreadComposer';
import { analyzeTranscript, parsePdfToText } from '../../../services/geminiService';
import type {
  BatchFile,
  ChatterAnalysisResult,
  ChatterAnalysisState,
  ModelType,
  ProviderType,
  ProgressEvent,
} from '../../../types';
import { buildChatterClipboardExport } from '../../../utils/chatterCopyExport';
import type { BatchProgressState, ChatterSessionSlice } from '../../shared/state/sessionTypes';
import {
  CHATTER_MAX_RETRIES,
  CHATTER_RETRY_BASE_DELAY_MS,
  getRetryDelayMs,
  isRateLimitError,
  isRetriableChunkError,
  wait,
} from '../../shared/utils/retry';
import { statusLabels, statusStyles } from '../../shared/ui/batchStatus';
import { QuoteSkeleton } from '../../shared/ui/skeletons';

interface UseChatterFeatureParams {
  provider: ProviderType;
  selectedModel: ModelType;
}

export interface ChatterFeatureController {
  inputMode: 'text' | 'file';
  chatterPane: 'analysis' | 'thread';
  textInput: string;
  batchFiles: BatchFile[];
  isAnalyzingBatch: boolean;
  batchProgress: BatchProgressState | null;
  chatterSingleState: ChatterAnalysisState;
  copyAllStatus: 'idle' | 'copied' | 'error';
  copyAllErrorMessage: string;
  chatterFileInputRef: React.RefObject<HTMLInputElement>;
  completedResults: ChatterAnalysisResult[];
  readyCount: number;
  isTextLoading: boolean;
  isChatterLoading: boolean;
  setInputMode: React.Dispatch<React.SetStateAction<'text' | 'file'>>;
  setChatterPane: React.Dispatch<React.SetStateAction<'analysis' | 'thread'>>;
  setTextInput: React.Dispatch<React.SetStateAction<string>>;
  handleAnalyzeText: () => Promise<void>;
  handleAnalyzeBatch: () => Promise<void>;
  handleChatterFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleCopyAllChatter: () => Promise<void>;
  removeBatchFile: (id: string) => void;
  retryBatchFile: (id: string) => void;
  clearChatter: () => void;
  sessionSlice: ChatterSessionSlice;
  restoreFromSessionSlice: (slice: ChatterSessionSlice) => void;
}

export const useChatterFeature = ({ provider, selectedModel }: UseChatterFeatureParams): ChatterFeatureController => {
  const [inputMode, setInputMode] = useState<'text' | 'file'>('file');
  const [chatterPane, setChatterPane] = useState<'analysis' | 'thread'>('analysis');
  const [textInput, setTextInput] = useState('');

  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isAnalyzingBatch, setIsAnalyzingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState | null>(null);
  const [chatterSingleState, setChatterSingleState] = useState<ChatterAnalysisState>({ status: 'idle' });
  const [copyAllStatus, setCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [copyAllErrorMessage, setCopyAllErrorMessage] = useState('');

  const chatterFileInputRef = useRef<HTMLInputElement>(null);

  const completedResults = useMemo((): ChatterAnalysisResult[] => {
    const results: ChatterAnalysisResult[] = [];

    if (chatterSingleState.status === 'complete' && chatterSingleState.result) {
      results.push(chatterSingleState.result);
    }

    batchFiles.forEach((file) => {
      if (file.result) {
        results.push(file.result);
      }
    });

    return results;
  }, [batchFiles, chatterSingleState]);

  const runTranscriptWithRetry = useCallback(
    async (
      transcript: string,
      providerType: ProviderType,
      modelId: ModelType,
      onProgress: (progress: ProgressEvent) => void,
      onRetryNotice: (message: string) => void,
    ): Promise<ChatterAnalysisResult> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= CHATTER_MAX_RETRIES; attempt++) {
        try {
          return await analyzeTranscript(transcript, providerType, modelId, onProgress);
        } catch (error: unknown) {
          lastError = error;
          const errorMessage = String((error as { message?: string })?.message || 'Analysis failed.');
          const isRetriable = isRetriableChunkError(errorMessage);
          if (attempt < CHATTER_MAX_RETRIES && isRetriable) {
            const retryCount = attempt + 1;
            const retryDelayMs = getRetryDelayMs(errorMessage, retryCount, CHATTER_RETRY_BASE_DELAY_MS);
            const retrySeconds = Math.max(1, Math.ceil(retryDelayMs / 1000));
            const retryReason = isRateLimitError(errorMessage) ? 'Rate limit reached' : 'Temporary upstream issue';
            onRetryNotice(`${retryReason}. Retrying in ${retrySeconds}s (${retryCount}/${CHATTER_MAX_RETRIES})...`);
            await wait(retryDelayMs);
            continue;
          }
          throw error;
        }
      }

      throw lastError || new Error('Analysis failed.');
    },
    [],
  );

  const handleAnalyzeText = useCallback(async () => {
    if (!textInput.trim()) return;

    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');
    setChatterSingleState({
      status: 'analyzing',
      progress: {
        stage: 'preparing',
        message: 'Preparing transcript for analysis...',
        percent: 8,
      },
    });

    try {
      const result = await runTranscriptWithRetry(
        textInput,
        provider,
        selectedModel,
        (progress) => {
          setChatterSingleState((prev) => ({
            ...prev,
            status: 'analyzing',
            progress,
          }));
        },
        (message) => {
          setChatterSingleState((prev) => ({
            ...prev,
            status: 'analyzing',
            progress: {
              stage: 'analyzing',
              message,
              percent: Math.min(92, Math.max(68, prev.progress?.percent ?? 82)),
            },
          }));
        },
      );

      setChatterSingleState({
        status: 'complete',
        result,
        progress: { stage: 'complete', message: 'Insights ready.', percent: 100 },
      });
    } catch (error: unknown) {
      setChatterSingleState({
        status: 'error',
        errorMessage: (error as { message?: string })?.message || 'Analysis failed.',
        progress: { stage: 'error', message: 'Analysis failed.', percent: 100 },
      });
    }
  }, [provider, runTranscriptWithRetry, selectedModel, textInput]);

  const handleAnalyzeBatch = useCallback(async () => {
    const pendingIndexes = batchFiles
      .map((file, index) => (file.status === 'ready' ? index : -1))
      .filter((index) => index !== -1);

    if (pendingIndexes.length === 0) return;

    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');
    setIsAnalyzingBatch(true);

    const nextFiles = [...batchFiles];

    const getCounts = () => ({
      completed: pendingIndexes.filter((index) => nextFiles[index].status === 'complete').length,
      failed: pendingIndexes.filter((index) => nextFiles[index].status === 'error').length,
    });

    setBatchProgress({
      total: pendingIndexes.length,
      completed: 0,
      failed: 0,
      progress: {
        stage: 'preparing',
        message: 'Starting batch analysis...',
        percent: 0,
      },
    });

    for (let queueIndex = 0; queueIndex < pendingIndexes.length; queueIndex++) {
      const fileIndex = pendingIndexes[queueIndex];
      const file = nextFiles[fileIndex];

      nextFiles[fileIndex] = {
        ...file,
        status: 'analyzing',
        error: undefined,
        progress: {
          stage: 'preparing',
          message: 'Preparing transcript for analysis...',
          percent: 8,
        },
      };
      setBatchFiles([...nextFiles]);

      try {
        const result = await runTranscriptWithRetry(
          nextFiles[fileIndex].content,
          provider,
          selectedModel,
          (progress) => {
            nextFiles[fileIndex] = {
              ...nextFiles[fileIndex],
              status: 'analyzing',
              progress,
            };
            setBatchFiles([...nextFiles]);

            const { completed, failed } = getCounts();
            const inFileRatio = (progress.percent ?? 0) / 100;
            const overallPercent = Math.round(((queueIndex + inFileRatio) / pendingIndexes.length) * 100);

            setBatchProgress({
              total: pendingIndexes.length,
              completed,
              failed,
              currentLabel: nextFiles[fileIndex].name,
              progress: {
                ...progress,
                percent: overallPercent,
              },
            });
          },
          (message) => {
            nextFiles[fileIndex] = {
              ...nextFiles[fileIndex],
              status: 'analyzing',
              progress: {
                stage: 'analyzing',
                message,
                percent: 92,
              },
            };
            setBatchFiles([...nextFiles]);

            const { completed, failed } = getCounts();
            const overallPercent = Math.round(((queueIndex + 0.92) / pendingIndexes.length) * 100);
            setBatchProgress({
              total: pendingIndexes.length,
              completed,
              failed,
              currentLabel: nextFiles[fileIndex].name,
              progress: {
                stage: 'analyzing',
                message,
                percent: overallPercent,
              },
            });
          },
        );

        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'complete',
          result,
          progress: {
            stage: 'complete',
            message: 'Insights ready.',
            percent: 100,
          },
        };
      } catch (error: unknown) {
        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'error',
          error: (error as { message?: string })?.message || 'Failed to analyze transcript.',
          progress: {
            stage: 'error',
            message: 'Failed to analyze transcript.',
            percent: 100,
          },
        };
      }

      setBatchFiles([...nextFiles]);
      const { completed, failed } = getCounts();
      const completedQueueItems = queueIndex + 1;

      setBatchProgress({
        total: pendingIndexes.length,
        completed,
        failed,
        currentLabel:
          completedQueueItems < pendingIndexes.length
            ? nextFiles[pendingIndexes[queueIndex + 1]].name
            : undefined,
        progress: {
          stage: completedQueueItems < pendingIndexes.length ? 'preparing' : 'complete',
          message: completedQueueItems < pendingIndexes.length ? 'Loading next transcript...' : 'Batch analysis complete.',
          percent: Math.round((completedQueueItems / pendingIndexes.length) * 100),
        },
      });
    }

    setIsAnalyzingBatch(false);
  }, [batchFiles, provider, runTranscriptWithRetry, selectedModel]);

  const handleChatterFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const timestamp = Date.now();
    const sourceFiles = Array.from(files) as File[];

    const parsedFiles = await Promise.all(
      sourceFiles.map(async (file, index): Promise<BatchFile> => {
        const batchItem: BatchFile = {
          id: `${file.name}-${timestamp}-${index}`,
          name: file.name,
          content: '',
          status: 'parsing',
        };

        try {
          if (file.name.toLowerCase().endsWith('.pdf')) {
            batchItem.content = await parsePdfToText(file);
          } else {
            batchItem.content = await file.text();
          }
          batchItem.status = 'ready';
        } catch (error: unknown) {
          batchItem.status = 'error';
          batchItem.error = (error as { message?: string })?.message || 'Unable to parse file.';
        }

        return batchItem;
      }),
    );

    setBatchFiles((prev) => [...prev, ...parsedFiles]);
    if (chatterFileInputRef.current) {
      chatterFileInputRef.current.value = '';
    }
  }, []);

  const handleCopyAllChatter = useCallback(async () => {
    if (completedResults.length === 0) return;

    const { html, text } = buildChatterClipboardExport(completedResults);
    const clipboard = navigator?.clipboard;

    if (!clipboard) {
      setCopyAllStatus('error');
      setCopyAllErrorMessage('Clipboard API is not available in this browser.');
      setTimeout(() => setCopyAllStatus('idle'), 3500);
      return;
    }

    try {
      const ClipboardItemCtor = (window as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (ClipboardItemCtor && window.isSecureContext) {
        const clipboardItem = new ClipboardItemCtor({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        });
        await clipboard.write([clipboardItem]);
      } else {
        await clipboard.writeText(text);
      }

      setCopyAllStatus('copied');
      setCopyAllErrorMessage('');
      setTimeout(() => setCopyAllStatus('idle'), 1800);
    } catch {
      try {
        await clipboard.writeText(text);
        setCopyAllStatus('copied');
        setCopyAllErrorMessage('');
        setTimeout(() => setCopyAllStatus('idle'), 1800);
      } catch (fallbackError: unknown) {
        setCopyAllStatus('error');
        setCopyAllErrorMessage(
          (fallbackError as { message?: string })?.message || 'Copy failed. Please allow clipboard access.',
        );
        setTimeout(() => setCopyAllStatus('idle'), 3500);
      }
    }
  }, [completedResults]);

  const removeBatchFile = useCallback((id: string) => {
    setBatchFiles((prev) => prev.filter((file) => file.id !== id));
  }, []);

  const retryBatchFile = useCallback(
    (id: string) => {
      if (isAnalyzingBatch) return;
      setBatchFiles((prev) =>
        prev.map((file) => {
          if (file.id !== id) return file;
          if (!file.content.trim()) return file;
          return {
            ...file,
            status: 'ready',
            error: undefined,
            result: undefined,
            progress: undefined,
          };
        }),
      );
    },
    [isAnalyzingBatch],
  );

  const clearChatter = useCallback(() => {
    setBatchFiles([]);
    setTextInput('');
    setChatterSingleState({ status: 'idle' });
    setBatchProgress(null);
    setIsAnalyzingBatch(false);
    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');
    if (chatterFileInputRef.current) chatterFileInputRef.current.value = '';
  }, []);

  const restoreFromSessionSlice = useCallback((slice: ChatterSessionSlice) => {
    setInputMode(slice.inputMode);
    setTextInput(slice.textInput);
    setBatchFiles(slice.batchFiles);
    setChatterSingleState(slice.chatterSingleState);
    setBatchProgress(null);
    setIsAnalyzingBatch(false);
    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');
  }, []);

  const sessionSlice = useMemo<ChatterSessionSlice>(
    () => ({
      inputMode,
      textInput,
      batchFiles,
      chatterSingleState,
    }),
    [batchFiles, chatterSingleState, inputMode, textInput],
  );

  const readyCount = batchFiles.filter((file) => file.status === 'ready').length;
  const isTextLoading = chatterSingleState.status === 'analyzing';
  const isChatterLoading = isTextLoading || isAnalyzingBatch;

  return {
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
    sessionSlice,
    restoreFromSessionSlice,
  };
};

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
