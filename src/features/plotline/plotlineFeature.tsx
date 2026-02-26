import React, { useCallback, useMemo, useRef, useState } from 'react';
import AnalysisProgressPanel from '../../../components/AnalysisProgressPanel';
import {
  analyzePlotlineTranscript,
  parsePdfToText,
  summarizePlotlineTheme,
  writePlotlineStory,
} from '../../../services/geminiService';
import type {
  ModelType,
  PlotlineBatchFile,
  PlotlineFileResult,
  PlotlineNarrativeRequestCompany,
  PlotlineQuoteMatch,
  PlotlineSummaryResult,
  ProviderType,
  ProgressEvent,
} from '../../../types';
import { buildPlotlineClipboardExport } from '../../../utils/plotlineCopyExport';
import type { BatchProgressState, PlotlineSessionSlice } from '../../shared/state/sessionTypes';
import {
  PLOTLINE_MAX_RETRIES,
  PLOTLINE_RETRY_BASE_DELAY_MS,
  getRetryDelayMs,
  isRateLimitError,
  isRetriableChunkError,
  wait,
} from '../../shared/utils/retry';
import { statusLabels, statusStyles } from '../../shared/ui/batchStatus';
import { QuoteSkeleton } from '../../shared/ui/skeletons';

const PLOTLINE_MAX_QUOTES_PER_COMPANY = 12;
const PLOTLINE_MAX_KEYWORDS = 20;

const normalizeKeyword = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s\-./+%]/g, '');

