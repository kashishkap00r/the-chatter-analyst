import React, { useCallback, useMemo, useRef, useState } from 'react';
import AnalysisProgressPanel from '../../../components/AnalysisProgressPanel';
import PointsCard from '../../../components/PointsCard';
import {
  analyzePresentation,
  convertPdfToImages,
  getPdfPageCount,
  renderPdfPagesHighQuality,
} from '../../../services/geminiService';
import type { ModelType, PointsAndFiguresResult, PointsBatchFile, ProviderType, ProgressEvent } from '../../../types';
import { buildPointsClipboardExport } from '../../../utils/pointsCopyExport';
import type { BatchProgressState, PointsSessionSlice } from '../../shared/state/sessionTypes';
import {
  POINTS_CHUNK_MAX_RETRIES,
  POINTS_RETRY_BASE_DELAY_MS,
  getRetryDelayMs,
  isLocationUnsupportedChunkError,
  isRateLimitError,
  isRetriableChunkError,
  wait,
} from '../../shared/utils/retry';
import { statusLabels, statusStyles } from '../../shared/ui/batchStatus';
import { SlideSkeleton } from '../../shared/ui/skeletons';

const POINTS_CHUNK_SIZE = 12;
const POINTS_MAX_IMAGE_PAYLOAD_CHARS = 20 * 1024 * 1024;

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

const getDynamicChunkSize = (fileSizeBytes: number, pageCount: number): number => {
  const bytesPerPage = fileSizeBytes / Math.max(1, pageCount);
  if (bytesPerPage > 550 * 1024) return 6;
  if (bytesPerPage > 320 * 1024) return 8;
  return POINTS_CHUNK_SIZE;
};

interface UsePointsFeatureParams {
  provider: ProviderType;
  selectedModel: ModelType;
}

export interface PointsFeatureController {
  pointsBatchFiles: PointsBatchFile[];
  isAnalyzingPointsBatch: boolean;
  pointsBatchProgress: BatchProgressState | null;
  pointsCopyAllStatus: 'idle' | 'copied' | 'error';
  pointsCopyAllErrorMessage: string;
  pointsFileInputRef: React.RefObject<HTMLInputElement>;
  completedPointsResults: PointsAndFiguresResult[];
  pointsReadyCount: number;
  isPointsLoading: boolean;
  handlePointsFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleAnalyzePointsBatch: () => Promise<void>;
  handleCopyAllPoints: () => Promise<void>;
  removePointsBatchFile: (id: string) => void;
  retryPointsBatchFile: (id: string) => void;
  clearPoints: () => void;
  sessionSlice: PointsSessionSlice;
  restoreFromSessionSlice: (slice: PointsSessionSlice) => void;
}

