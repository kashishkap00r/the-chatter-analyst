import type {
  BatchFile,
  ChatterAnalysisState,
  PlotlineBatchFile,
  PlotlineSummaryResult,
  PointsAndFiguresResult,
  PointsBatchFile,
  SelectedSlide,
} from '../../../types';
import type { PersistedAppSessionV2 } from './sessionTypes';

const MAX_CHATTER_CONTENT_CHARS = 700_000;
const MAX_PLOTLINE_CONTENT_CHARS = 800_000;
const POINTS_REUPLOAD_REQUIRED_MESSAGE = 'Original PDF cannot be restored automatically. Re-upload to analyze.';

const clampText = (value: string, maxChars: number): string => {
  if (!value) return '';
  return value.length <= maxChars ? value : value.slice(0, maxChars);
};

const sanitizeChatterSingleState = (state: ChatterAnalysisState): ChatterAnalysisState => {
  if (state.status === 'complete' && state.result) {
    return {
      status: 'complete',
      result: state.result,
      progress: undefined,
    };
  }

  if (state.status === 'error') {
    return {
      status: 'error',
      errorMessage: state.errorMessage,
      progress: undefined,
    };
  }

  return { status: 'idle' };
};

const sanitizeChatterBatchFile = (file: BatchFile): BatchFile => {
  const canResumeFromContent = file.status === 'ready' || file.status === 'parsing' || file.status === 'analyzing';
  const content = canResumeFromContent ? clampText(file.content || '', MAX_CHATTER_CONTENT_CHARS) : '';

  if (file.status === 'complete' && file.result) {
    return {
      id: file.id,
      name: file.name,
      content: '',
      status: 'complete',
      result: file.result,
      error: file.error,
      progress: undefined,
    };
  }

  return {
    id: file.id,
    name: file.name,
    content,
    status: file.status,
    error: file.error,
    result: undefined,
    progress: undefined,
  };
};

const sanitizePointsSlideForPersistence = (slide: SelectedSlide): SelectedSlide => ({
  selectedPageNumber: slide.selectedPageNumber,
  context: slide.context,
  pageAsImage: undefined,
});

const sanitizePointsResultForPersistence = (result: PointsAndFiguresResult): PointsAndFiguresResult => ({
  ...result,
  slides: Array.isArray(result.slides)
    ? result.slides.map((slide) => sanitizePointsSlideForPersistence(slide))
    : [],
});

const sanitizePointsBatchFile = (file: PointsBatchFile): PointsBatchFile => {
  const hasFile = file.file instanceof File;
  const hasResult = Boolean(file.result);

  if (hasResult) {
    return {
      id: file.id,
      name: file.name,
      status: 'complete',
      result: sanitizePointsResultForPersistence(file.result as PointsAndFiguresResult),
      error: file.error,
      progress: undefined,
    };
  }

  const shouldBeAnalyzable = file.status === 'ready' || file.status === 'parsing' || file.status === 'analyzing';
  if (shouldBeAnalyzable && !hasFile) {
    return {
      id: file.id,
      name: file.name,
      status: 'error',
      error: POINTS_REUPLOAD_REQUIRED_MESSAGE,
      progress: undefined,
    };
  }

  return {
    id: file.id,
    name: file.name,
    file: hasFile ? file.file : undefined,
    status: file.status,
    error: file.error,
    result: undefined,
    progress: undefined,
  };
};

const sanitizePlotlineBatchFile = (file: PlotlineBatchFile): PlotlineBatchFile => {
  const canResumeFromContent = file.status === 'ready' || file.status === 'parsing' || file.status === 'analyzing';
  const content = canResumeFromContent ? clampText(file.content || '', MAX_PLOTLINE_CONTENT_CHARS) : '';

  return {
    id: file.id,
    name: file.name,
    content,
    status: file.status,
    result: file.result,
    error: file.error,
    progress: undefined,
  };
};

const sanitizePlotlineSummary = (summary: PlotlineSummaryResult | null): PlotlineSummaryResult | null => {
  if (!summary) return null;
  return summary;
};

export const buildPersistableSession = (snapshot: PersistedAppSessionV2): PersistedAppSessionV2 => ({
  ...snapshot,
  chatter: {
    ...snapshot.chatter,
    batchFiles: snapshot.chatter.batchFiles.map((file) => sanitizeChatterBatchFile(file)),
    chatterSingleState: sanitizeChatterSingleState(snapshot.chatter.chatterSingleState),
  },
  points: {
    ...snapshot.points,
    batchFiles: snapshot.points.batchFiles.map((file) => sanitizePointsBatchFile(file)),
  },
  plotline: {
    ...snapshot.plotline,
    batchFiles: snapshot.plotline.batchFiles.map((file) => sanitizePlotlineBatchFile(file)),
    summary: sanitizePlotlineSummary(snapshot.plotline.summary),
  },
});
