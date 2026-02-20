import React, { useCallback, useRef, useState } from 'react';
import {
  analyzePresentation,
  analyzeTranscript,
  convertPdfToImages,
  getPdfPageCount,
  parsePdfToText,
} from './services/geminiService';
import {
  ModelType,
  type AppMode,
  type BatchFile,
  type ChatterAnalysisResult,
  type ChatterAnalysisState,
  type PointsAndFiguresResult,
  type PointsBatchFile,
  type ProgressEvent,
} from './types';
import QuoteCard from './components/QuoteCard';
import PointsCard from './components/PointsCard';
import AnalysisProgressPanel from './components/AnalysisProgressPanel';
import { buildChatterClipboardExport } from './utils/chatterCopyExport';
import { buildPointsClipboardExport } from './utils/pointsCopyExport';

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

const POINTS_CHUNK_SIZE = 12;
const POINTS_MAX_IMAGE_PAYLOAD_CHARS = 20 * 1024 * 1024;
const POINTS_CHUNK_MAX_RETRIES = 2;
const CHATTER_MAX_RETRIES = 2;
const CHATTER_RETRY_BASE_DELAY_MS = 1800;
const POINTS_RETRY_BASE_DELAY_MS = 1200;
const MAX_RETRY_DELAY_MS = 90 * 1000;
const POINTS_RETRY_RENDER_PROFILES = [
  { scale: 1.15, jpegQuality: 0.75 },
  { scale: 1.0, jpegQuality: 0.65 },
  { scale: 0.85, jpegQuality: 0.55 },
];

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

const firstNonEmpty = (...values: Array<string | undefined>): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

const mergePointsChunkResults = (results: PointsAndFiguresResult[]): PointsAndFiguresResult => {
  const mergedSlides = new Map<number, PointsAndFiguresResult['slides'][number]>();

  for (const result of results) {
    for (const slide of result.slides) {
      if (!mergedSlides.has(slide.selectedPageNumber)) {
        mergedSlides.set(slide.selectedPageNumber, slide);
      }
    }
  }

  const sortedSlides = Array.from(mergedSlides.values()).sort((a, b) => a.selectedPageNumber - b.selectedPageNumber);
  const base = results[0];

  return {
    companyName: firstNonEmpty(...results.map((result) => result.companyName)) || base.companyName,
    fiscalPeriod: firstNonEmpty(...results.map((result) => result.fiscalPeriod)) || base.fiscalPeriod,
    nseScrip: firstNonEmpty(...results.map((result) => result.nseScrip)) || base.nseScrip,
    marketCapCategory: firstNonEmpty(...results.map((result) => result.marketCapCategory)) || base.marketCapCategory,
    industry: firstNonEmpty(...results.map((result) => result.industry)) || base.industry,
    companyDescription: firstNonEmpty(...results.map((result) => result.companyDescription)) || base.companyDescription,
    zerodhaStockUrl: firstNonEmpty(...results.map((result) => result.zerodhaStockUrl)),
    slides: sortedSlides,
  };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const extractHttpStatus = (message: string): number | null => {
  const match = message.match(/status\s+(\d{3})/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
};

const extractRetryAfterMs = (message: string): number | null => {
  const match = message.match(/retry in\s+([\d.]+)s/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(parsed * 1000) + 1200);
};

const isRateLimitError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('quota') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('generate_content_free_tier_requests')
  );
};

const getRetryDelayMs = (message: string, retryCount: number, baseDelayMs: number): number => {
  const retryAfterMs = extractRetryAfterMs(message);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }
  return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * retryCount);
};

const isRetriableChunkError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  const httpStatus = extractHttpStatus(message);
  const isRetriableStatus = httpStatus !== null && (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599));

  return (
    isRetriableStatus ||
    isRateLimitError(message) ||
    normalized.includes("429") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("bad gateway") ||
    normalized.includes("gateway timeout") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("timeout") ||
    normalized.includes("overload") ||
    normalized.includes("unable to process input image") ||
    normalized.includes("upstream")
  );
};

