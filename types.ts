export type AppMode = 'chatter' | 'points' | 'plotline';
export type AnalysisStage = 'idle' | 'preparing' | 'uploading' | 'analyzing' | 'finalizing' | 'complete' | 'error';

export interface ProgressEvent {
  stage: AnalysisStage;
  message: string;
  current?: number;
  total?: number;
  percent?: number;
}

// --- "The Chatter" Types ---

export interface ExtractedQuote {
  quote: string;
  summary: string;
  speaker: {
    name: string;
    designation: string;
  };
  category: 
    | 'Financial Guidance' 
    | 'Capital Allocation' 
    | 'Cost & Supply Chain' 
    | 'Tech & Disruption' 
    | 'Regulation & Policy' 
    | 'Macro & Geopolitics' 
    | 'ESG & Climate' 
    | 'Legal & Governance' 
    | 'Competitive Landscape' 
    | 'Other Material';
}

export interface ChatterAnalysisResult {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  zerodhaStockUrl?: string;
  concallUrl?: string;
  quotes: ExtractedQuote[];
}

export interface ThreadQuoteCandidate {
  id: string;
  companyName: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  summary: string;
  quote: string;
  speakerName: string;
  speakerDesignation: string;
  sourceOrder: number;
}

export interface ThreadCompanyGroup {
  companyName: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  quotes: ThreadQuoteCandidate[];
}

export interface ThreadEditionSource {
  editionTitle: string;
  editionUrl?: string;
  editionDate?: string;
  companiesCovered?: number;
  industriesCovered?: number;
  sourceKind: 'substack_url' | 'pdf_text';
  companies: ThreadCompanyGroup[];
}

export interface ThreadInsightTweet {
  quoteId: string;
  tweet: string;
}

export interface ThreadDraftResult {
  introTweet: string;
  insightTweets: ThreadInsightTweet[];
  outroTweet: string;
}

export interface ThreadShortlistResult {
  shortlistedQuoteIds: string[];
}

export interface ChatterAnalysisState {
  status: 'idle' | 'analyzing' | 'complete' | 'error';
  result?: ChatterAnalysisResult;
  errorMessage?: string;
  progress?: ProgressEvent;
}

export interface BatchFile {
  id: string;
  name: string;
  content: string;
  status: 'pending' | 'parsing' | 'ready' | 'analyzing' | 'complete' | 'error';
  result?: ChatterAnalysisResult;
  error?: string;
  progress?: ProgressEvent;
}


// --- "Points & Figures" Types ---

export interface SelectedSlide {
  selectedPageNumber: number;
  context: string;
  pageAsImage?: string; // Base64 encoded image
}

export interface PointsAndFiguresResult {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  zerodhaStockUrl?: string;
  slides: SelectedSlide[];
}

export interface PointsBatchFile {
  id: string;
  name: string;
  file?: File;
  status: 'pending' | 'parsing' | 'ready' | 'analyzing' | 'complete' | 'error';
  result?: PointsAndFiguresResult;
  error?: string;
  progress?: ProgressEvent;
}

export interface PointsAnalysisState {
    status: 'idle' | 'parsing' | 'analyzing' | 'complete' | 'error';
    result?: PointsAndFiguresResult;
    errorMessage?: string;
    progressMessage?: string;
    progress?: ProgressEvent;
}

// --- "Plotline" Types ---

export interface PlotlineQuoteMatch {
  quoteId?: string;
  quote: string;
  speakerName: string;
  speakerDesignation: string;
  matchedKeywords: string[];
  periodLabel: string;
  periodSortKey: number;
}

export interface PlotlineFileResult {
  companyName: string;
  fiscalPeriod: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  quotes: PlotlineQuoteMatch[];
}

export interface PlotlineBatchFile {
  id: string;
  name: string;
  content: string;
  status: 'pending' | 'parsing' | 'ready' | 'analyzing' | 'complete' | 'error';
  result?: PlotlineFileResult;
  error?: string;
  progress?: ProgressEvent;
}

export interface PlotlineCompanyResult {
  companyKey: string;
  companyName: string;
  fiscalPeriod?: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  quotes: PlotlineQuoteMatch[];
}

export interface PlotlineStoryPlanSection {
  companyKey: string;
  subhead: string;
  narrativeAngle: string;
  chronologyMode: 'timeline' | 'same_period';
  quoteIds: string[];
}

export interface PlotlineStoryPlanResult {
  title: string;
  dek: string;
  sectionPlans: PlotlineStoryPlanSection[];
  skippedCompanyKeys: string[];
}

export interface PlotlineStorySection {
  companyKey: string;
  companyName: string;
  subhead: string;
  narrativeParagraphs: string[];
  quoteBlocks: PlotlineQuoteMatch[];
}

export interface PlotlineSummaryResult {
  keywords: string[];
  title: string;
  dek: string;
  sections: PlotlineStorySection[];
  closingWatchlist: string[];
  skippedCompanies: string[];
}

export interface PlotlineNarrativeRequestCompany {
  companyKey: string;
  companyName: string;
  nseScrip: string;
  marketCapCategory: string;
  industry: string;
  companyDescription: string;
  quotes: PlotlineQuoteMatch[];
}

export interface PlotlineNarrativeResult {
  sections: Array<{
    companyKey: string;
    subhead: string;
    narrativeParagraphs: string[];
    quoteIds: string[];
  }>;
  closingWatchlist: string[];
}


// --- General Types ---

export enum ProviderType {
  GEMINI = 'gemini',
  OPENROUTER = 'openrouter',
}

export enum ModelType {
  PRO = 'gemini-3-pro-preview',
  FLASH_3 = 'gemini-3-flash-preview',
  FLASH = 'gemini-2.5-flash',
  OPENROUTER_MINIMAX = 'minimax/minimax-01',
  OPENROUTER_DEEPSEEK_V32 = 'deepseek/deepseek-v3.2',
  OPENROUTER_MINIMAX_M21 = 'minimax/minimax-m2.1',
  OPENROUTER_MINIMAX_M25 = 'minimax/minimax-m2.5',
  OPENROUTER_MISTRAL_LARGE_2512 = 'mistralai/mistral-large-2512',
  OPENROUTER_QWEN25_VL_32B = 'qwen/qwen2.5-vl-32b-instruct',
  OPENROUTER_CLAUDE_SONNET_4 = 'anthropic/claude-sonnet-4',
  OPENROUTER_GPT_41_MINI = 'openai/gpt-4.1-mini',
}
