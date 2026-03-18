import { useState, useEffect } from "react";
import type { TrackerState } from "./types";

export function useTrackerData() {
  const [state, setState] = useState<TrackerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchState = async () => {
      try {
        const resp = await fetch("/api/tracker/state");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data: TrackerState = await resp.json();
        setState(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load tracker");
      } finally {
        setLoading(false);
      }
    };
    fetchState();
  }, []);

  return { state, loading, error };
}
