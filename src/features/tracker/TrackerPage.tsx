import React from "react";
import { useTrackerData } from "./useTrackerData";
import { ChecklistPanel } from "./ChecklistPanel";

export const TrackerPage: React.FC = () => {
  const { state, loading, error } = useTrackerData();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <p className="text-gray-500">Loading tracker...</p>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <p className="text-red-500">Failed to load tracker: {error}</p>
      </div>
    );
  }

  const lastUpdated = new Date(state.last_updated).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const chatterPending =
    state.summary.chatter_eligible - state.summary.chatter_covered;
  const pnfPending =
    state.summary.pnf_eligible - state.summary.pnf_covered;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 bg-white min-h-screen">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-800">Coverage Tracker</h1>
        <p className="text-sm text-gray-500 mt-1">
          {state.active_quarter} · NIFTY LargeMidcap 250 · Updated{" "}
          {lastUpdated}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="bg-blue-50 rounded-lg p-4">
          <p className="text-sm font-medium text-blue-700">Chatter Pending</p>
          <p className="text-3xl font-bold text-blue-900">{chatterPending}</p>
        </div>
        <div className="bg-amber-50 rounded-lg p-4">
          <p className="text-sm font-medium text-amber-700">P&F Pending</p>
          <p className="text-3xl font-bold text-amber-900">{pnfPending}</p>
        </div>
      </div>

      {/* Two panels */}
      <div className="flex gap-8 flex-col md:flex-row">
        <ChecklistPanel
          title="The Chatter"
          type="chatter"
          companies={state.companies}
          accentColor="#387ed1"
        />
        <ChecklistPanel
          title="Points & Figures"
          type="pnf"
          companies={state.companies}
          accentColor="#d97706"
        />
      </div>
    </div>
  );
};
