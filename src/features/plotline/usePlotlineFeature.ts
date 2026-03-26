import React, { useState, useRef, useCallback, useMemo } from 'react';
import type {
  PlotlineBatchFile,
  PlotlineCompanyGroup,
  PlotlineQuote,
  PlotlineFileResult,
  ProgressEvent,
} from '../../../types';
import { ProviderType, ModelType } from '../../../types';
import type { PlotlineSessionSlice, BatchProgressState } from '../../shared/state/sessionTypes';
import { analyzePlotlineTranscript, parsePdfToText } from '../../../services/geminiService';

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;

interface UsePlotlineFeatureParams {
  provider: ProviderType;
  selectedModel: ModelType;
}

export type PlotlineGroupingMode = 'company' | 'period';

export interface PlotlineFeatureController {
  // State
  thesis: string;
  plotlineBatchFiles: PlotlineBatchFile[];
  companyGroups: PlotlineCompanyGroup[];
  isAnalyzingPlotlineBatch: boolean;
  plotlineBatchProgress: BatchProgressState | null;
  groupingMode: PlotlineGroupingMode;
  plotlineCopyStatus: 'idle' | 'copied' | 'error';
  plotlineFileInputRef: React.RefObject<HTMLInputElement | null>;
  plotlineReadyCount: number;
  selectedQuoteCount: number;
  totalQuoteCount: number;

  // Actions
  setThesis: (value: string) => void;
  setGroupingMode: (mode: PlotlineGroupingMode) => void;
  handlePlotlineFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleAnalyzePlotlineBatch: () => Promise<void>;
  toggleQuote: (companyKey: string, quoteId: string) => void;
  deselectCompany: (companyKey: string) => void;
  selectAllQuotes: () => void;
  handleCopyBrief: () => Promise<void>;
  removePlotlineBatchFile: (id: string) => void;
  clearPlotline: () => void;

  // Session
  sessionSlice: PlotlineSessionSlice;
  restoreFromSessionSlice: (slice: PlotlineSessionSlice) => void;
}

const generateQuoteId = (companyKey: string, index: number, periodSortKey: number): string =>
  `${companyKey}-${periodSortKey}-${index}`;

const buildCompanyKey = (result: PlotlineFileResult): string =>
  result.nseScrip || result.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const aggregateCompanyGroups = (files: PlotlineBatchFile[]): PlotlineCompanyGroup[] => {
  const groupMap = new Map<string, PlotlineCompanyGroup>();

  for (const file of files) {
    if (file.status !== 'complete' || !file.result) continue;
    const result = file.result;
    const key = buildCompanyKey(result);

    let group = groupMap.get(key);
    if (!group) {
      group = {
        companyKey: key,
        companyName: result.companyName,
        nseScrip: result.nseScrip,
        industry: result.industry,
        periods: [],
        quotes: [],
      };
      groupMap.set(key, group);
    }

    if (result.fiscalPeriod && !group.periods.includes(result.fiscalPeriod)) {
      group.periods.push(result.fiscalPeriod);
    }

    for (let i = 0; i < result.quotes.length; i++) {
      const q = result.quotes[i];
      const quoteId = q.quoteId || generateQuoteId(key, group.quotes.length, q.periodSortKey);
      group.quotes.push({ ...q, quoteId, selected: q.selected ?? true });
    }
  }

  // Sort quotes chronologically within each group
  for (const group of groupMap.values()) {
    group.quotes.sort((a, b) => a.periodSortKey - b.periodSortKey);
    group.periods.sort();
  }

  // Sort groups by company name
  return Array.from(groupMap.values()).sort((a, b) =>
    a.companyName.localeCompare(b.companyName),
  );
};