const getDynamicChunkSize = (fileSizeBytes: number, pageCount: number): number => {
  const bytesPerPage = fileSizeBytes / Math.max(1, pageCount);
  if (bytesPerPage > 550 * 1024) return 6;
  if (bytesPerPage > 320 * 1024) return 8;
  return POINTS_CHUNK_SIZE;
};

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('chatter');
  const [inputMode, setInputMode] = useState<'text' | 'file'>('file');
  const [textInput, setTextInput] = useState('');
  const [model, setModel] = useState<ModelType>(ModelType.FLASH);
  const [pointsModel, setPointsModel] = useState<ModelType>(ModelType.FLASH);

  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isAnalyzingBatch, setIsAnalyzingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState | null>(null);
  const [chatterSingleState, setChatterSingleState] = useState<ChatterAnalysisState>({ status: 'idle' });
  const [copyAllStatus, setCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [copyAllErrorMessage, setCopyAllErrorMessage] = useState('');

  const [pointsBatchFiles, setPointsBatchFiles] = useState<PointsBatchFile[]>([]);
  const [isAnalyzingPointsBatch, setIsAnalyzingPointsBatch] = useState(false);
  const [pointsBatchProgress, setPointsBatchProgress] = useState<BatchProgressState | null>(null);
  const [pointsCopyAllStatus, setPointsCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [pointsCopyAllErrorMessage, setPointsCopyAllErrorMessage] = useState('');

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

  const getCompletedPointsResults = useCallback((): PointsAndFiguresResult[] => {
    return pointsBatchFiles.filter((file) => file.result).map((file) => file.result!) as PointsAndFiguresResult[];
  }, [pointsBatchFiles]);

  const runTranscriptWithRetry = useCallback(
    async (
      transcript: string,
      modelId: ModelType,
      onProgress: (progress: ProgressEvent) => void,
      onRetryNotice: (message: string) => void,
    ): Promise<ChatterAnalysisResult> => {
      let lastError: any = null;
      for (let attempt = 0; attempt <= CHATTER_MAX_RETRIES; attempt++) {
        try {
          return await analyzeTranscript(transcript, modelId, onProgress);
        } catch (error: any) {
          lastError = error;
          const errorMessage = String(error?.message || 'Analysis failed.');
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
        model,
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
    } catch (error: any) {
      setChatterSingleState({
        status: 'error',
        errorMessage: error?.message || 'Analysis failed.',
        progress: { stage: 'error', message: 'Analysis failed.', percent: 100 },
      });
    }
  }, [model, runTranscriptWithRetry, textInput]);

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
          model,
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
  }, [batchFiles, model, runTranscriptWithRetry]);

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
    const files = event.target.files;
    if (!files) return;

    const timestamp = Date.now();
    const sourceFiles = Array.from(files) as File[];
    const mappedFiles = sourceFiles.map((file, index): PointsBatchFile => {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      return {
        id: `${file.name}-${timestamp}-${index}`,
        name: file.name,
        file,
        status: isPdf ? 'ready' : 'error',
        error: isPdf ? undefined : 'Only PDF files are supported for presentations.',
      };
    });

    setPointsBatchFiles((prev) => [...prev, ...mappedFiles]);
    if (pointsFileInputRef.current) {
      pointsFileInputRef.current.value = '';
    }
  };

  const handleAnalyzePointsBatch = useCallback(async () => {
    const pendingIndexes = pointsBatchFiles
      .map((file, index) => (file.status === 'ready' ? index : -1))
      .filter((index) => index !== -1);

    if (pendingIndexes.length === 0) return;

    setPointsCopyAllStatus('idle');
    setPointsCopyAllErrorMessage('');
    setIsAnalyzingPointsBatch(true);

    const nextFiles = [...pointsBatchFiles];
    const getCounts = () => ({
      completed: pendingIndexes.filter((index) => nextFiles[index].status === 'complete').length,
      failed: pendingIndexes.filter((index) => nextFiles[index].status === 'error').length,
    });

    setPointsBatchProgress({
      total: pendingIndexes.length,
      completed: 0,
      failed: 0,
      progress: {
        stage: 'preparing',
        message: 'Starting presentation analysis...',
        percent: 0,
      },
    });

    for (let queueIndex = 0; queueIndex < pendingIndexes.length; queueIndex++) {
      const fileIndex = pendingIndexes[queueIndex];
      const currentFile = nextFiles[fileIndex];

      nextFiles[fileIndex] = {
        ...currentFile,
        status: 'analyzing',
        error: undefined,
        progress: {
          stage: 'preparing',
          message: 'Preparing presentation...',
          percent: 8,
        },
      };
      setPointsBatchFiles([...nextFiles]);

      try {
        const pageCount = await getPdfPageCount(nextFiles[fileIndex].file);
        const initialChunkSize = getDynamicChunkSize(nextFiles[fileIndex].file.size, pageCount);
        const ranges: Array<{ startPage: number; endPage: number }> = [];
        for (let startPage = 1; startPage <= pageCount; startPage += initialChunkSize) {
          ranges.push({
            startPage,
            endPage: Math.min(pageCount, startPage + initialChunkSize - 1),
          });
        }

        const chunkResults: PointsAndFiguresResult[] = [];
        const failedChunks: string[] = [];

        for (let chunkIndex = 0; chunkIndex < ranges.length; chunkIndex++) {
          const range = ranges[chunkIndex];
          const chunkLabel = `Chunk ${chunkIndex + 1}/${ranges.length}`;
          let chunkSucceeded = false;

          const onChunkProgress = (rawMessage: string) => {
            const mappedProgress = mapPointsProgress(rawMessage);
            const inChunkRatio = (mappedProgress.percent ?? 0) / 100;
            const filePercent = Math.round(((chunkIndex + inChunkRatio) / ranges.length) * 100);

            nextFiles[fileIndex] = {
              ...nextFiles[fileIndex],
              status: 'analyzing',
              progress: {
                ...mappedProgress,
                message: `${chunkLabel}: ${mappedProgress.message}`,
                percent: filePercent,
              },
            };
            setPointsBatchFiles([...nextFiles]);

            const { completed, failed } = getCounts();
            const overallPercent = Math.round(((queueIndex + filePercent / 100) / pendingIndexes.length) * 100);

            setPointsBatchProgress({
              total: pendingIndexes.length,
              completed,
              failed,
              currentLabel: nextFiles[fileIndex].name,
              progress: {
                ...mappedProgress,
                message: `${chunkLabel}: ${mappedProgress.message}`,
                percent: overallPercent,
              },
            });
          };

          for (let attempt = 0; attempt <= POINTS_CHUNK_MAX_RETRIES; attempt++) {
            try {
              const renderProfile =
                POINTS_RETRY_RENDER_PROFILES[Math.min(attempt, POINTS_RETRY_RENDER_PROFILES.length - 1)];
              const pageImages = await convertPdfToImages(nextFiles[fileIndex].file, onChunkProgress, {
                startPage: range.startPage,
                endPage: range.endPage,
                scale: renderProfile.scale,
                jpegQuality: renderProfile.jpegQuality,
              });

              const payloadChars = pageImages.reduce((sum, image) => sum + image.length, 0);
              if (payloadChars > POINTS_MAX_IMAGE_PAYLOAD_CHARS) {
                const rangeLength = range.endPage - range.startPage + 1;
                if (rangeLength <= 1) {
                  throw new Error(
                    `${chunkLabel} (pages ${range.startPage}-${range.endPage}) is too large even for a single page.`,
                  );
                }

                const midPoint = Math.floor((range.startPage + range.endPage) / 2);
                ranges.splice(
                  chunkIndex,
                  1,
                  { startPage: range.startPage, endPage: midPoint },
                  { startPage: midPoint + 1, endPage: range.endPage },
                );
                onChunkProgress(`${chunkLabel}: payload too large, splitting to smaller ranges...`);
                chunkIndex -= 1;
                chunkSucceeded = true;
                break;
              }

              const chunkResult = await analyzePresentation(
                pageImages,
                (message) => onChunkProgress(message),
                range.startPage - 1,
                pointsModel,
              );
              chunkResults.push(chunkResult);
              chunkSucceeded = true;
              break;
            } catch (error: any) {
              const errorMessage = String(error?.message || "Unknown chunk failure");
              const isRetriable = isRetriableChunkError(errorMessage);
              const isRateLimited = isRateLimitError(errorMessage);
              if (attempt < POINTS_CHUNK_MAX_RETRIES && isRetriable) {
                const retryCount = attempt + 1;
                const retryDelayMs = getRetryDelayMs(errorMessage, retryCount, POINTS_RETRY_BASE_DELAY_MS);
                const retrySeconds = Math.max(1, Math.ceil(retryDelayMs / 1000));
                onChunkProgress(
                  `${chunkLabel}: ${
                    isRateLimited ? 'rate limit reached' : 'transient error'
                  }, retrying in ${retrySeconds}s (${retryCount}/${POINTS_CHUNK_MAX_RETRIES})...`,
                );
                await wait(retryDelayMs);
                continue;
              }

              const rangeLength = range.endPage - range.startPage + 1;
              if (isRetriable && rangeLength > 1 && !isRateLimited) {
                const midPoint = Math.floor((range.startPage + range.endPage) / 2);
                ranges.splice(
                  chunkIndex,
                  1,
                  { startPage: range.startPage, endPage: midPoint },
                  { startPage: midPoint + 1, endPage: range.endPage },
                );
                onChunkProgress(`${chunkLabel}: splitting range due repeated upstream failures...`);
                chunkIndex -= 1;
                chunkSucceeded = true;
                break;
              }

              failedChunks.push(
                `${chunkLabel} pages ${range.startPage}-${range.endPage} failed: ${errorMessage}`,
              );
              break;
            }
          }

          if (!chunkSucceeded) {
            continue;
          }
        }

        if (chunkResults.length === 0) {
          const details = failedChunks[0] || 'No analyzable chunks were produced for this presentation.';
          throw new Error(details);
        }

        const result = mergePointsChunkResults(chunkResults);
        if (result.slides.length === 0) {
          throw new Error('No valid insight slides were selected across chunks.');
        }
        const partialWarning =
          failedChunks.length > 0 ? `Partial analysis: ${failedChunks.length} chunk(s) failed. ${failedChunks[0]}` : undefined;
        const completionMessage =
          result.slides.length < 3
            ? `Analysis complete with ${result.slides.length} high-signal slide${result.slides.length === 1 ? '' : 's'}.`
            : partialWarning
              ? 'Analysis complete with partial chunk coverage.'
              : 'Analysis complete.';

        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'complete',
          result,
          error: partialWarning,
          progress: {
            stage: 'complete',
            message: completionMessage,
            percent: 100,
          },
        };
      } catch (error: any) {
        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'error',
          error: error?.message || 'Failed to analyze presentation.',
          progress: {
            stage: 'error',
            message: 'Analysis failed.',
            percent: 100,
          },
        };
      }

      setPointsBatchFiles([...nextFiles]);
      const { completed, failed } = getCounts();
      const completedQueueItems = queueIndex + 1;

      setPointsBatchProgress({
        total: pendingIndexes.length,
        completed,
        failed,
        currentLabel:
          completedQueueItems < pendingIndexes.length
            ? nextFiles[pendingIndexes[queueIndex + 1]].name
            : undefined,
        progress: {
          stage: completedQueueItems < pendingIndexes.length ? 'preparing' : 'complete',
          message:
            completedQueueItems < pendingIndexes.length ? 'Loading next presentation...' : 'Batch analysis complete.',
          percent: Math.round((completedQueueItems / pendingIndexes.length) * 100),
        },
      });
    }

    setIsAnalyzingPointsBatch(false);
  }, [pointsBatchFiles, pointsModel]);

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

  const handleCopyAllPoints = useCallback(async () => {
    const completedResults = getCompletedPointsResults();
    if (completedResults.length === 0) return;

    const { html, text } = buildPointsClipboardExport(completedResults);
    const clipboard = navigator?.clipboard;

    if (!clipboard) {
      setPointsCopyAllStatus('error');
      setPointsCopyAllErrorMessage('Clipboard API is not available in this browser.');
      setTimeout(() => setPointsCopyAllStatus('idle'), 3500);
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

      setPointsCopyAllStatus('copied');
      setPointsCopyAllErrorMessage('');
      setTimeout(() => setPointsCopyAllStatus('idle'), 1800);
    } catch {
      try {
        await clipboard.writeText(text);
        setPointsCopyAllStatus('copied');
        setPointsCopyAllErrorMessage('');
        setTimeout(() => setPointsCopyAllStatus('idle'), 1800);
      } catch (fallbackError: any) {
        setPointsCopyAllStatus('error');
        setPointsCopyAllErrorMessage(fallbackError?.message || 'Copy failed. Please allow clipboard access.');
        setTimeout(() => setPointsCopyAllStatus('idle'), 3500);
      }
    }
  }, [getCompletedPointsResults]);

  const removeBatchFile = (id: string) => {
    setBatchFiles((prev) => prev.filter((file) => file.id !== id));
  };

  const removePointsBatchFile = (id: string) => {
    setPointsBatchFiles((prev) => prev.filter((file) => file.id !== id));
  };

  const retryBatchFile = (id: string) => {
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
  };

  const retryPointsBatchFile = (id: string) => {
    if (isAnalyzingPointsBatch) return;
    setPointsBatchFiles((prev) =>
      prev.map((file) => {
        if (file.id !== id) return file;
        return {
          ...file,
          status: 'ready',
          error: undefined,
          result: undefined,
          progress: undefined,
        };
      }),
    );
  };

  const clearChatter = () => {
    setBatchFiles([]);
    setTextInput('');
    setChatterSingleState({ status: 'idle' });
    setBatchProgress(null);
    setIsAnalyzingBatch(false);
    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');
    if (chatterFileInputRef.current) chatterFileInputRef.current.value = '';
  };

  const clearPoints = () => {
    setPointsBatchFiles([]);
    setIsAnalyzingPointsBatch(false);
    setPointsBatchProgress(null);
    setPointsCopyAllStatus('idle');
    setPointsCopyAllErrorMessage('');
    if (pointsFileInputRef.current) pointsFileInputRef.current.value = '';
  };

  const completedResults = getCompletedChatterResults();
  const readyCount = batchFiles.filter((file) => file.status === 'ready').length;
  const completedPointsResults = getCompletedPointsResults();
  const pointsReadyCount = pointsBatchFiles.filter((file) => file.status === 'ready').length;
  const isTextLoading = chatterSingleState.status === 'analyzing';
  const isChatterLoading = isTextLoading || isAnalyzingBatch;
  const isPointsLoading = isAnalyzingPointsBatch;

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
                        className="text-xs font-semibold text-brand hover:text-ink"
                        title="Retry file"
                      >
                        Retry
                      </button>
                    )}
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
            onClick={clearChatter}
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
          <p className="text-sm font-medium text-stone">Drop or select presentation files</p>
          <p className="text-xs text-stone/80 mt-1">PDF only, batch supported</p>
          <input
            ref={pointsFileInputRef}
            type="file"
            accept=".pdf"
            multiple
            onChange={handlePointsFileUpload}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>

        <div className="mt-4 space-y-2 max-h-[320px] overflow-y-auto pr-1">
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
                    className="text-xs font-semibold text-brand hover:text-ink"
                    title="Retry file"
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={() => removePointsBatchFile(file.id)}
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
            disabled={isPointsLoading}
            className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
          >
            Clear
          </button>
          <button
            onClick={handleAnalyzePointsBatch}
            disabled={pointsReadyCount === 0 || isPointsLoading}
            className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
          >
            {isPointsLoading ? 'Processing Batch...' : `Analyze ${pointsReadyCount} File${pointsReadyCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </section>
  );

  const renderPointsResults = () => (
    <section className="lg:col-span-7 space-y-6">
      {completedPointsResults.length > 0 && (
        <div className="rounded-2xl border border-line bg-white shadow-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-stone">
            {completedPointsResults.length} compan{completedPointsResults.length === 1 ? 'y' : 'ies'} ready for Points export.
          </p>
          <button
            onClick={handleCopyAllPoints}
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
        <div className="rounded-2xl border border-dashed border-line bg-white/70 p-10 text-center shadow-panel">
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

              <div className="flex flex-wrap items-center justify-end gap-3">
                <label className="text-sm font-semibold text-stone">
                  Model
                  <select
                    value={appMode === 'chatter' ? model : pointsModel}
                    onChange={(event) => {
                      const selectedModel = event.target.value as ModelType;
                      if (appMode === 'chatter') {
                        setModel(selectedModel);
                      } else {
                        setPointsModel(selectedModel);
                      }
                    }}
                    className="ml-2 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink"
                  >
                    <option value={ModelType.FLASH}>Gemini 2.5 Flash (Fast)</option>
                    <option value={ModelType.FLASH_3}>Gemini 3 Flash (Balanced)</option>
                    <option value={ModelType.PRO}>Gemini 3 Pro (Deep)</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="inline-flex rounded-xl border border-line bg-white p-1 max-w-xl w-full">
              <button
                onClick={() => {
                  setAppMode('chatter');
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
