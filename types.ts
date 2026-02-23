export type AppMode = 'chatter' | 'points';
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
  pageAsImage: string; // Base64 encoded image
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
  file: File;
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
}