const normalizeCompanyKey = (result: {
  companyName: string;
  nseScrip?: string;
  marketCapCategory?: string;
  industry?: string;
}): string => {
  const normalizedScrip = (result.nseScrip || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
  if (normalizedScrip) return normalizedScrip;
  const normalizedName = (result.companyName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalizedName || 'unknown-company';
};

const hashToBase36 = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const sanitizeQuoteId = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

const ensurePlotlineQuoteId = (quote: PlotlineQuoteMatch, companyKey: string): string => {
  if (typeof quote.quoteId === 'string' && quote.quoteId.trim()) {
    return sanitizeQuoteId(quote.quoteId);
  }

  const digest = hashToBase36(
    `${companyKey}|${quote.periodSortKey}|${quote.speakerName}|${quote.speakerDesignation}|${quote.quote}`,
  );
  return `${companyKey}-${quote.periodSortKey}-${digest}`.slice(0, 120);
};

const dedupePlotlineQuotes = (quotes: PlotlineQuoteMatch[], companyKey: string): PlotlineQuoteMatch[] => {
  const unique = new Map<string, PlotlineQuoteMatch>();
  for (const quote of quotes) {
    const key = `${quote.quote.toLowerCase()}|${quote.speakerName.toLowerCase()}|${quote.periodSortKey}`;
    if (!unique.has(key)) {
      unique.set(key, {
        ...quote,
        quoteId: ensurePlotlineQuoteId(quote, companyKey),
      });
    }
  }
  return Array.from(unique.values());
};

const buildPlotlineCompaniesForNarrative = (
  resultFiles: PlotlineFileResult[],
): PlotlineNarrativeRequestCompany[] => {
  const groupedCompanies = new Map<string, PlotlineNarrativeRequestCompany>();

  for (const fileResult of resultFiles) {
    if (!Array.isArray(fileResult.quotes) || fileResult.quotes.length === 0) continue;

    const companyKey = normalizeCompanyKey(fileResult);
    const existing = groupedCompanies.get(companyKey);
    if (!existing) {
      groupedCompanies.set(companyKey, {
        companyKey,
        companyName: fileResult.companyName,
        nseScrip: fileResult.nseScrip,
        marketCapCategory: fileResult.marketCapCategory,
        industry: fileResult.industry,
        companyDescription: fileResult.companyDescription,
        quotes: [...fileResult.quotes],
      });
      continue;
    }

    existing.quotes.push(...fileResult.quotes);
  }

  return Array.from(groupedCompanies.values())
    .map((company) => ({
      ...company,
      quotes: dedupePlotlineQuotes(company.quotes, company.companyKey)
        .sort((left, right) => {
          if (left.periodSortKey !== right.periodSortKey) {
            return left.periodSortKey - right.periodSortKey;
          }
          return left.quote.localeCompare(right.quote);
        })
        .slice(0, PLOTLINE_MAX_QUOTES_PER_COMPANY),
    }))
    .filter((company) => company.quotes.length > 0)
    .sort((left, right) => left.companyName.localeCompare(right.companyName));
};

const buildInterimPlotlineSummary = (
  keywords: string[],
  companies: PlotlineNarrativeRequestCompany[],
): PlotlineSummaryResult => {
  const themeLabel = keywords.length > 0 ? keywords.join(', ') : 'Theme';
  const sections = companies.map((company) => ({
    companyKey: company.companyKey,
    companyName: company.companyName,
    subhead: `${company.companyName}: evidence snapshot`,
    narrativeParagraphs: [
      `Collecting and sequencing management commentary tied to ${themeLabel}. Full narrative will be generated after all files finish.`,
    ],
    quoteBlocks: company.quotes.slice(0, 3),
  }));

  return {
    keywords: [...keywords],
    title: `Plotline: ${themeLabel}`,
    dek: 'Keyword-linked management evidence is being compiled into a story-first brief.',
    sections,
    closingWatchlist: [],
    skippedCompanies: [],
  };
};

interface UsePlotlineFeatureParams {
  provider: ProviderType;
  selectedModel: ModelType;
}

export interface PlotlineFeatureController {
  plotlineBatchFiles: PlotlineBatchFile[];
  isAnalyzingPlotlineBatch: boolean;
  plotlineBatchProgress: BatchProgressState | null;
  plotlineKeywords: string[];
  plotlineKeywordInput: string;
  plotlineSummary: PlotlineSummaryResult | null;
  plotlineCopyAllStatus: 'idle' | 'copied' | 'error';
  plotlineCopyAllErrorMessage: string;
  plotlineFileInputRef: React.RefObject<HTMLInputElement>;
  plotlineReadyCount: number;
  plotlineCompanyCount: number;
  isPlotlineLoading: boolean;
  setPlotlineKeywordInput: React.Dispatch<React.SetStateAction<string>>;
  handlePlotlineKeywordInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  handlePlotlineKeywordInputBlur: () => void;
  removePlotlineKeyword: (keyword: string) => void;
  handlePlotlineFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleAnalyzePlotlineBatch: () => Promise<void>;
  handleCopyAllPlotline: () => Promise<void>;
  removePlotlineBatchFile: (id: string) => void;
  retryPlotlineBatchFile: (id: string) => void;
  clearPlotline: () => void;
  sessionSlice: PlotlineSessionSlice;
  restoreFromSessionSlice: (slice: PlotlineSessionSlice) => void;
}

export const usePlotlineFeature = ({ provider, selectedModel }: UsePlotlineFeatureParams): PlotlineFeatureController => {
  const [plotlineBatchFiles, setPlotlineBatchFiles] = useState<PlotlineBatchFile[]>([]);
  const [isAnalyzingPlotlineBatch, setIsAnalyzingPlotlineBatch] = useState(false);
  const [plotlineBatchProgress, setPlotlineBatchProgress] = useState<BatchProgressState | null>(null);
  const [plotlineKeywords, setPlotlineKeywords] = useState<string[]>([]);
  const [plotlineKeywordInput, setPlotlineKeywordInput] = useState('');
  const [plotlineSummary, setPlotlineSummary] = useState<PlotlineSummaryResult | null>(null);
  const [plotlineCopyAllStatus, setPlotlineCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [plotlineCopyAllErrorMessage, setPlotlineCopyAllErrorMessage] = useState('');

  const plotlineFileInputRef = useRef<HTMLInputElement>(null);

  const runPlotlineWithRetry = useCallback(
    async (
      transcript: string,
      keywords: string[],
      providerType: ProviderType,
      modelId: ModelType,
      onProgress: (progress: ProgressEvent) => void,
      onRetryNotice: (message: string) => void,
    ): Promise<PlotlineFileResult> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= PLOTLINE_MAX_RETRIES; attempt++) {
        try {
          return await analyzePlotlineTranscript(transcript, keywords, providerType, modelId, onProgress);
        } catch (error: unknown) {
          lastError = error;
          const errorMessage = String((error as { message?: string })?.message || 'Plotline analysis failed.');
          const isRetriable = isRetriableChunkError(errorMessage);
          if (attempt < PLOTLINE_MAX_RETRIES && isRetriable) {
            const retryCount = attempt + 1;
            const retryDelayMs = getRetryDelayMs(errorMessage, retryCount, PLOTLINE_RETRY_BASE_DELAY_MS);
            const retrySeconds = Math.max(1, Math.ceil(retryDelayMs / 1000));
            const retryReason = isRateLimitError(errorMessage) ? 'Rate limit reached' : 'Temporary upstream issue';
            onRetryNotice(`${retryReason}. Retrying in ${retrySeconds}s (${retryCount}/${PLOTLINE_MAX_RETRIES})...`);
            await wait(retryDelayMs);
            continue;
          }
          throw error;
        }
      }

      throw lastError || new Error('Plotline analysis failed.');
    },
    [],
  );

  const upsertPlotlineKeywords = useCallback((rawValue: string) => {
    const parsedKeywords = rawValue
      .split(/[\n,]+/g)
      .map((item) => normalizeKeyword(item))
      .filter((item) => item.length > 0);

    if (parsedKeywords.length === 0) return;

    setPlotlineKeywords((prev) => {
      const next = [...prev];
      const seen = new Set(prev.map((keyword) => keyword.toLowerCase()));
      for (const keyword of parsedKeywords) {
        const normalized = keyword.toLowerCase();
        if (seen.has(normalized)) continue;
        if (next.length >= PLOTLINE_MAX_KEYWORDS) break;
        seen.add(normalized);
        next.push(keyword);
      }
      return next;
    });
  }, []);

  const removePlotlineKeyword = useCallback((keyword: string) => {
    setPlotlineKeywords((prev) => prev.filter((item) => item !== keyword));
  }, []);

  const handlePlotlineKeywordInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        const raw = plotlineKeywordInput.trim();
        if (!raw) return;
        upsertPlotlineKeywords(raw);
        setPlotlineKeywordInput('');
      }
    },
    [plotlineKeywordInput, upsertPlotlineKeywords],
  );

  const handlePlotlineKeywordInputBlur = useCallback(() => {
    const raw = plotlineKeywordInput.trim();
    if (!raw) return;
    upsertPlotlineKeywords(raw);
    setPlotlineKeywordInput('');
  }, [plotlineKeywordInput, upsertPlotlineKeywords]);

  const handlePlotlineFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const timestamp = Date.now();
    const sourceFiles = Array.from(files) as File[];

    const parsedFiles = await Promise.all(
      sourceFiles.map(async (file, index): Promise<PlotlineBatchFile> => {
        const item: PlotlineBatchFile = {
          id: `${file.name}-${timestamp}-${index}`,
          name: file.name,
          content: '',
          status: 'parsing',
        };

        try {
          if (file.name.toLowerCase().endsWith('.pdf')) {
            item.content = await parsePdfToText(file);
          } else if (file.name.toLowerCase().endsWith('.txt')) {
            item.content = await file.text();
          } else {
            item.status = 'error';
            item.error = 'Only PDF and TXT files are supported for Plotline.';
            return item;
          }

          if (!item.content.trim()) {
            item.status = 'error';
            item.error = 'Parsed file is empty.';
            return item;
          }

          item.status = 'ready';
        } catch (error: unknown) {
          item.status = 'error';
          item.error = (error as { message?: string })?.message || 'Unable to parse file.';
        }

        return item;
      }),
    );

    setPlotlineBatchFiles((prev) => [...prev, ...parsedFiles]);
    setPlotlineSummary(null);
    if (plotlineFileInputRef.current) {
      plotlineFileInputRef.current.value = '';
    }
  }, []);

  const handleAnalyzePlotlineBatch = useCallback(async () => {
    const pendingIndexes = plotlineBatchFiles
      .map((file, index) => (file.status === 'ready' ? index : -1))
      .filter((index) => index !== -1);

    if (pendingIndexes.length === 0 || plotlineKeywords.length === 0) return;

    setPlotlineCopyAllStatus('idle');
    setPlotlineCopyAllErrorMessage('');
    setPlotlineSummary(null);
    setIsAnalyzingPlotlineBatch(true);

    const nextFiles = [...plotlineBatchFiles];
    const getCounts = () => ({
      completed: pendingIndexes.filter((index) => nextFiles[index].status === 'complete').length,
      failed: pendingIndexes.filter((index) => nextFiles[index].status === 'error').length,
    });

    setPlotlineBatchProgress({
      total: pendingIndexes.length,
      completed: 0,
      failed: 0,
      progress: {
        stage: 'preparing',
        message: 'Starting Plotline analysis...',
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
          message: 'Preparing transcript for keyword extraction...',
          percent: 8,
        },
      };
      setPlotlineBatchFiles([...nextFiles]);

      try {
        const result = await runPlotlineWithRetry(
          nextFiles[fileIndex].content,
          plotlineKeywords,
          provider,
          selectedModel,
          (progress) => {
            nextFiles[fileIndex] = {
              ...nextFiles[fileIndex],
              status: 'analyzing',
              progress,
            };
            setPlotlineBatchFiles([...nextFiles]);

            const { completed, failed } = getCounts();
            const inFileRatio = (progress.percent ?? 0) / 100;
            const overallPercent = Math.round(((queueIndex + inFileRatio) / pendingIndexes.length) * 92);

            setPlotlineBatchProgress({
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
                percent: 90,
              },
            };
            setPlotlineBatchFiles([...nextFiles]);

            const { completed, failed } = getCounts();
            const overallPercent = Math.round(((queueIndex + 0.9) / pendingIndexes.length) * 92);
            setPlotlineBatchProgress({
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
          error: result.quotes.length === 0 ? 'No keyword matches found in this transcript.' : undefined,
          progress: {
            stage: 'complete',
            message:
              result.quotes.length === 0
                ? 'Completed with no keyword matches in this file.'
                : 'Keyword matches extracted.',
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
            message: 'Plotline analysis failed.',
            percent: 100,
          },
        };
      }

      setPlotlineBatchFiles([...nextFiles]);
      const { completed, failed } = getCounts();
      const completedQueueItems = queueIndex + 1;

      setPlotlineBatchProgress({
        total: pendingIndexes.length,
        completed,
        failed,
        currentLabel:
          completedQueueItems < pendingIndexes.length
            ? nextFiles[pendingIndexes[queueIndex + 1]].name
            : undefined,
        progress: {
          stage: completedQueueItems < pendingIndexes.length ? 'preparing' : 'finalizing',
          message:
            completedQueueItems < pendingIndexes.length
              ? 'Loading next transcript...'
              : 'Preparing Plotline story plan...',
          percent: Math.round((completedQueueItems / pendingIndexes.length) * 92),
        },
      });

      const incrementalResultFiles = nextFiles
        .map((queuedFile) => queuedFile.result)
        .filter((result): result is NonNullable<PlotlineBatchFile['result']> => Boolean(result));
      const incrementalCompaniesForNarrative = buildPlotlineCompaniesForNarrative(incrementalResultFiles);

      if (incrementalCompaniesForNarrative.length > 0) {
        setPlotlineSummary(buildInterimPlotlineSummary(plotlineKeywords, incrementalCompaniesForNarrative));
      }
    }

    const resultFiles = nextFiles
      .map((file) => file.result)
      .filter((result): result is NonNullable<PlotlineBatchFile['result']> => Boolean(result));
    const companiesForNarrative = buildPlotlineCompaniesForNarrative(resultFiles);

    if (companiesForNarrative.length === 0) {
      const keywordLabel = plotlineKeywords.length > 0 ? plotlineKeywords.join(', ') : 'Theme';
      setPlotlineSummary({
        keywords: [...plotlineKeywords],
        title: `Plotline: ${keywordLabel}`,
        dek: 'No keyword-linked management commentary was found across the uploaded transcripts.',
        sections: [],
        closingWatchlist: [],
        skippedCompanies: [],
      });
      setPlotlineBatchProgress({
        total: pendingIndexes.length,
        completed: pendingIndexes.filter((index) => nextFiles[index].status === 'complete').length,
        failed: pendingIndexes.filter((index) => nextFiles[index].status === 'error').length,
        progress: {
          stage: 'complete',
          message: 'Batch complete. No keyword matches found in uploaded files.',
          percent: 100,
        },
      });
      setIsAnalyzingPlotlineBatch(false);
      return;
    }

    try {
      setPlotlineBatchProgress((prev) => ({
        total: prev?.total ?? pendingIndexes.length,
        completed: prev?.completed ?? pendingIndexes.length,
        failed: prev?.failed ?? 0,
        currentLabel: undefined,
        progress: {
          stage: 'finalizing',
          message: 'Planning Plotline story structure...',
          percent: 95,
        },
      }));

      const storyPlan = await summarizePlotlineTheme(
        plotlineKeywords,
        companiesForNarrative,
        provider,
        selectedModel,
      );

      setPlotlineBatchProgress((prev) => ({
        total: prev?.total ?? pendingIndexes.length,
        completed: prev?.completed ?? pendingIndexes.length,
        failed: prev?.failed ?? 0,
        currentLabel: undefined,
        progress: {
          stage: 'finalizing',
          message: 'Writing integrated Plotline story...',
          percent: 98,
        },
      }));

      const story = await writePlotlineStory(
        plotlineKeywords,
        companiesForNarrative,
        storyPlan,
        provider,
        selectedModel,
      );

      setPlotlineSummary(story);
      setPlotlineBatchProgress((prev) => ({
        total: prev?.total ?? pendingIndexes.length,
        completed: prev?.completed ?? pendingIndexes.length,
        failed: prev?.failed ?? 0,
        currentLabel: undefined,
        progress: {
          stage: 'complete',
          message: 'Plotline analysis complete.',
          percent: 100,
        },
      }));
    } catch (error: unknown) {
      setPlotlineSummary(buildInterimPlotlineSummary(plotlineKeywords, companiesForNarrative));
      setPlotlineBatchProgress((prev) => ({
        total: prev?.total ?? pendingIndexes.length,
        completed: prev?.completed ?? pendingIndexes.length,
        failed: prev?.failed ?? 0,
        currentLabel: undefined,
        progress: {
          stage: 'error',
          message: (error as { message?: string })?.message || 'Failed to generate Plotline synthesis.',
          percent: 100,
        },
      }));
    } finally {
      setIsAnalyzingPlotlineBatch(false);
    }
  }, [plotlineBatchFiles, plotlineKeywords, provider, runPlotlineWithRetry, selectedModel]);

  const handleCopyAllPlotline = useCallback(async () => {
    if (!plotlineSummary || plotlineSummary.sections.length === 0) return;

    const { html, text } = buildPlotlineClipboardExport(plotlineSummary);
    const clipboard = navigator?.clipboard;

    if (!clipboard) {
      setPlotlineCopyAllStatus('error');
      setPlotlineCopyAllErrorMessage('Clipboard API is not available in this browser.');
      setTimeout(() => setPlotlineCopyAllStatus('idle'), 3500);
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

      setPlotlineCopyAllStatus('copied');
      setPlotlineCopyAllErrorMessage('');
      setTimeout(() => setPlotlineCopyAllStatus('idle'), 1800);
    } catch {
      try {
        await clipboard.writeText(text);
        setPlotlineCopyAllStatus('copied');
        setPlotlineCopyAllErrorMessage('');
        setTimeout(() => setPlotlineCopyAllStatus('idle'), 1800);
      } catch (fallbackError: unknown) {
        setPlotlineCopyAllStatus('error');
        setPlotlineCopyAllErrorMessage(
          (fallbackError as { message?: string })?.message || 'Copy failed. Please allow clipboard access.',
        );
        setTimeout(() => setPlotlineCopyAllStatus('idle'), 3500);
      }
    }
  }, [plotlineSummary]);

  const removePlotlineBatchFile = useCallback((id: string) => {
    setPlotlineBatchFiles((prev) => prev.filter((file) => file.id !== id));
  }, []);

  const retryPlotlineBatchFile = useCallback(
    (id: string) => {
      if (isAnalyzingPlotlineBatch) return;
      setPlotlineBatchFiles((prev) =>
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
    [isAnalyzingPlotlineBatch],
  );

  const clearPlotline = useCallback(() => {
    setPlotlineBatchFiles([]);
    setIsAnalyzingPlotlineBatch(false);
    setPlotlineBatchProgress(null);
    setPlotlineKeywords([]);
    setPlotlineKeywordInput('');
    setPlotlineSummary(null);
    setPlotlineCopyAllStatus('idle');
    setPlotlineCopyAllErrorMessage('');
    if (plotlineFileInputRef.current) plotlineFileInputRef.current.value = '';
  }, []);

  const restoreFromSessionSlice = useCallback((slice: PlotlineSessionSlice) => {
    setPlotlineBatchFiles(slice.batchFiles);
    setPlotlineKeywords(slice.keywords);
    setPlotlineSummary(slice.summary);
    setPlotlineBatchProgress(null);
    setIsAnalyzingPlotlineBatch(false);
    setPlotlineKeywordInput('');
    setPlotlineCopyAllStatus('idle');
    setPlotlineCopyAllErrorMessage('');
  }, []);

  const sessionSlice = useMemo<PlotlineSessionSlice>(
    () => ({
      batchFiles: plotlineBatchFiles,
      keywords: plotlineKeywords,
      summary: plotlineSummary,
    }),
    [plotlineBatchFiles, plotlineKeywords, plotlineSummary],
  );

  const plotlineReadyCount = plotlineBatchFiles.filter((file) => file.status === 'ready').length;
  const plotlineCompanyCount = plotlineSummary?.sections.length ?? 0;
  const isPlotlineLoading = isAnalyzingPlotlineBatch;

  return {
    plotlineBatchFiles,
    isAnalyzingPlotlineBatch,
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
    sessionSlice,
    restoreFromSessionSlice,
  };
};

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
