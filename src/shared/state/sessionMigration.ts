import {
  ModelType,
  ProviderType,
  type BatchFile,
  type ChatterAnalysisState,
  type PlotlineBatchFile,
  type PlotlineQuoteMatch,
  type PlotlineSummaryResult,
  type PointsBatchFile,
} from '../../../types';
import {
  OPENROUTER_CHATTER_DEFAULT_MODEL,
  OPENROUTER_CHATTER_MODEL_VALUES,
  OPENROUTER_PLOTLINE_DEFAULT_MODEL,
  OPENROUTER_PLOTLINE_MODEL_VALUES,
  OPENROUTER_POINTS_DEFAULT_MODEL,
  OPENROUTER_POINTS_MODEL_VALUES,
} from '../config/modelOptions';
import type { ChatterSessionSlice, PersistedAppSessionV2, PlotlineSessionSlice, PointsSessionSlice } from './sessionTypes';

export const CURRENT_SESSION_SCHEMA_VERSION = 2;

interface LegacyPersistedAppSessionV1 {
  schemaVersion?: 1;
  savedAt?: number;
  appMode?: unknown;
  inputMode?: unknown;
  textInput?: unknown;
  provider?: unknown;
  geminiModel?: unknown;
  openRouterModel?: unknown;
  geminiPointsModel?: unknown;
  openRouterPointsModel?: unknown;
  geminiPlotlineModel?: unknown;
  openRouterPlotlineModel?: unknown;
  batchFiles?: unknown;
  chatterSingleState?: unknown;
  pointsBatchFiles?: unknown;
  plotlineBatchFiles?: unknown;
  plotlineKeywords?: unknown;
  plotlineSummary?: unknown;
}

const MODEL_TYPE_VALUES = new Set<string>(Object.values(ModelType) as string[]);
const PROVIDER_TYPE_VALUES = new Set<string>(Object.values(ProviderType) as string[]);
const APP_MODE_VALUES = new Set<string>(['chatter', 'points', 'plotline']);
const MAX_PLOTLINE_KEYWORDS = 20;
const POINTS_REUPLOAD_REQUIRED_MESSAGE = 'Original PDF cannot be restored automatically. Re-upload to analyze.';

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
};

const resolveSavedAt = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

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
  const hasRestorableFile = file.file instanceof File;
  const needsFileForAnalysis = file.status === 'ready' || file.status === 'parsing' || file.status === 'analyzing';

  if (needsFileForAnalysis && !hasRestorableFile) {
    return {
      ...file,
      status: 'error',
      progress: undefined,
      file: undefined,
      error: POINTS_REUPLOAD_REQUIRED_MESSAGE,
      result: undefined,
    };
  }

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

const isValidPlotlineQuote = (value: unknown): value is PlotlineQuoteMatch => {
  const record = asRecord(value);
  if (!record) return false;

  return (
    typeof record.quote === 'string' &&
    typeof record.speakerName === 'string' &&
    typeof record.speakerDesignation === 'string' &&
    Array.isArray(record.matchedKeywords) &&
    typeof record.periodLabel === 'string' &&
    typeof record.periodSortKey === 'number'
  );
};

const isValidPlotlineSummary = (value: unknown): value is PlotlineSummaryResult => {
  const record = asRecord(value);
  if (!record) return false;

  if (!Array.isArray(record.keywords) || !Array.isArray(record.sections) || !Array.isArray(record.closingWatchlist) || !Array.isArray(record.skippedCompanies)) {
    return false;
  }

  if (typeof record.title !== 'string' || typeof record.dek !== 'string') {
    return false;
  }

  return record.sections.every((section) => {
    const sectionRecord = asRecord(section);
    if (!sectionRecord) return false;

    return (
      typeof sectionRecord.companyKey === 'string' &&
      typeof sectionRecord.companyName === 'string' &&
      typeof sectionRecord.subhead === 'string' &&
      Array.isArray(sectionRecord.narrativeParagraphs) &&
      Array.isArray(sectionRecord.quoteBlocks) &&
      sectionRecord.quoteBlocks.every((quote) => isValidPlotlineQuote(quote))
    );
  });
};

const resolveInputMode = (value: unknown): 'text' | 'file' =>
  value === 'text' || value === 'file' ? value : 'file';

const resolveAppMode = (value: unknown): 'chatter' | 'points' | 'plotline' =>
  typeof value === 'string' && APP_MODE_VALUES.has(value) ? (value as 'chatter' | 'points' | 'plotline') : 'chatter';

const resolveProvider = (value: unknown): ProviderType =>
  typeof value === 'string' && PROVIDER_TYPE_VALUES.has(value)
    ? (value as ProviderType)
    : ProviderType.GEMINI;

const resolveModel = (value: unknown, fallback: ModelType): ModelType =>
  typeof value === 'string' && MODEL_TYPE_VALUES.has(value) ? (value as ModelType) : fallback;

const resolveScopedOpenRouterModel = (
  value: unknown,
  fallback: ModelType,
  allowedModels: Set<ModelType>,
): ModelType => {
  if (typeof value !== 'string') return fallback;
  if (!MODEL_TYPE_VALUES.has(value)) return fallback;
  const parsed = value as ModelType;
  return allowedModels.has(parsed) ? parsed : fallback;
};

const toArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const normalizeChatterSingleState = (value: unknown): ChatterAnalysisState => {
  const record = asRecord(value);
  if (!record || typeof record.status !== 'string') {
    return { status: 'idle' };
  }

  if (record.status === 'complete' && record.result) {
    return {
      status: 'complete',
      result: record.result as ChatterAnalysisState['result'],
      progress: undefined,
    };
  }

  if (record.status === 'error' && typeof record.errorMessage === 'string') {
    return {
      status: 'error',
      errorMessage: record.errorMessage,
      progress: undefined,
    };
  }

  return { status: 'idle' };
};

const normalizeChatterSlice = (candidate: Record<string, unknown>): ChatterSessionSlice => {
  const batchFiles = toArray<BatchFile>(candidate.batchFiles).map(normalizeRecoveredChatterFile);

  return {
    inputMode: resolveInputMode(candidate.inputMode),
    textInput: typeof candidate.textInput === 'string' ? candidate.textInput : '',
    batchFiles,
    chatterSingleState: normalizeChatterSingleState(candidate.chatterSingleState),
  };
};

const normalizePointsSlice = (candidate: Record<string, unknown>): PointsSessionSlice => {
  const batchFiles = toArray<PointsBatchFile>(candidate.batchFiles).map(normalizeRecoveredPointsFile);

  return {
    batchFiles,
  };
};

const normalizePlotlineSlice = (candidate: Record<string, unknown>): PlotlineSessionSlice => {
  const batchFiles = toArray<PlotlineBatchFile>(candidate.batchFiles).map(normalizeRecoveredPlotlineFile);

  const restoredKeywords = toArray<unknown>(candidate.keywords)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeKeyword(item))
    .filter((item) => item.length > 0)
    .slice(0, MAX_PLOTLINE_KEYWORDS);

  const summary = isValidPlotlineSummary(candidate.summary) ? candidate.summary : null;

  return {
    batchFiles,
    keywords: Array.from(new Set(restoredKeywords)),
    summary,
  };
};

const normalizeV2Session = (candidate: Record<string, unknown>): PersistedAppSessionV2 => {
  const models = asRecord(candidate.models) || {};
  const chatter = asRecord(candidate.chatter) || {};
  const points = asRecord(candidate.points) || {};
  const plotline = asRecord(candidate.plotline) || {};

  return {
    schemaVersion: 2,
    savedAt: resolveSavedAt(candidate.savedAt),
    appMode: resolveAppMode(candidate.appMode),
    provider: resolveProvider(candidate.provider),
    models: {
      geminiModel: resolveModel(models.geminiModel, ModelType.FLASH_3),
      openRouterModel: resolveScopedOpenRouterModel(
        models.openRouterModel,
        OPENROUTER_CHATTER_DEFAULT_MODEL,
        OPENROUTER_CHATTER_MODEL_VALUES,
      ),
      geminiPointsModel: resolveModel(models.geminiPointsModel, ModelType.FLASH_3),
      openRouterPointsModel: resolveScopedOpenRouterModel(
        models.openRouterPointsModel,
        OPENROUTER_POINTS_DEFAULT_MODEL,
        OPENROUTER_POINTS_MODEL_VALUES,
      ),
      geminiPlotlineModel: resolveModel(models.geminiPlotlineModel, ModelType.FLASH_3),
      openRouterPlotlineModel: resolveScopedOpenRouterModel(
        models.openRouterPlotlineModel,
        OPENROUTER_PLOTLINE_DEFAULT_MODEL,
        OPENROUTER_PLOTLINE_MODEL_VALUES,
      ),
    },
    chatter: normalizeChatterSlice(chatter),
    points: normalizePointsSlice(points),
    plotline: normalizePlotlineSlice(plotline),
  };
};

const normalizeLegacyV1Session = (candidate: LegacyPersistedAppSessionV1): PersistedAppSessionV2 => {
  const migratedV2Candidate: Record<string, unknown> = {
    schemaVersion: 2,
    savedAt: candidate.savedAt,
    appMode: candidate.appMode,
    provider: candidate.provider,
    models: {
      geminiModel: candidate.geminiModel,
      openRouterModel: candidate.openRouterModel,
      geminiPointsModel: candidate.geminiPointsModel,
      openRouterPointsModel: candidate.openRouterPointsModel,
      geminiPlotlineModel: candidate.geminiPlotlineModel,
      openRouterPlotlineModel: candidate.openRouterPlotlineModel,
    },
    chatter: {
      inputMode: candidate.inputMode,
      textInput: candidate.textInput,
      batchFiles: candidate.batchFiles,
      chatterSingleState: candidate.chatterSingleState,
    },
    points: {
      batchFiles: candidate.pointsBatchFiles,
    },
    plotline: {
      batchFiles: candidate.plotlineBatchFiles,
      keywords: candidate.plotlineKeywords,
      summary: candidate.plotlineSummary,
    },
  };

  return normalizeV2Session(migratedV2Candidate);
};

export const migratePersistedSessionSnapshot = (snapshot: unknown): PersistedAppSessionV2 | null => {
  const record = asRecord(snapshot);
  if (!record) return null;

  if (record.schemaVersion === CURRENT_SESSION_SCHEMA_VERSION) {
    return normalizeV2Session(record);
  }

  if (record.schemaVersion === 1 || typeof record.schemaVersion === 'undefined') {
    return normalizeLegacyV1Session(record as LegacyPersistedAppSessionV1);
  }

  return null;
};
