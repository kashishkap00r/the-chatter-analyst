export interface CompanyChecklist {
  eligible: boolean;
  eligible_since: string | null;
  covered: boolean;
  covered_in_edition: string | null;
  covered_date: string | null;
}

export interface TrackedCompany {
  symbol: string;
  name: string;
  chatter: CompanyChecklist;
  pnf: CompanyChecklist;
}

export interface TrackerSummary {
  total_companies: number;
  chatter_eligible: number;
  chatter_covered: number;
  pnf_eligible: number;
  pnf_covered: number;
}

export interface TrackerState {
  active_quarter: string;
  results_window: [string, string];
  last_updated: string;
  summary: TrackerSummary;
  companies: TrackedCompany[];
  unmatched: string[];
}
