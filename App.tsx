import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzePresentation,
  analyzePlotlineTranscript,
  analyzeTranscript,
  convertPdfToImages,
  getPdfPageCount,
  parsePdfToText,
  renderPdfPagesHighQuality,
  summarizePlotlineTheme,
} from './services/geminiService';
import {
  ModelType,
  type PlotlineBatchFile,
  type PlotlineCompanyResult,
  type PlotlineFileResult,
  type PlotlineNarrativeRequestCompany,
  type PlotlineSummaryResult,
  type PlotlineQuoteMatch,
  ProviderType,
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
import ThreadComposer from './components/ThreadComposer';
import { buildChatterClipboardExport } from './utils/chatterCopyExport';
import { buildPointsClipboardExport } from './utils/pointsCopyExport';
import { buildPlotlineClipboardExport } from './utils/plotlineCopyExport';
import { buildPlotlineNarrativeFallback } from './utils/plotlineNarrativeFallback';
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from './services/sessionStore';

interface BatchProgressState {
  total: number;
  completed: number;
  failed: number;
  currentLabel?: string;
  progress?: ProgressEvent;
}

interface PersistedAppSessionV1 {
  schemaVersion: 1;
  savedAt: number;
  appMode: AppMode;
  inputMode: 'text' | 'file';
  textInput: string;
  provider: ProviderType;
  geminiModel: ModelType;
  openRouterModel: ModelType;
  geminiPointsModel: ModelType;
  openRouterPointsModel: ModelType;
  geminiPlotlineModel?: ModelType;
  openRouterPlotlineModel?: ModelType;
  batchFiles: BatchFile[];
  chatterSingleState: ChatterAnalysisState;
  batchProgress: BatchProgressState | null;
  pointsBatchFiles: PointsBatchFile[];
  pointsBatchProgress: BatchProgressState | null;
  plotlineBatchFiles?: PlotlineBatchFile[];
  plotlineBatchProgress?: BatchProgressState | null;
  plotlineKeywords?: string[];
  plotlineSummary?: PlotlineSummaryResult | null;
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
  <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6 animate-pulse">
    <div className="h-4 w-28 bg-line rounded mb-4" />
    <div className="h-20 bg-canvas rounded-xl mb-4" />
    <div className="h-5 w-11/12 bg-line rounded mb-2" />
    <div className="h-5 w-10/12 bg-line rounded mb-6" />
    <div className="h-4 w-40 bg-line rounded ml-auto" />
  </div>
);

const SlideSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6 animate-pulse">
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
const PLOTLINE_MAX_RETRIES = 2;
const PLOTLINE_MAX_QUOTES_PER_COMPANY = 12;
const PLOTLINE_MAX_KEYWORDS = 20;
const CHATTER_RETRY_BASE_DELAY_MS = 1800;
const POINTS_RETRY_BASE_DELAY_MS = 1200;
const PLOTLINE_RETRY_BASE_DELAY_MS = 1800;
const MAX_RETRY_DELAY_MS = 90 * 1000;
const POINTS_RETRY_RENDER_PROFILES = [
  { scale: 1.15, jpegQuality: 0.75 },
  { scale: 1.0, jpegQuality: 0.65 },
  { scale: 0.85, jpegQuality: 0.55 },
];

const GEMINI_MODEL_OPTIONS: Array<{ value: ModelType; label: string }> = [
  { value: ModelType.FLASH_3, label: "Gemini 3 Flash (Balanced)" },
  { value: ModelType.FLASH, label: "Gemini 2.5 Flash (Fast)" },
  { value: ModelType.PRO, label: "Gemini 3 Pro (Deep)" },
];

const OPENROUTER_MODEL_OPTIONS: Array<{ value: ModelType; label: string }> = [
  { value: ModelType.OPENROUTER_MINIMAX, label: "MiniMax-01 (OpenRouter)" },
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

const isLocationUnsupportedChunkError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('upstream_location_unsupported') ||
    normalized.includes('user location is not supported for the api use') ||
    normalized.includes('location is not supported for the api use') ||
    normalized.includes('provider location policy')
  );
};

const getDynamicChunkSize = (fileSizeBytes: number, pageCount: number): number => {
  const bytesPerPage = fileSizeBytes / Math.max(1, pageCount);
  if (bytesPerPage > 550 * 1024) return 6;
  if (bytesPerPage > 320 * 1024) return 8;
  return POINTS_CHUNK_SIZE;
};

const MODEL_TYPE_VALUES = new Set<string>(Object.values(ModelType) as string[]);
const PROVIDER_TYPE_VALUES = new Set<string>(Object.values(ProviderType) as string[]);
const APP_MODE_VALUES = new Set<string>(['chatter', 'points', 'plotline']);

