import { useState, useEffect, useMemo } from "react";
import type {
  MultiQuarterState,
  QuarterState,
  TrackerStateLegacy,
  TrackerStateResponse,
} from "./types";

function isMultiQuarter(data: TrackerStateResponse): data is MultiQuarterState {
  return "schema_version" in data && (data as MultiQuarterState).schema_version >= 2;
}

function migrateLegacy(legacy: TrackerStateLegacy): MultiQuarterState {
  return {
    schema_version: 2,
    last_updated: legacy.last_updated,
    quarters: [
      {
        name: legacy.active_quarter,
        results_window: legacy.results_window,
        coverage_deadline: "",
        is_primary: true,
        summary: legacy.summary,
        companies: legacy.companies,
        unmatched: legacy.unmatched,
      },
    ],
  };
}

export function useTrackerData() {
  const [state, setState] = useState<MultiQuarterState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedQuarter, setSelectedQuarter] = useState<string | null>(null);

  useEffect(() => {
    const fetchState = async () => {
      try {
        const resp = await fetch("/api/tracker/state");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw: TrackerStateResponse = await resp.json();
        const normalized = isMultiQuarter(raw) ? raw : migrateLegacy(raw);
        setState(normalized);
        // Default to primary quarter
        const primary = normalized.quarters.find((q) => q.is_primary);
        setSelectedQuarter(primary?.name ?? normalized.quarters[0]?.name ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load tracker");
      } finally {
        setLoading(false);
      }
    };
    fetchState();
  }, []);

  const activeQuarter: QuarterState | null = useMemo(() => {
    if (!state || !selectedQuarter) return null;
    return state.quarters.find((q) => q.name === selectedQuarter) ?? null;
  }, [state, selectedQuarter]);

  return {
    state,
    activeQuarter,
    selectedQuarter,
    setSelectedQuarter,
    quarters: state?.quarters ?? [],
    loading,
    error,
  };
}
