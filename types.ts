export type AppMode = 'chatter' | 'points';

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

export interface ChatterAnalysisState {
  status: 'idle' | 'analyzing' | 'complete' | 'error';
  result?: ChatterAnalysisResult;
  errorMessage?: string;
}

export interface BatchFile {
  id: string;
  name: string;
  content: string;
  status: 'pending' | 'parsing' | 'ready' | 'analyzing' | 'complete' | 'error';
  result?: ChatterAnalysisResult;
  error?: string;
}


// --- "Points & Figures" Types ---

export interface SelectedSlide {
  selectedPageNumber: number;
  whyThisSlide: string;
  whatThisSlideReveals: string;
  pageAsImage: string; // Base64 encoded image
}

export interface PointsAndFiguresResult {
  companyName: string;
  fiscalPeriod: string;
  slides: SelectedSlide[];
}

export interface PointsAnalysisState {
    status: 'idle' | 'parsing' | 'analyzing' | 'complete' | 'error';
    result?: PointsAndFiguresResult;
    errorMessage?: string;
    progressMessage?: string;
}


// --- General Types ---

export enum ModelType {
  PRO = 'gemini-3-pro-preview',
  FLASH = 'gemini-2.5-flash',
}