const normalizeRecoveredChatterFile = (file: BatchFile): BatchFile => {
  if (file.status === 'parsing' || file.status === 'analyzing') {
    if (file.content.trim()) {
      return {
        ...file,
        status: 'ready',
        progress: undefined,
        error: 'Interrupted in previous session. Ready to resume.',
        result: undefined,
      };
    }
    return {
      ...file,
      status: 'error',
      progress: undefined,
      error: file.error || 'Interrupted in previous session before parsing completed.',
      result: undefined,
    };
  }
  return {
    ...file,
    progress: undefined,
  };
};

const normalizeRecoveredPointsFile = (file: PointsBatchFile): PointsBatchFile => {
  if (file.status === 'parsing' || file.status === 'analyzing') {
    return {
      ...file,
      status: 'ready',
      progress: undefined,
      error: 'Interrupted in previous session. Ready to resume.',
      result: undefined,
    };
  }

  return {
    ...file,
    progress: undefined,
  };
};

const normalizeRecoveredPlotlineFile = (file: PlotlineBatchFile): PlotlineBatchFile => {
  if (file.status === 'parsing' || file.status === 'analyzing') {
    if (file.content.trim()) {
      return {
        ...file,
        status: 'ready',
        progress: undefined,
        error: 'Interrupted in previous session. Ready to resume.',
        result: undefined,
      };
    }
    return {
      ...file,
      status: 'error',
      progress: undefined,
      error: file.error || 'Interrupted in previous session before parsing completed.',
      result: undefined,
    };
  }

  return {
    ...file,
    progress: undefined,
  };
};

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