const buildClipboardBrief = (thesis: string, groups: PlotlineCompanyGroup[]): string => {
  const selectedGroups = groups
    .map(g => ({
      ...g,
      quotes: g.quotes.filter(q => q.selected),
    }))
    .filter(g => g.quotes.length > 0);

  if (selectedGroups.length === 0) return '';

  const lines: string[] = [];

  lines.push('THEME');
  lines.push(thesis.trim());
  lines.push('');
  lines.push('COMPANIES COVERED');
  for (const g of selectedGroups) {
    const periods = [...new Set(g.quotes.map(q => q.periodLabel))].join(', ');
    lines.push(`${g.companyName} (${g.nseScrip}) — ${periods}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('QUOTES');

  for (const g of selectedGroups) {
    lines.push('');
    for (const q of g.quotes) {
      lines.push(`${g.companyName} | ${q.periodLabel}`);
      lines.push(`Speaker: ${q.speakerName}, ${q.speakerDesignation}`);
      lines.push(`"${q.quote}"`);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const usePlotlineFeature = ({
  provider,
  selectedModel,
}: UsePlotlineFeatureParams): PlotlineFeatureController => {
  const [thesis, setThesis] = useState('');
  const [batchFiles, setBatchFiles] = useState<PlotlineBatchFile[]>([]);
  const [companyGroups, setCompanyGroups] = useState<PlotlineCompanyGroup[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState | null>(null);
  const [groupingMode, setGroupingMode] = useState<PlotlineGroupingMode>('company');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const readyCount = useMemo(
    () => batchFiles.filter(f => f.status === 'ready').length,
    [batchFiles],
  );

  const totalQuoteCount = useMemo(
    () => companyGroups.reduce((sum, g) => sum + g.quotes.length, 0),
    [companyGroups],
  );

  const selectedQuoteCount = useMemo(
    () => companyGroups.reduce((sum, g) => sum + g.quotes.filter(q => q.selected).length, 0),
    [companyGroups],
  );

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList) return;

    const newFiles: PlotlineBatchFile[] = [];
    for (const file of Array.from(fileList) as File[]) {
      const id = crypto.randomUUID();
      const isPdf = file.name.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        const placeholder: PlotlineBatchFile = { id, name: file.name, content: '', status: 'parsing', progress: undefined };
        newFiles.push(placeholder);
        setBatchFiles(prev => [...prev, placeholder]);
        try {
          const text = await parsePdfToText(file);
          setBatchFiles(prev =>
            prev.map(f => f.id === id ? { ...f, content: text, status: 'ready' as const } : f),
          );
          newFiles[newFiles.length - 1] = { id, name: file.name, content: text, status: 'ready' };
        } catch (err: any) {
          setBatchFiles(prev =>
            prev.map(f => f.id === id ? { ...f, status: 'error' as const, error: err.message } : f),
          );
          newFiles[newFiles.length - 1] = { id, name: file.name, content: '', status: 'error', error: err.message };
        }
      } else {
        const text = await file.text();
        const newFile: PlotlineBatchFile = { id, name: file.name, content: text, status: 'ready' };
        newFiles.push(newFile);
        setBatchFiles(prev => [...prev, newFile]);
      }
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleAnalyzeBatch = useCallback(async () => {
    if (!thesis.trim() || readyCount === 0) return;

    setIsAnalyzing(true);
    const readyFiles = batchFiles.filter(f => f.status === 'ready');
    const total = readyFiles.length;
    let completed = 0;
    let failed = 0;

    setBatchProgress({ total, completed: 0, failed: 0 });

    for (const file of readyFiles) {
      setBatchFiles(prev =>
        prev.map(f => f.id === file.id ? { ...f, status: 'analyzing' as const } : f),
      );
      setBatchProgress({ total, completed, failed, currentLabel: file.name });

      let attempt = 0;
      let success = false;

      while (attempt <= MAX_RETRIES && !success) {
        try {
          const result = await analyzePlotlineTranscript(
            file.content,
            thesis,
            provider,
            selectedModel,
            (progress: ProgressEvent) => {
              setBatchFiles(prev =>
                prev.map(f => f.id === file.id ? { ...f, progress } : f),
              );
            },
          );

          setBatchFiles(prev =>
            prev.map(f => f.id === file.id
              ? { ...f, status: 'complete' as const, result, progress: undefined }
              : f,
            ),
          );
          success = true;
          completed++;
        } catch (err: any) {
          attempt++;
          if (attempt > MAX_RETRIES) {
            setBatchFiles(prev =>
              prev.map(f => f.id === file.id
                ? { ...f, status: 'error' as const, error: err.message, progress: undefined }
                : f,
              ),
            );
            failed++;
          } else {
            await wait(RETRY_BASE_DELAY_MS * attempt);
          }
        }
      }

      setBatchProgress({ total, completed, failed });
    }

    // Aggregate after all files processed
    setBatchFiles(prev => {
      const groups = aggregateCompanyGroups(prev);
      setCompanyGroups(groups);
      return prev;
    });

    setIsAnalyzing(false);
  }, [thesis, batchFiles, readyCount, provider, selectedModel]);

  const toggleQuote = useCallback((companyKey: string, quoteId: string) => {
    setCompanyGroups(prev =>
      prev.map(g =>
        g.companyKey !== companyKey ? g : {
          ...g,
          quotes: g.quotes.map(q =>
            q.quoteId !== quoteId ? q : { ...q, selected: !q.selected },
          ),
        },
      ),
    );
  }, []);

  const deselectCompany = useCallback((companyKey: string) => {
    setCompanyGroups(prev =>
      prev.map(g =>
        g.companyKey !== companyKey ? g : {
          ...g,
          quotes: g.quotes.map(q => ({ ...q, selected: false })),
        },
      ),
    );
  }, []);

  const selectAllQuotes = useCallback(() => {
    setCompanyGroups(prev =>
      prev.map(g => ({
        ...g,
        quotes: g.quotes.map(q => ({ ...q, selected: true })),
      })),
    );
  }, []);

  const handleCopyBrief = useCallback(async () => {
    const brief = buildClipboardBrief(thesis, companyGroups);
    if (!brief) return;

    try {
      await navigator.clipboard.writeText(brief);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 1800);
    } catch {
      setCopyStatus('error');
      setTimeout(() => setCopyStatus('idle'), 3500);
    }
  }, [thesis, companyGroups]);

  const removeBatchFile = useCallback((id: string) => {
    setBatchFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const clearPlotline = useCallback(() => {
    setThesis('');
    setBatchFiles([]);
    setCompanyGroups([]);
    setIsAnalyzing(false);
    setBatchProgress(null);
    setCopyStatus('idle');
  }, []);

  const sessionSlice: PlotlineSessionSlice = useMemo(() => ({
    batchFiles,
    thesis,
    companyGroups,
  }), [batchFiles, thesis, companyGroups]);

  const restoreFromSessionSlice = useCallback((slice: PlotlineSessionSlice) => {
    setBatchFiles(slice.batchFiles || []);
    setThesis(slice.thesis || '');
    setCompanyGroups(slice.companyGroups || []);
  }, []);

  return {
    thesis,
    plotlineBatchFiles: batchFiles,
    companyGroups,
    isAnalyzingPlotlineBatch: isAnalyzing,
    plotlineBatchProgress: batchProgress,
    groupingMode,
    plotlineCopyStatus: copyStatus,
    plotlineFileInputRef: fileInputRef,
    plotlineReadyCount: readyCount,
    selectedQuoteCount,
    totalQuoteCount,
    setThesis,
    setGroupingMode,
    handlePlotlineFileUpload: handleFileUpload,
    handleAnalyzePlotlineBatch: handleAnalyzeBatch,
    toggleQuote,
    deselectCompany,
    selectAllQuotes,
    handleCopyBrief,
    removePlotlineBatchFile: removeBatchFile,
    clearPlotline,
    sessionSlice,
    restoreFromSessionSlice,
  };
};
