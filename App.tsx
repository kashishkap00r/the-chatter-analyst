import React, { useCallback, useRef, useState } from 'react';
import {
  analyzePresentation,
  analyzeTranscript,
  convertPdfToImages,
  parsePdfToText,
} from './services/geminiService';
import {
  ModelType,
  type AppMode,
  type BatchFile,
  type ChatterAnalysisResult,
  type ChatterAnalysisState,
  type PointsAnalysisState,
  type ProgressEvent,
} from './types';
import QuoteCard from './components/QuoteCard';
import PointsCard from './components/PointsCard';
import AnalysisProgressPanel from './components/AnalysisProgressPanel';
import { buildChatterClipboardExport } from './utils/chatterCopyExport';

interface BatchProgressState {
  total: number;
  completed: number;
  failed: number;
  currentLabel?: string;
  progress?: ProgressEvent;
}

const statusStyles: Record<BatchFile['status'], string> = {
  pending: 'bg-stone-100 text-stone-700 border-stone-200',
  parsing: 'bg-amber-50 text-amber-700 border-amber-200',
  ready: 'bg-sky-50 text-sky-700 border-sky-200',
  analyzing: 'bg-brand-soft text-brand border-brand/30',
  complete: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
};

const statusLabels: Record<BatchFile['status'], string> = {
  pending: 'Pending',
  parsing: 'Parsing',
  ready: 'Ready',
  analyzing: 'Analyzing',
  complete: 'Complete',
  error: 'Error',
};

const QuoteSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-line bg-white shadow-panel p-5 sm:p-6 animate-pulse">
    <div className="h-4 w-28 bg-line rounded mb-4" />
    <div className="h-20 bg-canvas rounded-xl mb-4" />
    <div className="h-5 w-11/12 bg-line rounded mb-2" />
    <div className="h-5 w-10/12 bg-line rounded mb-6" />
    <div className="h-4 w-40 bg-line rounded ml-auto" />
  </div>
);

const SlideSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-line bg-white shadow-panel p-5 sm:p-6 animate-pulse">
    <div className="h-6 w-48 bg-line rounded mb-4" />
    <div className="h-52 bg-canvas rounded-xl mb-4" />
    <div className="h-4 w-full bg-line rounded mb-2" />
    <div className="h-4 w-5/6 bg-line rounded" />
  </div>
);