const dedupePlotlineQuotes = (quotes: PlotlineQuoteMatch[]): PlotlineQuoteMatch[] => {
  const unique = new Map<string, PlotlineQuoteMatch>();
  for (const quote of quotes) {
    const key = `${quote.quote.toLowerCase()}|${quote.speakerName.toLowerCase()}|${quote.periodSortKey}`;
    if (!unique.has(key)) {
      unique.set(key, quote);
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
      quotes: dedupePlotlineQuotes(company.quotes)
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

const formatSavedTimestamp = (timestamp: number): string => {
  if (!Number.isFinite(timestamp)) return 'a previous session';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return 'a previous session';
  }
};

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('chatter');
  const [inputMode, setInputMode] = useState<'text' | 'file'>('file');
  const [chatterPane, setChatterPane] = useState<'analysis' | 'thread'>('analysis');
  const [textInput, setTextInput] = useState('');
  const [provider, setProvider] = useState<ProviderType>(ProviderType.GEMINI);
  const [geminiModel, setGeminiModel] = useState<ModelType>(ModelType.FLASH_3);
  const [openRouterModel, setOpenRouterModel] = useState<ModelType>(ModelType.OPENROUTER_MINIMAX);
  const [geminiPointsModel, setGeminiPointsModel] = useState<ModelType>(ModelType.FLASH_3);
  const [openRouterPointsModel, setOpenRouterPointsModel] = useState<ModelType>(ModelType.OPENROUTER_MINIMAX);
  const [geminiPlotlineModel, setGeminiPlotlineModel] = useState<ModelType>(ModelType.FLASH_3);
  const [openRouterPlotlineModel, setOpenRouterPlotlineModel] = useState<ModelType>(ModelType.OPENROUTER_MINIMAX);

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

  const [plotlineBatchFiles, setPlotlineBatchFiles] = useState<PlotlineBatchFile[]>([]);
  const [isAnalyzingPlotlineBatch, setIsAnalyzingPlotlineBatch] = useState(false);
  const [plotlineBatchProgress, setPlotlineBatchProgress] = useState<BatchProgressState | null>(null);
  const [plotlineKeywords, setPlotlineKeywords] = useState<string[]>([]);
  const [plotlineKeywordInput, setPlotlineKeywordInput] = useState('');
  const [plotlineSummary, setPlotlineSummary] = useState<PlotlineSummaryResult | null>(null);
  const [plotlineCopyAllStatus, setPlotlineCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [plotlineCopyAllErrorMessage, setPlotlineCopyAllErrorMessage] = useState('');

  const [pendingResumeSession, setPendingResumeSession] = useState<PersistedAppSessionV1 | null>(null);
  const [isPersistenceReady, setIsPersistenceReady] = useState(false);
  const [isPersistenceBlocked, setIsPersistenceBlocked] = useState(false);
  const [sessionNotice, setSessionNotice] = useState('');
  const [persistenceNotice, setPersistenceNotice] = useState('');

  const chatterFileInputRef = useRef<HTMLInputElement>(null);
  const pointsFileInputRef = useRef<HTMLInputElement>(null);
  const plotlineFileInputRef = useRef<HTMLInputElement>(null);

  const selectedChatterModel = provider === ProviderType.GEMINI ? geminiModel : openRouterModel;
  const selectedPointsModel = provider === ProviderType.GEMINI ? geminiPointsModel : openRouterPointsModel;
  const selectedPlotlineModel = provider === ProviderType.GEMINI ? geminiPlotlineModel : openRouterPlotlineModel;
  const currentModelOptions = provider === ProviderType.GEMINI ? GEMINI_MODEL_OPTIONS : OPENROUTER_MODEL_OPTIONS;

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

  const applyPersistedSession = useCallback((snapshot: PersistedAppSessionV1) => {
    if (APP_MODE_VALUES.has(snapshot.appMode)) {
      setAppMode(snapshot.appMode);
    }

    if (snapshot.inputMode === 'text' || snapshot.inputMode === 'file') {
      setInputMode(snapshot.inputMode);
    }

    setTextInput(typeof snapshot.textInput === 'string' ? snapshot.textInput : '');

    if (PROVIDER_TYPE_VALUES.has(snapshot.provider)) {
      setProvider(snapshot.provider);
    }

    if (MODEL_TYPE_VALUES.has(snapshot.geminiModel)) {
      setGeminiModel(snapshot.geminiModel);
    }
    if (MODEL_TYPE_VALUES.has(snapshot.openRouterModel)) {
      setOpenRouterModel(snapshot.openRouterModel);
    }
    if (MODEL_TYPE_VALUES.has(snapshot.geminiPointsModel)) {
      setGeminiPointsModel(snapshot.geminiPointsModel);
    }
    if (MODEL_TYPE_VALUES.has(snapshot.openRouterPointsModel)) {
      setOpenRouterPointsModel(snapshot.openRouterPointsModel);
    }
    if (snapshot.geminiPlotlineModel && MODEL_TYPE_VALUES.has(snapshot.geminiPlotlineModel)) {
      setGeminiPlotlineModel(snapshot.geminiPlotlineModel);
    }
    if (snapshot.openRouterPlotlineModel && MODEL_TYPE_VALUES.has(snapshot.openRouterPlotlineModel)) {
      setOpenRouterPlotlineModel(snapshot.openRouterPlotlineModel);
    }

    const restoredBatchFiles = Array.isArray(snapshot.batchFiles)
      ? snapshot.batchFiles.map(normalizeRecoveredChatterFile)
      : [];
    const restoredPointsFiles = Array.isArray(snapshot.pointsBatchFiles)
      ? snapshot.pointsBatchFiles.map(normalizeRecoveredPointsFile)
      : [];
    const restoredPlotlineFiles = Array.isArray(snapshot.plotlineBatchFiles)
      ? snapshot.plotlineBatchFiles.map(normalizeRecoveredPlotlineFile)
      : [];

    setBatchFiles(restoredBatchFiles);
    setPointsBatchFiles(restoredPointsFiles);
    setPlotlineBatchFiles(restoredPlotlineFiles);

    if (snapshot.chatterSingleState?.status === 'complete' && snapshot.chatterSingleState.result) {
      setChatterSingleState(snapshot.chatterSingleState);
    } else if (snapshot.chatterSingleState?.status === 'error' && snapshot.chatterSingleState.errorMessage) {
      setChatterSingleState({
        status: 'error',
        errorMessage: snapshot.chatterSingleState.errorMessage,
        progress: undefined,
      });
    } else {
      setChatterSingleState({ status: 'idle' });
    }

    setBatchProgress(null);
    setPointsBatchProgress(null);
    setPlotlineBatchProgress(null);
    setIsAnalyzingBatch(false);
    setIsAnalyzingPointsBatch(false);
    setIsAnalyzingPlotlineBatch(false);
    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');
    setPointsCopyAllStatus('idle');
    setPointsCopyAllErrorMessage('');
    setPlotlineCopyAllStatus('idle');
    setPlotlineCopyAllErrorMessage('');
    setPlotlineKeywordInput('');

    const restoredKeywords = Array.isArray(snapshot.plotlineKeywords)
      ? snapshot.plotlineKeywords
          .filter((item): item is string => typeof item === 'string')
          .map((item) => normalizeKeyword(item))
          .filter((item) => item.length > 0)
          .slice(0, PLOTLINE_MAX_KEYWORDS)
      : [];
    setPlotlineKeywords(Array.from(new Set(restoredKeywords)));

    const restoredSummary = snapshot.plotlineSummary;
    if (restoredSummary && Array.isArray(restoredSummary.companies) && Array.isArray(restoredSummary.keywords)) {
      setPlotlineSummary(restoredSummary);
    } else {
      setPlotlineSummary(null);
    }
  }, []);

  const handleResumeSavedSession = useCallback(() => {
    if (!pendingResumeSession) return;
    applyPersistedSession(pendingResumeSession);
    setPendingResumeSession(null);
    setIsPersistenceReady(true);
    setIsPersistenceBlocked(false);
    setSessionNotice(`Resumed session from ${formatSavedTimestamp(pendingResumeSession.savedAt)}.`);
  }, [applyPersistedSession, pendingResumeSession]);

  const handleDiscardSavedSession = useCallback(async () => {
    await clearPersistedSession();
    setPendingResumeSession(null);
    setIsPersistenceReady(true);
    setIsPersistenceBlocked(false);
    setSessionNotice('Discarded previous browser session.');
  }, []);

  const handleClearSavedSessionData = useCallback(async () => {
    await clearPersistedSession();
    setPendingResumeSession(null);
    setIsPersistenceBlocked(false);
    setPersistenceNotice('');
    if (!isPersistenceReady) {
      setIsPersistenceReady(true);
    }
    setSessionNotice('Cleared saved browser session data.');
  }, [isPersistenceReady]);

  useEffect(() => {
    let cancelled = false;

    const initializeSession = async () => {
      const snapshot = await loadPersistedSession<PersistedAppSessionV1>();
      if (cancelled) return;

      if (snapshot && snapshot.schemaVersion === 1) {
        setPendingResumeSession(snapshot);
        setSessionNotice('');
        return;
      }

      setIsPersistenceReady(true);
    };

    initializeSession().catch(() => {
      if (!cancelled) {
        setIsPersistenceReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isPersistenceReady || isPersistenceBlocked) return;

    const payload: PersistedAppSessionV1 = {
      schemaVersion: 1,
      savedAt: Date.now(),
      appMode,
      inputMode,
      textInput,
      provider,
      geminiModel,
      openRouterModel,
      geminiPointsModel,
      openRouterPointsModel,
      geminiPlotlineModel,
      openRouterPlotlineModel,
      batchFiles,
      chatterSingleState,
      batchProgress,
      pointsBatchFiles,
      pointsBatchProgress,
      plotlineBatchFiles,
      plotlineBatchProgress,
      plotlineKeywords,
      plotlineSummary,
    };

    const timer = window.setTimeout(async () => {
      const status = await savePersistedSession(payload);
      if (status === 'quota_exceeded') {
        setIsPersistenceBlocked(true);
        setPersistenceNotice('Browser storage is full. Clear saved session data to resume autosave.');
        return;
      }
      if (status === 'unsupported') {
        setPersistenceNotice('Session resume is not supported in this browser.');
        return;
      }
      if (status === 'error') {
        setPersistenceNotice('Unable to save browser session right now.');
        return;
      }

      if (status === 'ok' && !isPersistenceBlocked) {
        setPersistenceNotice('');
      }
    }, 650);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    appMode,
    inputMode,
    textInput,
    provider,
    geminiModel,
    openRouterModel,
    geminiPointsModel,
    openRouterPointsModel,
    geminiPlotlineModel,
    openRouterPlotlineModel,
    batchFiles,
    chatterSingleState,
    batchProgress,
    pointsBatchFiles,
    pointsBatchProgress,
    plotlineBatchFiles,
    plotlineBatchProgress,
    plotlineKeywords,
    plotlineSummary,
    isPersistenceReady,
    isPersistenceBlocked,
  ]);

  const runTranscriptWithRetry = useCallback(
    async (
      transcript: string,
      providerType: ProviderType,
      modelId: ModelType,
      onProgress: (progress: ProgressEvent) => void,
      onRetryNotice: (message: string) => void,
    ): Promise<ChatterAnalysisResult> => {
      let lastError: any = null;
      for (let attempt = 0; attempt <= CHATTER_MAX_RETRIES; attempt++) {
        try {
          return await analyzeTranscript(transcript, providerType, modelId, onProgress);
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

  const runPlotlineWithRetry = useCallback(
    async (
      transcript: string,
      keywords: string[],
      providerType: ProviderType,
      modelId: ModelType,
      onProgress: (progress: ProgressEvent) => void,
      onRetryNotice: (message: string) => void,
    ): Promise<PlotlineFileResult> => {
      let lastError: any = null;
      for (let attempt = 0; attempt <= PLOTLINE_MAX_RETRIES; attempt++) {
        try {
          return await analyzePlotlineTranscript(transcript, keywords, providerType, modelId, onProgress);
        } catch (error: any) {
          lastError = error;
          const errorMessage = String(error?.message || 'Plotline analysis failed.');
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
        selectedChatterModel,
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
  }, [provider, runTranscriptWithRetry, selectedChatterModel, textInput]);

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
          selectedChatterModel,
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
  }, [batchFiles, provider, runTranscriptWithRetry, selectedChatterModel]);

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
                provider,
                selectedPointsModel,
                { startPage: range.startPage, endPage: range.endPage },
              );
              chunkResults.push(chunkResult);
              chunkSucceeded = true;
              break;
            } catch (error: any) {
              const errorMessage = String(error?.message || "Unknown chunk failure");
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
            const highQualityRender = await renderPdfPagesHighQuality(nextFiles[fileIndex].file, selectedPages, {
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
          } catch (error: any) {
            qualityWarnings.push(
              `High-quality final render step failed (${String(error?.message || 'unknown error')}); using analysis-quality slide images.`,
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
  }, [pointsBatchFiles, provider, selectedPointsModel]);

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

  const handleCopyAllPlotline = useCallback(async () => {
    if (!plotlineSummary || plotlineSummary.companies.length === 0) return;

    const { html, text } = buildPlotlineClipboardExport(plotlineSummary);
    const clipboard = navigator?.clipboard;

    if (!clipboard) {
      setPlotlineCopyAllStatus('error');
      setPlotlineCopyAllErrorMessage('Clipboard API is not available in this browser.');
      setTimeout(() => setPlotlineCopyAllStatus('idle'), 3500);
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

      setPlotlineCopyAllStatus('copied');
      setPlotlineCopyAllErrorMessage('');
      setTimeout(() => setPlotlineCopyAllStatus('idle'), 1800);
    } catch {
      try {
        await clipboard.writeText(text);
        setPlotlineCopyAllStatus('copied');
        setPlotlineCopyAllErrorMessage('');
        setTimeout(() => setPlotlineCopyAllStatus('idle'), 1800);
      } catch (fallbackError: any) {
        setPlotlineCopyAllStatus('error');
        setPlotlineCopyAllErrorMessage(fallbackError?.message || 'Copy failed. Please allow clipboard access.');
        setTimeout(() => setPlotlineCopyAllStatus('idle'), 3500);
      }
    }
  }, [plotlineSummary]);

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

  const handlePlotlineFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
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
        } catch (error: any) {
          item.status = 'error';
          item.error = error?.message || 'Unable to parse file.';
        }

        return item;
      }),
    );

    setPlotlineBatchFiles((prev) => [...prev, ...parsedFiles]);
    setPlotlineSummary(null);
    if (plotlineFileInputRef.current) {
      plotlineFileInputRef.current.value = '';
    }
  };

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
          selectedPlotlineModel,
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
      } catch (error: any) {
        nextFiles[fileIndex] = {
          ...nextFiles[fileIndex],
          status: 'error',
          error: error?.message || 'Failed to analyze transcript.',
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
              : 'Building company-level Plotline synthesis...',
          percent: Math.round((completedQueueItems / pendingIndexes.length) * 92),
        },
      });

      const incrementalResultFiles = nextFiles
        .map((queuedFile) => queuedFile.result)
        .filter((result): result is NonNullable<PlotlineBatchFile['result']> => Boolean(result));
      const incrementalCompaniesForNarrative = buildPlotlineCompaniesForNarrative(incrementalResultFiles);

      if (incrementalCompaniesForNarrative.length > 0) {
        setPlotlineSummary((previous) => {
          const previousNarratives = new Map(
            (previous?.companies || []).map((company) => [company.companyKey, company.companyNarrative]),
          );
          const companies = incrementalCompaniesForNarrative.map((company) => ({
            ...company,
            companyNarrative:
              previousNarratives.get(company.companyKey) ||
              buildPlotlineNarrativeFallback(company.companyName, company.quotes, plotlineKeywords),
          }));
          return {
            keywords: [...plotlineKeywords],
            companies,
            masterThemeBullets: [],
          };
        });
      }
    }

    const resultFiles = nextFiles
      .map((file) => file.result)
      .filter((result): result is NonNullable<PlotlineBatchFile['result']> => Boolean(result));
    const companiesForNarrative = buildPlotlineCompaniesForNarrative(resultFiles);

    if (companiesForNarrative.length === 0) {
      setPlotlineSummary({
        keywords: [...plotlineKeywords],
        companies: [],
        masterThemeBullets: [],
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
          message: 'Generating company narratives and master theme bullets...',
          percent: 97,
        },
      }));

      const narrativeResult = await summarizePlotlineTheme(
        plotlineKeywords,
        companiesForNarrative,
        provider,
        selectedPlotlineModel,
      );
      const narrativeMap = new Map(
        narrativeResult.companyNarratives.map((item) => [item.companyKey, item.narrative]),
      );

      const companies: PlotlineCompanyResult[] = companiesForNarrative.map((company) => ({
        ...company,
        companyNarrative:
          narrativeMap.get(company.companyKey) ||
          buildPlotlineNarrativeFallback(company.companyName, company.quotes, plotlineKeywords),
      }));

      setPlotlineSummary({
        keywords: [...plotlineKeywords],
        companies,
        masterThemeBullets: narrativeResult.masterThemeBullets,
      });
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
    } catch (error: any) {
      const companies: PlotlineCompanyResult[] = companiesForNarrative.map((company) => ({
        ...company,
        companyNarrative: buildPlotlineNarrativeFallback(company.companyName, company.quotes, plotlineKeywords),
      }));
      setPlotlineSummary({
        keywords: [...plotlineKeywords],
        companies,
        masterThemeBullets: [],
      });
      setPlotlineBatchProgress((prev) => ({
        total: prev?.total ?? pendingIndexes.length,
        completed: prev?.completed ?? pendingIndexes.length,
        failed: prev?.failed ?? 0,
        currentLabel: undefined,
        progress: {
          stage: 'error',
          message: error?.message || 'Failed to generate Plotline synthesis.',
          percent: 100,
        },
      }));
    } finally {
      setIsAnalyzingPlotlineBatch(false);
    }
  }, [plotlineBatchFiles, plotlineKeywords, provider, runPlotlineWithRetry, selectedPlotlineModel]);

  const removeBatchFile = (id: string) => {
    setBatchFiles((prev) => prev.filter((file) => file.id !== id));
  };

  const removePointsBatchFile = (id: string) => {
    setPointsBatchFiles((prev) => prev.filter((file) => file.id !== id));
  };

  const removePlotlineBatchFile = (id: string) => {
    setPlotlineBatchFiles((prev) => prev.filter((file) => file.id !== id));
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

  const retryPlotlineBatchFile = (id: string) => {
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

  const clearPlotline = () => {
    setPlotlineBatchFiles([]);
    setIsAnalyzingPlotlineBatch(false);
    setPlotlineBatchProgress(null);
    setPlotlineKeywords([]);
    setPlotlineKeywordInput('');
    setPlotlineSummary(null);
    setPlotlineCopyAllStatus('idle');
    setPlotlineCopyAllErrorMessage('');
    if (plotlineFileInputRef.current) plotlineFileInputRef.current.value = '';
  };

  const completedResults = getCompletedChatterResults();
  const readyCount = batchFiles.filter((file) => file.status === 'ready').length;
  const completedPointsResults = getCompletedPointsResults();
  const pointsReadyCount = pointsBatchFiles.filter((file) => file.status === 'ready').length;
  const plotlineReadyCount = plotlineBatchFiles.filter((file) => file.status === 'ready').length;
  const plotlineCompanyCount = plotlineSummary?.companies.length ?? 0;
  const isTextLoading = chatterSingleState.status === 'analyzing';
  const isChatterLoading = isTextLoading || isAnalyzingBatch;
  const isPointsLoading = isAnalyzingPointsBatch;
  const isPlotlineLoading = isAnalyzingPlotlineBatch;
  const isResumePromptVisible = Boolean(pendingResumeSession);
  const isResumeDecisionPending = isResumePromptVisible && !isPersistenceReady;

  const renderChatterWorkbench = () => (
    <section className="lg:col-span-5 lg:sticky lg:top-24 self-start">
      <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6">
        <header className="mb-5">
          <p className="text-xs uppercase tracking-[0.16em] text-stone font-semibold">Input Desk</p>
          <h2 className="font-serif text-2xl mt-1">Transcript Input</h2>
        </header>

        <div className="inline-flex rounded-xl border border-line bg-canvas p-1 mb-4 w-full">
          <button
            onClick={() => setInputMode('file')}
            disabled={isResumeDecisionPending}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
              inputMode === 'file' ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink'
            } disabled:opacity-50`}
          >
            Files (Batch)
          </button>
          <button
            onClick={() => setInputMode('text')}
            disabled={isResumeDecisionPending}
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
            disabled={isResumeDecisionPending}
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
                disabled={isResumeDecisionPending}
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
                        disabled={isResumeDecisionPending}
                        className="text-xs font-semibold text-brand hover:text-ink"
                        title="Retry file"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      onClick={() => removeBatchFile(file.id)}
                      disabled={isResumeDecisionPending || isAnalyzingBatch}
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
            disabled={isChatterLoading || isResumeDecisionPending}
            className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
          >
            Clear
          </button>
          {inputMode === 'text' ? (
            <button
              onClick={handleAnalyzeText}
              disabled={!textInput.trim() || isTextLoading || isResumeDecisionPending}
              className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
            >
              {isTextLoading ? 'Analyzing...' : 'Extract Insights'}
            </button>
          ) : (
            <button
              onClick={handleAnalyzeBatch}
              disabled={readyCount === 0 || isAnalyzingBatch || isResumeDecisionPending}
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
        <ThreadComposer provider={provider} model={selectedChatterModel} disabled={isResumeDecisionPending} />
      ) : (
        <>
          {completedResults.length > 0 && (
            <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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
  );

  const renderPointsWorkbench = () => (
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
            disabled={isResumeDecisionPending}
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
                    disabled={isResumeDecisionPending}
                    className="text-xs font-semibold text-brand hover:text-ink"
                    title="Retry file"
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={() => removePointsBatchFile(file.id)}
                  disabled={isResumeDecisionPending || isAnalyzingPointsBatch}
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
            disabled={isPointsLoading || isResumeDecisionPending}
            className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
          >
            Clear
          </button>
          <button
            onClick={handleAnalyzePointsBatch}
            disabled={pointsReadyCount === 0 || isPointsLoading || isResumeDecisionPending}
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
        <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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
  );

  const renderPlotlineWorkbench = () => (
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
            disabled={isResumeDecisionPending}
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
                  disabled={isResumeDecisionPending || isPlotlineLoading}
                  className="text-brand/75 hover:text-ink"
                  aria-label={`Remove ${keyword}`}
                  title="Remove keyword"
                >
                  X
                </button>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-stone">
            {plotlineKeywords.length}/{PLOTLINE_MAX_KEYWORDS} keywords
          </p>
        </div>

        <div className="relative rounded-xl border-2 border-dashed border-line bg-canvas/45 px-4 py-7 text-center hover:border-brand/45 transition-colors">
          <p className="text-sm font-medium text-stone">Drop or select transcript files</p>
          <p className="text-xs text-stone/80 mt-1">Supports PDF and TXT</p>
          <input
            ref={plotlineFileInputRef}
            type="file"
            accept=".pdf,.txt"
            multiple
            onChange={handlePlotlineFileUpload}
            disabled={isResumeDecisionPending}
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
                    disabled={isResumeDecisionPending}
                    className="text-xs font-semibold text-brand hover:text-ink"
                    title="Retry file"
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={() => removePlotlineBatchFile(file.id)}
                  disabled={isResumeDecisionPending || isPlotlineLoading}
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
            disabled={isPlotlineLoading || isResumeDecisionPending}
            className="px-4 py-2.5 rounded-xl border border-line text-sm font-semibold text-stone hover:text-ink disabled:opacity-50"
          >
            Clear
          </button>
          <button
            onClick={handleAnalyzePlotlineBatch}
            disabled={plotlineReadyCount === 0 || plotlineKeywords.length === 0 || isPlotlineLoading || isResumeDecisionPending}
            className="flex-1 rounded-xl bg-brand text-white text-sm font-semibold py-2.5 px-4 disabled:opacity-50 hover:bg-brand/90 transition"
          >
            {isPlotlineLoading
              ? 'Processing Batch...'
              : `Analyze ${plotlineReadyCount} File${plotlineReadyCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </section>
  );

  const renderPlotlineResults = () => (
    <section className="lg:col-span-7 space-y-6">
      {plotlineCompanyCount > 0 && (
        <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-stone">
            {plotlineCompanyCount} compan{plotlineCompanyCount === 1 ? 'y' : 'ies'} with keyword matches ready for Plotline export.
          </p>
          <button
            onClick={handleCopyAllPlotline}
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

      {!isPlotlineLoading && plotlineSummary && plotlineSummary.companies.length === 0 && (
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

      {plotlineSummary && plotlineSummary.masterThemeBullets.length > 0 && (
        <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6">
          <h3 className="font-serif text-2xl text-ink">Master Theme Summary</h3>
          <ul className="mt-4 space-y-2 list-disc pl-5 text-sm text-stone leading-relaxed">
            {plotlineSummary.masterThemeBullets.map((bullet, index) => (
              <li key={`plotline-bullet-${index}`}>{bullet}</li>
            ))}
          </ul>
        </div>
      )}

      {plotlineSummary?.companies.map((company) => {
        const narrativeText =
          company.companyNarrative ||
          buildPlotlineNarrativeFallback(company.companyName, company.quotes, plotlineSummary.keywords);

        return (
          <div key={company.companyKey} className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6 space-y-5">
            <header>
              <h2 className="font-serif text-3xl text-ink">{company.companyName}</h2>
              <p className="text-sm text-stone">
                {company.marketCapCategory} | {company.industry}
              </p>
            </header>

            <p className="rounded-xl border border-brand/20 bg-brand-soft/60 px-4 py-3 text-sm leading-relaxed text-ink">
              {narrativeText}
            </p>

            <div className="space-y-4">
              {company.quotes.map((quote, index) => (
                <article key={`${company.companyKey}-${index}`} className="rounded-xl border border-line bg-canvas/45 px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-stone">
                    {quote.periodLabel}
                  </p>
                  <blockquote className="mt-2 text-[15px] leading-relaxed italic text-ink">
                    "{quote.quote}"
                  </blockquote>
                  <p className="mt-2 text-xs text-stone italic">
                    — {quote.speakerName}, {quote.speakerDesignation}
                  </p>
                </article>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );

  return (
    <div className="app-shell min-h-screen text-ink relative overflow-x-hidden">
      <div className="app-atmosphere" />

      <header className="app-header sticky top-0 z-20 border-b border-line">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="brand-mark h-10 w-10 rounded-xl text-white font-serif font-bold text-xl grid place-items-center">C</div>
                <div>
                  <h1 className="font-serif text-2xl leading-none">Chatter Analyst</h1>
                  <p className="text-xs uppercase tracking-[0.15em] text-stone mt-1">Research Workflow Studio</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3">
                <label className="control-label">
                  Provider
                  <select
                    value={provider}
                    onChange={(event) => setProvider(event.target.value as ProviderType)}
                    disabled={isResumeDecisionPending}
                    className="control-select"
                  >
                    <option value={ProviderType.GEMINI}>Gemini</option>
                    <option value={ProviderType.OPENROUTER}>OpenRouter</option>
                  </select>
                </label>

                <label className="control-label">
                  Model
                  <select
                    value={
                      appMode === 'chatter'
                        ? selectedChatterModel
                        : appMode === 'points'
                          ? selectedPointsModel
                          : selectedPlotlineModel
                    }
                    disabled={isResumeDecisionPending}
                    onChange={(event) => {
                      const selectedModel = event.target.value as ModelType;
                      if (provider === ProviderType.GEMINI) {
                        if (appMode === 'chatter') {
                          setGeminiModel(selectedModel);
                        } else if (appMode === 'points') {
                          setGeminiPointsModel(selectedModel);
                        } else {
                          setGeminiPlotlineModel(selectedModel);
                        }
                      } else {
                        if (appMode === 'chatter') {
                          setOpenRouterModel(selectedModel);
                        } else if (appMode === 'points') {
                          setOpenRouterPointsModel(selectedModel);
                        } else {
                          setOpenRouterPlotlineModel(selectedModel);
                        }
                      }
                    }}
                    className="control-select"
                  >
                    {currentModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  onClick={handleClearSavedSessionData}
                  className="ghost-btn px-3 py-1.5 text-sm font-semibold"
                  title="Clear saved browser session"
                >
                  Clear Saved Session
                </button>
              </div>
            </div>

            <div className="mode-tabs inline-flex rounded-xl border border-line p-1 max-w-2xl w-full">
              <button
                onClick={() => {
                  setAppMode('chatter');
                }}
                disabled={isResumeDecisionPending}
                className={`mode-tab-btn flex-1 transition ${
                  appMode === 'chatter' ? 'mode-tab-active' : 'mode-tab-idle'
                } disabled:opacity-50`}
              >
                The Chatter
              </button>
              <button
                onClick={() => {
                  setAppMode('points');
                }}
                disabled={isResumeDecisionPending}
                className={`mode-tab-btn flex-1 transition ${
                  appMode === 'points' ? 'mode-tab-active' : 'mode-tab-idle'
                } disabled:opacity-50`}
                >
                Points & Figures
              </button>
              <button
                onClick={() => {
                  setAppMode('plotline');
                }}
                disabled={isResumeDecisionPending}
                className={`mode-tab-btn flex-1 transition ${
                  appMode === 'plotline' ? 'mode-tab-active' : 'mode-tab-idle'
                } disabled:opacity-50`}
              >
                Plotline
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="app-main relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isResumePromptVisible && pendingResumeSession && (
          <div className="mb-5 rounded-2xl border border-brand/35 bg-brand-soft px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">Previous session found</p>
              <p className="text-sm text-stone mt-1">
                Resume work from {formatSavedTimestamp(pendingResumeSession.savedAt)}.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleResumeSavedSession}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"
              >
                Resume
              </button>
              <button
                onClick={handleDiscardSavedSession}
                className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-semibold text-stone hover:text-ink"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {sessionNotice && (
          <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {sessionNotice}
          </div>
        )}

        {persistenceNotice && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {persistenceNotice}
          </div>
        )}

        <div className="workspace-grid grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {appMode === 'chatter' ? (
            <>
              {renderChatterWorkbench()}
              {renderChatterResults()}
            </>
          ) : appMode === 'points' ? (
            <>
              {renderPointsWorkbench()}
              {renderPointsResults()}
            </>
          ) : (
            <>
              {renderPlotlineWorkbench()}
              {renderPlotlineResults()}
            </>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
