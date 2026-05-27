export interface TijoriConcall {
  slug: string;
  name: string;
  sector: string;
  isin: string;
  concall_event_time: string;
  transcript: string;
  status: string;
}

export interface TijoriListResponse {
  pagination: {
    total_results?: number;
    total_pages?: number;
    current_page?: number;
    page_size?: number;
    start_offset?: number;
    returned_count?: number;
    next_offset?: number | null;
  };
  data: TijoriConcall[];
}
