import React from "react";
import { useTrackerData } from "./useTrackerData";
import { ChecklistPanel } from "./ChecklistPanel";
import type { QuarterState } from "./types";

function pendingCount(q: QuarterState): number {
  return (
    q.summary.chatter_eligible -
    q.summary.chatter_covered +
    (q.summary.pnf_eligible - q.summary.pnf_covered)
  );
}

export const TrackerPage: React.FC = () => {
  const {
    activeQuarter,
    selectedQuarter,
    setSelectedQuarter,
    quarters,
    loading,
    error,
    state,
  } = useTrackerData();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-stone">Loading tracker...</p>
      </div>
    );
  }

  if (error || !activeQuarter || !state) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-red-500">Failed to load tracker: {error}</p>
      </div>
    );
  }

  const lastUpdated = new Date(state.last_updated).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const chatterPending =
    activeQuarter.summary.chatter_eligible -
    activeQuarter.summary.chatter_covered;
  const pnfPending =
    activeQuarter.summary.pnf_eligible - activeQuarter.summary.pnf_covered;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 min-h-screen">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink">Coverage Tracker</h1>
        <p className="text-sm text-stone mt-1">
          NIFTY LargeMidcap 250 · Updated {lastUpdated}
        </p>
      </div>

      {/* Quarter tabs */}
      {quarters.length > 1 && (
        <div className="flex gap-2 mb-6">
          {quarters.map((q) => {
            const isActive = q.name === selectedQuarter;
            const pending = pendingCount(q);
            return (
              <button
                key={q.name}
                onClick={() => setSelectedQuarter(q.name)}
                className={`px-4 py-2 rounded-z-md text-sm font-medium transition border ${
                  isActive
                    ? "border-brand bg-brand-soft text-ink"
                    : "border-line bg-white text-stone hover:text-ink hover:border-stone"
                }`}
              >
                {q.name}
                <span
                  className={`ml-2 text-xs ${
                    isActive ? "text-brand" : "text-stone"
                  }`}
                >
                  {pending > 0 ? `${pending} pending` : "caught up"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="rounded-z-md border border-line p-4 border-l-4 border-l-brand">
          <p className="text-sm font-medium text-stone">Chatter Pending</p>
          <p className="text-3xl font-bold text-ink">{chatterPending}</p>
        </div>
        <div className="rounded-z-md border border-line p-4 border-l-4 border-l-accent">
          <p className="text-sm font-medium text-stone">P&F Pending</p>
          <p className="text-3xl font-bold text-ink">{pnfPending}</p>
        </div>
      </div>

      {/* Two panels */}
      <div className="flex gap-8 flex-col md:flex-row">
        <ChecklistPanel
          title="The Chatter"
          type="chatter"
          companies={activeQuarter.companies}
          accentColor="#387ED1"
        />
        <ChecklistPanel
          title="Points & Figures"
          type="pnf"
          companies={activeQuarter.companies}
          accentColor="#FFA412"
        />
      </div>
    </div>
  );
};
