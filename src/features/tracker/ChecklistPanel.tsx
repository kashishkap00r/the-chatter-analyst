import React, { useState } from "react";
import type { TrackedCompany } from "./types";

interface ChecklistPanelProps {
  title: string;
  type: "chatter" | "pnf";
  companies: TrackedCompany[];
  accentColor: string;
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 0;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / 86400000);
}

export const ChecklistPanel: React.FC<ChecklistPanelProps> = ({
  title,
  type,
  companies,
  accentColor,
}) => {
  const [showCovered, setShowCovered] = useState(false);
  const [showNotReported, setShowNotReported] = useState(false);

  const checklist = (c: TrackedCompany) => c[type];
  const pending = companies
    .filter((c) => checklist(c).eligible && !checklist(c).covered)
    .sort((a, b) => {
      const da = checklist(a).eligible_since || "";
      const db = checklist(b).eligible_since || "";
      return da.localeCompare(db);
    });
  const covered = companies.filter((c) => checklist(c).covered);
  const notReported = companies.filter(
    (c) => !checklist(c).eligible && !checklist(c).covered
  );

  const total = pending.length + covered.length;

  return (
    <div className="flex-1 min-w-0">
      <div className="mb-4">
        <h2 className="text-lg font-semibold" style={{ color: accentColor }}>
          {title}
        </h2>
        <p className="text-sm text-gray-500">
          {covered.length}/{total} covered · {pending.length} pending
        </p>
        {total > 0 && (
          <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${(covered.length / total) * 100}%`,
                backgroundColor: accentColor,
              }}
            />
          </div>
        )}
      </div>

      {/* Pending section */}
      <div className="mb-4">
        <h3 className="text-sm font-medium text-gray-700 mb-2">
          Pending ({pending.length})
        </h3>
        {pending.length === 0 ? (
          <p className="text-sm text-gray-400 italic">All caught up!</p>
        ) : (
          <ul className="space-y-1">
            {pending.map((c) => (
              <li
                key={c.symbol}
                className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 text-sm"
              >
                <span className="font-medium text-gray-800">{c.name}</span>
                <span className="text-xs text-gray-400">
                  {daysSince(checklist(c).eligible_since)}d ago
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Covered section */}
      <div className="mb-4">
        <button
          onClick={() => setShowCovered(!showCovered)}
          className="text-sm font-medium text-gray-500 hover:text-gray-700 mb-2 flex items-center gap-1"
        >
          <span>{showCovered ? "▾" : "▸"}</span>
          Covered ({covered.length})
        </button>
        {showCovered && (
          <ul className="space-y-1">
            {covered.map((c) => (
              <li
                key={c.symbol}
                className="flex items-center justify-between py-1.5 px-2 rounded text-sm text-gray-400 line-through"
              >
                <span>{c.name}</span>
                <span className="text-xs no-underline">
                  {checklist(c).covered_date}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Not yet reported section */}
      <div>
        <button
          onClick={() => setShowNotReported(!showNotReported)}
          className="text-sm font-medium text-gray-400 hover:text-gray-600 mb-2 flex items-center gap-1"
        >
          <span>{showNotReported ? "▾" : "▸"}</span>
          Not yet reported ({notReported.length})
        </button>
        {showNotReported && (
          <ul className="space-y-1">
            {notReported.map((c) => (
              <li key={c.symbol} className="py-1 px-2 text-sm text-gray-300">
                {c.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
