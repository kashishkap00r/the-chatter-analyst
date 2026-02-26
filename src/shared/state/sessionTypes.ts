import type {
  AppMode,
  BatchFile,
  ChatterAnalysisState,
  ModelType,
  PointsBatchFile,
  PlotlineBatchFile,
  PlotlineSummaryResult,
  ProviderType,
  ProgressEvent,
} from '../../../types';

export interface BatchProgressState {
  total: number;
  completed: number;
  failed: number;
  currentLabel?: string;
  progress?: ProgressEvent;
}

export interface SessionModelState {
  geminiModel: ModelType;
  openRouterModel: ModelType;
  geminiPointsModel: ModelType;
  openRouterPointsModel: ModelType;
  geminiPlotlineModel: ModelType;
  openRouterPlotlineModel: ModelType;
}

export interface ChatterSessionSlice {
  inputMode: 'text' | 'file';
  textInput: string;
  batchFiles: BatchFile[];
  chatterSingleState: ChatterAnalysisState;
}

export interface PointsSessionSlice {
  batchFiles: PointsBatchFile[];
}

export interface PlotlineSessionSlice {
  batchFiles: PlotlineBatchFile[];
  keywords: string[];
  summary: PlotlineSummaryResult | null;
}

export interface PersistedAppSessionV2 {
  schemaVersion: 2;
  savedAt: number;
  appMode: AppMode;
  provider: ProviderType;
  models: SessionModelState;
  chatter: ChatterSessionSlice;
  points: PointsSessionSlice;
  plotline: PlotlineSessionSlice;
}