const mapPointsProgress = (message: string): ProgressEvent => {
  const convertedMatch = message.match(/Converted page (\d+) of (\d+)/i);
  if (convertedMatch) {
    const current = Number(convertedMatch[1]);
    const total = Number(convertedMatch[2]);
    const ratio = total > 0 ? current / total : 0;
    return {
      stage: 'uploading',
      message,
      current,
      total,
      percent: Math.round(15 + ratio * 55),
    };
  }

  const convertingMatch = message.match(/Converting (\d+) pages/i);
  if (convertingMatch) {
    return {
      stage: 'uploading',
      message,
      current: 0,
      total: Number(convertingMatch[1]),
      percent: 15,
    };
  }

  if (/analyzing/i.test(message)) {
    return {
      stage: 'analyzing',
      message,
      percent: 78,
    };
  }

  return {
    stage: 'preparing',
    message,
    percent: 8,
  };
};

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('chatter');
  const [inputMode, setInputMode] = useState<'text' | 'file'>('file');
  const [textInput, setTextInput] = useState('');
  const [model, setModel] = useState<ModelType>(ModelType.FLASH);

  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isAnalyzingBatch, setIsAnalyzingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState | null>(null);
  const [chatterSingleState, setChatterSingleState] = useState<ChatterAnalysisState>({ status: 'idle' });
  const [copyAllStatus, setCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [copyAllErrorMessage, setCopyAllErrorMessage] = useState('');

  const [pointsFile, setPointsFile] = useState<File | null>(null);
  const [pointsState, setPointsState] = useState<PointsAnalysisState>({ status: 'idle' });

  const chatterFileInputRef = useRef<HTMLInputElement>(null);
  const pointsFileInputRef = useRef<HTMLInputElement>(null);

  const getCompletedChatterResults = useCallback((): ChatterAnalysisResult[] => {
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
      const result = await analyzeTranscript(textInput, model, (progress) => {
        setChatterSingleState((prev) => ({
          ...prev,
          status: 'analyzing',
          progress,
        }));
      });

      setChatterSingleState({
        status: 'complete',
        result,
        progress: { stage: 'complete', message: 'Insights ready.', percent: 100 },
      });
    } catch (error: any) {
      setChatterSingleState({
        status: 'error',
        errorMessage: error?.message || 'Analysis failed.',
        progress: { stage: 'error', message: 'Analysis failed.', percent: 100 },
      });
    }
  }, [model, textInput]);

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
        const result = await analyzeTranscript(nextFiles[fileIndex].content, model, (progress) => {
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
        });

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
      } catch (error: any) {
        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'error',
          error: error?.message || 'Failed to analyze transcript.',
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
  }, [batchFiles, model]);

  const handleChatterFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
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
        } catch (error: any) {
          batchItem.status = 'error';
          batchItem.error = error?.message || 'Unable to parse file.';
        }

        return batchItem;
      }),
    );

    setBatchFiles((prev) => [...prev, ...parsedFiles]);
    if (chatterFileInputRef.current) {
      chatterFileInputRef.current.value = '';
    }
  };

  const handlePointsFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (file && file.type === 'application/pdf') {
      setPointsFile(file);
      setPointsState({ status: 'idle' });
      return;
    }

    if (file) {
      setPointsFile(null);
      setPointsState({
        status: 'error',
        errorMessage: 'Only PDF files are supported for presentations.',
        progress: { stage: 'error', message: 'Unsupported file format.', percent: 100 },
      });
    }
  };

  const handleAnalyzePresentation = useCallback(async () => {
    if (!pointsFile) return;

    setPointsState({
      status: 'parsing',
      progressMessage: 'Preparing PDF...',
      progress: {
        stage: 'preparing',
        message: 'Preparing PDF...',
        percent: 8,
      },
    });

    const onProgress = (message: string) => {
      const progress = mapPointsProgress(message);
      setPointsState((prev) => ({
        ...prev,
        status: progress.stage === 'analyzing' ? 'analyzing' : 'parsing',
        progressMessage: message,
        progress,
      }));
    };

    try {
      const pageImages = await convertPdfToImages(pointsFile, onProgress);
      setPointsState((prev) => ({
        ...prev,
        status: 'analyzing',
        progressMessage: 'Analyzing slides with AI...',
        progress: {
          stage: 'analyzing',
          message: 'Analyzing slides with AI...',
          percent: 80,
        },
      }));

      const result = await analyzePresentation(pageImages, onProgress);
      setPointsState({
        status: 'complete',
        result,
        progressMessage: 'Analysis complete.',
        progress: {
          stage: 'complete',
          message: 'Analysis complete.',
          percent: 100,
        },
      });
    } catch (error: any) {
      setPointsState({
        status: 'error',
        errorMessage: error?.message || 'Failed to analyze presentation.',
        progressMessage: 'Analysis failed.',
        progress: {
          stage: 'error',
          message: 'Analysis failed.',
          percent: 100,
        },
      });
    }
  }, [pointsFile]);

  const handleCopyAllChatter = useCallback(async () => {
    const completedResults = getCompletedChatterResults();
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
      const ClipboardItemCtor = (window as any).ClipboardItem;
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
      } catch (fallbackError: any) {
        setCopyAllStatus('error');
        setCopyAllErrorMessage(fallbackError?.message || 'Copy failed. Please allow clipboard access.');
        setTimeout(() => setCopyAllStatus('idle'), 3500);
      }
    }
  }, [getCompletedChatterResults]);

  const removeBatchFile = (id: string) => {
    setBatchFiles((prev) => prev.filter((file) => file.id !== id));
  };

  const clearAll = () => {
    setBatchFiles([]);
    setTextInput('');
    setChatterSingleState({ status: 'idle' });
    setBatchProgress(null);
    setIsAnalyzingBatch(false);
    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');

    setPointsFile(null);
    setPointsState({ status: 'idle' });

    if (chatterFileInputRef.current) chatterFileInputRef.current.value = '';
    if (pointsFileInputRef.current) pointsFileInputRef.current.value = '';
  };

  const completedResults = getCompletedChatterResults();
  const readyCount = batchFiles.filter((file) => file.status === 'ready').length;
  const isTextLoading = chatterSingleState.status === 'analyzing';
  const isChatterLoading = isTextLoading || isAnalyzingBatch;
  const isPointsLoading = pointsState.status === 'parsing' || pointsState.status === 'analyzing';

  const renderChatterWorkbench = () => (
    <section className="lg:col-span-5 lg:sticky lg:top-24 self-start">
      <div className="rounded-2xl border border-line bg-white shadow-panel p-5 sm:p-6">
        <header className="mb-5">
          <p className="text-xs uppercase tracking-[0.16em] text-stone font-semibold">Input Desk</p>
          <h2 className="font-serif text-2xl mt-1">Transcript Input</h2>
        </header>

        <div className="inline-flex rounded-xl border border-line bg-canvas p-1 mb-4 w-full">
          <button
            onClick={() => setInputMode('file')}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
              inputMode === 'file' ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink'
            }`}
          >
            Files (Batch)
          </button>
          <button
            onClick={() => setInputMode('text')}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
              inputMode === 'text' ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink'
            }`}
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
                onChange={handleChatterFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>

            <div className="mt-4 space-y-2 max-h-[320px] overflow-y-auto pr-1">
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
                      {file.error && <p className="text-xs text-rose-700 mt-1 truncate">{file.error}</p>}
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
                    <button
                      onClick={() => removeBatchFile(file.id)}
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
            onClick={clearAll}
            disabled={isChatterLoading}
            className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
          >
            Clear
          </button>
          {inputMode === 'text' ? (
            <button
              onClick={handleAnalyzeText}
              disabled={!textInput.trim() || isTextLoading}
              className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
            >
              {isTextLoading ? 'Analyzing...' : 'Extract Insights'}
            </button>
          ) : (
            <button
              onClick={handleAnalyzeBatch}
              disabled={readyCount === 0 || isAnalyzingBatch}
              className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
            >
              {isAnalyzingBatch ? 'Processing Batch...' : `Analyze ${readyCount} File${readyCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </section>
  );

  const renderChatterResults = () => (
    <section className="lg:col-span-7 space-y-6">
      {completedResults.length > 0 && (
        <div className="rounded-2xl border border-line bg-white shadow-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-stone">
            {completedResults.length} compan{completedResults.length === 1 ? 'y' : 'ies'} ready for newsletter export.
          </p>
          <button
            onClick={handleCopyAllChatter}
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
        <div className="rounded-2xl border border-dashed border-line bg-white/70 p-10 text-center shadow-panel">
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
    </section>
  );

  const renderPointsWorkbench = () => (
    <section className="lg:col-span-5 lg:sticky lg:top-24 self-start">
      <div className="rounded-2xl border border-line bg-white shadow-panel p-5 sm:p-6">
        <header className="mb-5">
          <p className="text-xs uppercase tracking-[0.16em] text-stone font-semibold">Input Desk</p>
          <h2 className="font-serif text-2xl mt-1">Presentation Input</h2>
        </header>

        <div className="relative rounded-xl border-2 border-dashed border-line bg-canvas/45 px-4 py-7 text-center hover:border-brand/45 transition-colors">
          <p className="text-sm font-medium text-stone">Drop or select presentation file</p>
          <p className="text-xs text-stone/80 mt-1">PDF only</p>
          <input
            ref={pointsFileInputRef}
            type="file"
            accept=".pdf"
            onChange={handlePointsFileUpload}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>

        {pointsFile && (
          <div className="mt-4 rounded-xl border border-line bg-canvas px-3 py-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-ink truncate">{pointsFile.name}</p>
            <button
              onClick={() => {
                setPointsFile(null);
                setPointsState({ status: 'idle' });
                if (pointsFileInputRef.current) pointsFileInputRef.current.value = '';
              }}
              className="text-stone hover:text-rose-700 text-sm leading-none"
              title="Remove file"
              aria-label="Remove file"
            >
              X
            </button>
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-line flex gap-3">
          <button
            onClick={clearAll}
            disabled={isPointsLoading}
            className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
          >
            Clear
          </button>
          <button
            onClick={handleAnalyzePresentation}
            disabled={!pointsFile || isPointsLoading}
            className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
          >
            {isPointsLoading ? 'Analyzing...' : 'Find Top 3 Slides'}
          </button>
        </div>
      </div>
    </section>
  );

  const renderPointsResults = () => (
    <section className="lg:col-span-7 space-y-6">
      {isPointsLoading && (
        <>
          <AnalysisProgressPanel
            title="Presentation Analysis Running"
            subtitle="Parsing slides and ranking the highest-signal pages."
            progress={pointsState.progress}
          />
          <SlideSkeleton />
          <SlideSkeleton />
        </>
      )}

      {pointsState.status === 'error' && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{pointsState.errorMessage}</div>
      )}

      {pointsState.status === 'idle' && !isPointsLoading && (
        <div className="rounded-2xl border border-dashed border-line bg-white/70 p-10 text-center shadow-panel">
          <h3 className="font-serif text-2xl text-ink">Ready to analyze a presentation</h3>
          <p className="text-sm text-stone mt-2">
            Upload an investor deck and we will surface the 3 slides with the strongest narrative value.
          </p>
        </div>
      )}

      {pointsState.status === 'complete' && pointsState.result && (
        <div className="space-y-5">
          <header>
            <h2 className="font-serif text-3xl text-ink">{pointsState.result.companyName}</h2>
            <p className="text-sm text-stone">{pointsState.result.fiscalPeriod} - Key Insights</p>
          </header>
          <div className="space-y-5">
            {pointsState.result.slides.map((slide, index) => (
              <PointsCard key={slide.selectedPageNumber} slide={slide} index={index + 1} />
            ))}
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div className="min-h-screen text-ink relative overflow-x-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(15,118,110,0.12),transparent_45%),radial-gradient(circle_at_90%_20%,rgba(15,23,42,0.06),transparent_35%)]" />

      <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-brand text-white font-serif font-bold text-xl grid place-items-center">C</div>
                <div>
                  <h1 className="font-serif text-2xl leading-none">Chatter Analyst</h1>
                  <p className="text-xs uppercase tracking-[0.15em] text-stone mt-1">Research Workflow Studio</p>
                </div>
              </div>

              {appMode === 'chatter' && (
                <label className="text-sm font-semibold text-stone">
                  Model
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value as ModelType)}
                    className="ml-2 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink"
                  >
                    <option value={ModelType.FLASH}>Gemini 2.5 Flash (Fast)</option>
                    <option value={ModelType.PRO}>Gemini 3 Pro (Deep)</option>
                  </select>
                </label>
              )}
            </div>

            <div className="inline-flex rounded-xl border border-line bg-white p-1 max-w-xl w-full">
              <button
                onClick={() => {
                  setAppMode('chatter');
                  clearAll();
                }}
                className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                  appMode === 'chatter' ? 'bg-canvas text-ink shadow-sm' : 'text-stone hover:text-ink'
                }`}
              >
                The Chatter
              </button>
              <button
                onClick={() => {
                  setAppMode('points');
                  clearAll();
                }}
                className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                  appMode === 'points' ? 'bg-canvas text-ink shadow-sm' : 'text-stone hover:text-ink'
                }`}
              >
                Points & Figures
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {appMode === 'chatter' ? (
            <>
              {renderChatterWorkbench()}
              {renderChatterResults()}
            </>
          ) : (
            <>
              {renderPointsWorkbench()}
              {renderPointsResults()}
            </>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
