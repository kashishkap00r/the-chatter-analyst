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

// --- Multi-quarter types (schema_version 2) ---

export interface QuarterState {
  name: string;
  results_window: [string, string];
  coverage_deadline: string;
  is_primary: boolean;
  summary: TrackerSummary;
  companies: TrackedCompany[];
  unmatched: string[];
}

export interface MultiQuarterState {
  schema_version: number;
  last_updated: string;
  quarters: QuarterState[];
}

// --- Legacy single-quarter type (schema_version 1 / no version) ---

export interface TrackerStateLegacy {
  active_quarter: string;
  results_window: [string, string];
  last_updated: string;
  summary: TrackerSummary;
  companies: TrackedCompany[];
  unmatched: string[];
}

export type TrackerStateResponse = MultiQuarterState | TrackerStateLegacy;
