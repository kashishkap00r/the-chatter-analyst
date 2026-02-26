import type { BatchFile, PointsBatchFile, PlotlineBatchFile } from '../../../types';

type BatchStatus = BatchFile['status'] | PointsBatchFile['status'] | PlotlineBatchFile['status'];

export const statusStyles: Record<BatchStatus, string> = {
  pending: 'bg-stone-100 text-stone-700 border-stone-200',
  parsing: 'bg-amber-50 text-amber-700 border-amber-200',
  ready: 'bg-sky-50 text-sky-700 border-sky-200',
  analyzing: 'bg-brand-soft text-brand border-brand/30',
  complete: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
};

export const statusLabels: Record<BatchStatus, string> = {
  pending: 'Pending',
  parsing: 'Parsing',
  ready: 'Ready',
  analyzing: 'Analyzing',
  complete: 'Complete',
  error: 'Error',
};