export const usePointsFeature = ({ provider, selectedModel }: UsePointsFeatureParams): PointsFeatureController => {
  const [pointsBatchFiles, setPointsBatchFiles] = useState<PointsBatchFile[]>([]);
  const [isAnalyzingPointsBatch, setIsAnalyzingPointsBatch] = useState(false);
  const [pointsBatchProgress, setPointsBatchProgress] = useState<BatchProgressState | null>(null);
  const [pointsCopyAllStatus, setPointsCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [pointsCopyAllErrorMessage, setPointsCopyAllErrorMessage] = useState('');

  const pointsFileInputRef = useRef<HTMLInputElement>(null);

  const completedPointsResults = useMemo(
    () => pointsBatchFiles.filter((file) => file.result).map((file) => file.result!) as PointsAndFiguresResult[],
    [pointsBatchFiles],
  );

  const handlePointsFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
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
  }, []);

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
        const fileBlob = nextFiles[fileIndex].file;
        if (!(fileBlob instanceof File)) {
          throw new Error('Original PDF is unavailable in this session. Re-upload the file to analyze.');
        }

        const pageCount = await getPdfPageCount(fileBlob);
        const initialChunkSize = getDynamicChunkSize(fileBlob.size, pageCount);
        const ranges: Array<{ startPage: number; endPage: number }> = [];
        for (let startPage = 1; startPage <= pageCount; startPage += initialChunkSize) {
          ranges.push({
            startPage,
            endPage: Math.min(pageCount, startPage + initialChunkSize - 1),
          });
        }

        const chunkResults: PointsAndFiguresResult[] = [];
        const failedChunks: string[] = [];
        let locationBlockedChunkDetail: string | null = null;

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
              const pageImages = await convertPdfToImages(fileBlob, onChunkProgress, {
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
                provider,
                selectedModel,
                { startPage: range.startPage, endPage: range.endPage },
              );
              chunkResults.push(chunkResult);
              chunkSucceeded = true;
              break;
            } catch (error: unknown) {
              const errorMessage = String((error as { message?: string })?.message || 'Unknown chunk failure');
              if (isLocationUnsupportedChunkError(errorMessage)) {
                locationBlockedChunkDetail = `${chunkLabel} pages ${range.startPage}-${range.endPage}`;
                break;
              }

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

          if (locationBlockedChunkDetail) {
            break;
          }

          if (!chunkSucceeded) {
            continue;
          }
        }

        if (locationBlockedChunkDetail) {
          throw new Error(
            `Gemini is temporarily blocked by provider location policy for this environment. Stop now and retry later. Configure VERTEX_API_KEY in Cloudflare Pages for stronger failover. (${locationBlockedChunkDetail})`,
          );
        }

        if (chunkResults.length === 0) {
          const details = failedChunks[0] || 'No analyzable chunks were produced for this presentation.';
          throw new Error(details);
        }

        const updateFinalizingProgress = (message: string, filePercent: number) => {
          const boundedPercent = Math.max(90, Math.min(99, filePercent));
          nextFiles[fileIndex] = {
            ...nextFiles[fileIndex],
            status: 'analyzing',
            progress: {
              stage: 'finalizing',
              message,
              percent: boundedPercent,
            },
          };
          setPointsBatchFiles([...nextFiles]);

          const { completed, failed } = getCounts();
          const overallPercent = Math.round(((queueIndex + boundedPercent / 100) / pendingIndexes.length) * 100);
          setPointsBatchProgress({
            total: pendingIndexes.length,
            completed,
            failed,
            currentLabel: nextFiles[fileIndex].name,
            progress: {
              stage: 'finalizing',
              message,
              percent: overallPercent,
            },
          });
        };

        const mergedResult = mergePointsChunkResults(chunkResults);
        if (mergedResult.slides.length === 0) {
          throw new Error('No valid insight slides were selected across chunks.');
        }

        let result = mergedResult;
        const qualityWarnings: string[] = [];
        updateFinalizingProgress('Finalizing: verifying slide-context fit and filtering low-signal slides...', 91);
        const selectedPages = Array.from(
          new Set(
            mergedResult.slides
              .map((slide) => slide.selectedPageNumber)
              .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0),
          ),
        ).sort((a, b) => a - b);

        if (selectedPages.length > 0) {
          updateFinalizingProgress('Finalizing: rendering selected slides in high quality...', 93);
          try {
            const highQualityRender = await renderPdfPagesHighQuality(fileBlob, selectedPages, {
              scale: 2.0,
              pngDataUrlMaxChars: 4_800_000,
              jpegFallbackQuality: 0.92,
              onProgress: ({ current, total, pageNumber }) => {
                const ratio = total > 0 ? current / total : 1;
                const finalizingPercent = Math.round(93 + ratio * 6);
                updateFinalizingProgress(
                  `Finalizing: rendering high-quality slide ${current}/${total} (page ${pageNumber})...`,
                  finalizingPercent,
                );
              },
            });

            if (Object.keys(highQualityRender.imagesByPage).length > 0) {
              result = {
                ...mergedResult,
                slides: mergedResult.slides.map((slide) => ({
                  ...slide,
                  pageAsImage: highQualityRender.imagesByPage[slide.selectedPageNumber] || slide.pageAsImage,
                })),
              };
            }

            if (highQualityRender.failedPages.length > 0) {
              qualityWarnings.push(
                `High-quality render failed for ${highQualityRender.failedPages.length} selected slide(s); using chunk-quality fallback for those pages.`,
              );
            }

            if (highQualityRender.downgradedPages.length > 0) {
              qualityWarnings.push(
                `PNG output was oversized for ${highQualityRender.downgradedPages.length} selected slide(s); used high-quality JPEG fallback for those pages.`,
              );
            }
          } catch (error: unknown) {
            qualityWarnings.push(
              `High-quality final render step failed (${String((error as { message?: string })?.message || 'unknown error')}); using analysis-quality slide images.`,
            );
          }
        }

        const partialWarning =
          failedChunks.length > 0 ? `Partial analysis: ${failedChunks.length} chunk(s) failed. ${failedChunks[0]}` : undefined;
        const qualityWarning = qualityWarnings.length > 0 ? qualityWarnings.join(' ') : undefined;
        const combinedWarning = [partialWarning, qualityWarning].filter(Boolean).join(' ').trim() || undefined;
        const completionMessage =
          result.slides.length < 3
            ? `Analysis complete with ${result.slides.length} high-signal slide${result.slides.length === 1 ? '' : 's'}.`
            : combinedWarning
              ? 'Analysis complete with recoverable warnings.'
              : 'Analysis complete.';

        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'complete',
          result,
          error: combinedWarning,
          progress: {
            stage: 'complete',
            message: completionMessage,
            percent: 100,
          },
        };
      } catch (error: unknown) {
        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'error',
          error: (error as { message?: string })?.message || 'Failed to analyze presentation.',
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
  }, [pointsBatchFiles, provider, selectedModel]);

  const handleCopyAllPoints = useCallback(async () => {
    if (completedPointsResults.length === 0) return;

    const { html, text } = buildPointsClipboardExport(completedPointsResults);
    const clipboard = navigator?.clipboard;

    if (!clipboard) {
      setPointsCopyAllStatus('error');
      setPointsCopyAllErrorMessage('Clipboard API is not available in this browser.');
      setTimeout(() => setPointsCopyAllStatus('idle'), 3500);
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

      setPointsCopyAllStatus('copied');
      setPointsCopyAllErrorMessage('');
      setTimeout(() => setPointsCopyAllStatus('idle'), 1800);
    } catch {
      try {
        await clipboard.writeText(text);
        setPointsCopyAllStatus('copied');
        setPointsCopyAllErrorMessage('');
        setTimeout(() => setPointsCopyAllStatus('idle'), 1800);
      } catch (fallbackError: unknown) {
        setPointsCopyAllStatus('error');
        setPointsCopyAllErrorMessage(
          (fallbackError as { message?: string })?.message || 'Copy failed. Please allow clipboard access.',
        );
        setTimeout(() => setPointsCopyAllStatus('idle'), 3500);
      }
    }
  }, [completedPointsResults]);

  const removePointsBatchFile = useCallback((id: string) => {
    setPointsBatchFiles((prev) => prev.filter((file) => file.id !== id));
  }, []);

  const retryPointsBatchFile = useCallback(
    (id: string) => {
      if (isAnalyzingPointsBatch) return;
      setPointsBatchFiles((prev) =>
        prev.map((file) => {
          if (file.id !== id) return file;
          if (!(file.file instanceof File)) {
            return {
              ...file,
              status: 'error',
              error: 'Original PDF is unavailable in this session. Re-upload the file to analyze.',
              result: undefined,
              progress: undefined,
            };
          }
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
    [isAnalyzingPointsBatch],
  );

  const clearPoints = useCallback(() => {
    setPointsBatchFiles([]);
    setIsAnalyzingPointsBatch(false);
    setPointsBatchProgress(null);
    setPointsCopyAllStatus('idle');
    setPointsCopyAllErrorMessage('');
    if (pointsFileInputRef.current) pointsFileInputRef.current.value = '';
  }, []);

  const restoreFromSessionSlice = useCallback((slice: PointsSessionSlice) => {
    setPointsBatchFiles(slice.batchFiles);
    setIsAnalyzingPointsBatch(false);
    setPointsBatchProgress(null);
    setPointsCopyAllStatus('idle');
    setPointsCopyAllErrorMessage('');
  }, []);

  const sessionSlice = useMemo<PointsSessionSlice>(
    () => ({
      batchFiles: pointsBatchFiles,
    }),
    [pointsBatchFiles],
  );

  const pointsReadyCount = pointsBatchFiles.filter((file) => file.status === 'ready').length;
  const isPointsLoading = isAnalyzingPointsBatch;

  return {
    pointsBatchFiles,
    isAnalyzingPointsBatch,
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
    sessionSlice,
    restoreFromSessionSlice,
  };
};

