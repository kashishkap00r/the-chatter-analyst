import React from 'react';
import type { AnalysisStage, ProgressEvent } from '../types';
import LoadingState from './LoadingState';

interface BatchStats {
  completed: number;
  failed: number;
  total: number;
  currentLabel?: string;
}

interface AnalysisProgressPanelProps {
  title: string;
  subtitle: string;
  progress?: ProgressEvent;
  batchStats?: BatchStats;
}

const stageOrder: AnalysisStage[] = ['preparing', 'uploading', 'analyzing', 'finalizing', 'complete'];

const stageLabels: Record<AnalysisStage, string> = {
  idle: 'Idle',
  preparing: 'Preparing',
  uploading: 'Uploading',
  analyzing: 'Analyzing',
  finalizing: 'Finalizing',
  complete: 'Complete',
  error: 'Error',
};

const stageFallbackPercent: Record<AnalysisStage, number> = {
  idle: 0,
  preparing: 10,
  uploading: 30,
  analyzing: 64,
  finalizing: 88,
  complete: 100,
  error: 100,
};

const getStageIndex = (stage?: AnalysisStage): number => {
  if (!stage) return -1;
  return stageOrder.indexOf(stage);
};

const AnalysisProgressPanel: React.FC<AnalysisProgressPanelProps> = ({ title, subtitle, progress, batchStats }) => {
  const currentStage = progress?.stage ?? 'preparing';
  const currentIndex = getStageIndex(currentStage);
  const percent = Math.min(100, Math.max(0, progress?.percent ?? stageFallbackPercent[currentStage]));

  return (
    <section className="rounded-2xl border border-line bg-white shadow-panel p-5 sm:p-6">
      <header className="mb-4">
        <p className="text-xs uppercase tracking-[0.18em] text-stone font-semibold">Live Activity</p>
        <h3 className="font-serif text-2xl text-ink mt-1">{title}</h3>
        <p className="text-sm text-stone mt-1">{subtitle}</p>
      </header>

      <div className="rounded-xl border border-brand/20 bg-brand-soft/50 p-4 mb-5">
        <LoadingState message={progress?.message || 'Working...'} compact />
      </div>

      <div className="mb-5" aria-live="polite">
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.14em] text-stone mb-2">
          <span>{stageLabels[currentStage]}</span>
          <span>{Math.round(percent)}%</span>
        </div>
        <div className="h-2 rounded-full bg-line overflow-hidden">
          <div
            className="h-full bg-brand transition-all duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {batchStats && (
        <div className="rounded-xl border border-line bg-canvas p-4 mb-5 text-sm text-stone space-y-1">
          <p>
            Processed <span className="font-semibold text-ink">{batchStats.completed + batchStats.failed}</span> of{' '}
            <span className="font-semibold text-ink">{batchStats.total}</span>
          </p>
          <p>
            Completed: <span className="font-semibold text-ink">{batchStats.completed}</span> | Failed:{' '}
            <span className="font-semibold text-ink">{batchStats.failed}</span>
          </p>
          {batchStats.currentLabel && (
            <p className="truncate">
              Current: <span className="font-semibold text-ink">{batchStats.currentLabel}</span>
            </p>
          )}
        </div>
      )}

      <ol className="space-y-2">
        {stageOrder.map((stage) => {
          const stepIndex = getStageIndex(stage);
          const isDone = currentIndex >= 0 && stepIndex < currentIndex;
          const isActive = stage === currentStage;

          return (
            <li key={stage} className="flex items-center gap-3 text-sm">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isDone ? 'bg-brand' : isActive ? 'bg-amber-500 animate-pulse' : 'bg-line'
                }`}
              />
              <span className={`${isActive ? 'text-ink font-semibold' : 'text-stone'}`}>{stageLabels[stage]}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

export default AnalysisProgressPanel;
