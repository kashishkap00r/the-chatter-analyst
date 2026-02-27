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

