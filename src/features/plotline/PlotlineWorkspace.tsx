import React from 'react';
import type { PlotlineFeatureController } from './usePlotlineFeature';
import type { PlotlineCompanyGroup, PlotlineQuote } from '../../../types';

interface PlotlineWorkspaceProps {
  feature: PlotlineFeatureController;
  disabled: boolean;
}

export const PlotlineWorkspace = ({ feature, disabled }: PlotlineWorkspaceProps) => {
  const hasResults = feature.companyGroups.length > 0;
  const canAnalyze = feature.thesis.trim().length >= 10 && feature.plotlineReadyCount > 0 && !feature.isAnalyzingPlotlineBatch;

  return (
    <>
      {/* Input Panel */}
      <section className="lg:col-span-5 lg:sticky lg:top-24 self-start">
      <div className="bg-white rounded-z-md shadow-panel p-6 flex flex-col gap-5">
        <div>
          <p className="text-xs text-stone uppercase tracking-wider mb-1">Input Desk</p>
          <h2 className="text-2xl font-medium text-gray-900">Plotline Input</h2>
        </div>

        {/* Thesis Textarea */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-700">Thesis / Theme</label>
          <textarea
            className="w-full h-32 p-3 rounded-z-sm border border-line text-sm text-gray-900 resize-y placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
            placeholder="Describe what you're investigating. E.g., 'How FMCG companies are responding to quick commerce — channel cannibalization, distribution restructuring, and separate QC strategies.'"
            value={feature.thesis}
            onChange={(e) => feature.setThesis(e.target.value)}
            disabled={disabled || feature.isAnalyzingPlotlineBatch}
          />
          <p className="text-xs text-stone">
            {feature.thesis.trim().length < 10
              ? `${Math.max(0, 10 - feature.thesis.trim().length)} more characters needed`
              : 'Gemini will find all quotes relevant to this thesis'}
          </p>
        </div>

        {/* File Upload */}
        <div>
          <div
            className="border-2 border-dashed border-blue-200 bg-blue-50/30 rounded-z-sm p-6 text-center cursor-pointer hover:bg-blue-50/60 transition"
            onClick={() => !disabled && !feature.isAnalyzingPlotlineBatch && feature.plotlineFileInputRef.current?.click()}
          >
            <p className="text-sm text-gray-600">Drop or select transcript files</p>
            <p className="text-xs text-stone mt-1">Supports PDF and TXT</p>
            <input
              ref={feature.plotlineFileInputRef}
              type="file"
              accept=".pdf,.txt"
              multiple
              className="hidden"
              onChange={feature.handlePlotlineFileUpload}
              disabled={disabled || feature.isAnalyzingPlotlineBatch}
            />
          </div>
        </div>

        {/* File Queue */}
        <div className="border border-line rounded-z-sm p-3 min-h-[48px]">
          {feature.plotlineBatchFiles.length === 0 ? (
            <p className="text-sm text-stone text-center">No files queued yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {feature.plotlineBatchFiles.map((file) => (
                <li key={file.id} className="flex items-center justify-between text-sm">
                  <span className="truncate max-w-[260px]">{file.name}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${
                      file.status === 'complete' ? 'text-green-600' :
                      file.status === 'error' ? 'text-red-500' :
                      file.status === 'analyzing' ? 'text-brand' :
                      'text-stone'
                    }`}>
                      {file.status === 'complete' ? `${file.result?.quotes.length ?? 0} quotes` :
                       file.status === 'error' ? 'Error' :
                       file.status === 'analyzing' ? 'Analyzing...' :
                       file.status === 'parsing' ? 'Parsing...' :
                       'Ready'}
                    </span>
                    {(file.status === 'ready' || file.status === 'error') && (
                      <button
                        className="text-xs text-stone hover:text-red-500 transition"
                        onClick={() => feature.removePlotlineBatchFile(file.id)}
                      >
                        x
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3 pt-1">
          <button
            className="text-sm text-stone hover:text-gray-700 transition"
            onClick={feature.clearPlotline}
            disabled={disabled || feature.isAnalyzingPlotlineBatch}
          >
            Clear
          </button>
          <button
            className="flex-1 py-2.5 rounded-z-sm text-sm font-medium text-white bg-brand hover:bg-brand/90 transition disabled:opacity-50"
            onClick={feature.handleAnalyzePlotlineBatch}
            disabled={!canAnalyze || disabled}
          >
            {feature.isAnalyzingPlotlineBatch
              ? 'Analyzing...'
              : `Analyze ${feature.plotlineReadyCount} File${feature.plotlineReadyCount !== 1 ? 's' : ''}`}
          </button>
        </div>

        {feature.plotlineBatchProgress && feature.isAnalyzingPlotlineBatch && (
          <div className="text-xs text-stone">
            {feature.plotlineBatchProgress.currentLabel && (
              <p className="truncate">Processing: {feature.plotlineBatchProgress.currentLabel}</p>
            )}
            <p>{feature.plotlineBatchProgress.completed}/{feature.plotlineBatchProgress.total} complete{feature.plotlineBatchProgress.failed > 0 ? ` (${feature.plotlineBatchProgress.failed} failed)` : ''}</p>
          </div>
        )}
      </div>
      </section>

      {/* Curation Panel */}
      <section className="lg:col-span-7">
        {!hasResults ? (
          <div className="bg-gray-50 rounded-z-md p-10 text-center">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Ready for Plotline</h3>
            <p className="text-sm text-stone max-w-md mx-auto">
              Describe your thesis, upload transcript files, and run extraction. You'll curate the quotes here before copying.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Curation Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  {feature.selectedQuoteCount} of {feature.totalQuoteCount} quotes selected
                </h3>
                <div className="flex items-center gap-1 bg-gray-100 rounded-z-sm p-0.5">
                  <button
                    className={`px-3 py-1 text-xs rounded-z-sm transition ${
                      feature.groupingMode === 'company'
                        ? 'bg-white shadow-sm text-gray-900'
                        : 'text-stone hover:text-gray-700'
                    }`}
                    onClick={() => feature.setGroupingMode('company')}
                  >
                    By Company
                  </button>
                  <button
                    className={`px-3 py-1 text-xs rounded-z-sm transition ${
                      feature.groupingMode === 'period'
                        ? 'bg-white shadow-sm text-gray-900'
                        : 'text-stone hover:text-gray-700'
                    }`}
                    onClick={() => feature.setGroupingMode('period')}
                  >
                    By Period
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 text-xs text-stone hover:text-gray-700 transition"
                  onClick={feature.selectAllQuotes}
                >
                  Select All
                </button>
                <button
                  className="px-4 py-2 text-sm font-medium text-white bg-brand rounded-z-sm hover:bg-brand/90 transition disabled:opacity-50"
                  onClick={feature.handleCopyBrief}
                  disabled={feature.selectedQuoteCount === 0}
                >
                  {feature.plotlineCopyStatus === 'copied' ? 'Copied!' :
                   feature.plotlineCopyStatus === 'error' ? 'Copy Failed' :
                   'Copy Brief'}
                </button>
              </div>
            </div>

            {/* Quote Groups */}
            {feature.groupingMode === 'company' ? (
              feature.companyGroups.map((group) => (
                <CompanyQuoteGroup
                  key={group.companyKey}
                  group={group}
                  onToggle={feature.toggleQuote}
                  onDeselectAll={feature.deselectCompany}
                />
              ))
            ) : (
              <PeriodQuoteGroups
                groups={feature.companyGroups}
                onToggle={feature.toggleQuote}
              />
            )}
          </div>
        )}
      </section>
    </>
  );
};

/* ---- Sub-components ---- */

const CompanyQuoteGroup: React.FC<{
  group: PlotlineCompanyGroup;
  onToggle: (companyKey: string, quoteId: string) => void;
  onDeselectAll: (companyKey: string) => void;
}> = ({ group, onToggle, onDeselectAll }) => {
  const selectedCount = group.quotes.filter(q => q.selected).length;

  return (
    <div className="bg-white rounded-z-md shadow-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="text-base font-semibold text-gray-900">
            {group.companyName}
            <span className="ml-2 text-xs text-stone font-normal">{group.nseScrip} &middot; {group.industry}</span>
          </h4>
          <p className="text-xs text-stone mt-0.5">
            {group.periods.join(', ')} &middot; {selectedCount}/{group.quotes.length} selected
          </p>
        </div>
        <button
          className="text-xs text-stone hover:text-red-500 transition"
          onClick={() => onDeselectAll(group.companyKey)}
        >
          Deselect All
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {group.quotes.map((quote) => (
          <QuoteCard
            key={quote.quoteId}
            quote={quote}
            companyKey={group.companyKey}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
};

const PeriodQuoteGroups: React.FC<{
  groups: PlotlineCompanyGroup[];
  onToggle: (companyKey: string, quoteId: string) => void;
}> = ({ groups, onToggle }) => {
  // Flatten all quotes with company info, sort by period
  const allQuotes = groups.flatMap(g =>
    g.quotes.map(q => ({ ...q, companyKey: g.companyKey, companyName: g.companyName, nseScrip: g.nseScrip })),
  );
  allQuotes.sort((a, b) => a.periodSortKey - b.periodSortKey);

  // Group by periodLabel
  const periodMap = new Map<string, typeof allQuotes>();
  for (const q of allQuotes) {
    const existing = periodMap.get(q.periodLabel) || [];
    existing.push(q);
    periodMap.set(q.periodLabel, existing);
  }

  return (
    <>
      {Array.from(periodMap.entries()).map(([period, quotes]) => (
        <div key={period} className="bg-white rounded-z-md shadow-panel p-5">
          <h4 className="text-base font-semibold text-gray-900 mb-4">{period}</h4>
          <div className="flex flex-col gap-3">
            {quotes.map((q) => (
              <QuoteCard
                key={q.quoteId}
                quote={q}
                companyKey={q.companyKey}
                companyLabel={`${q.companyName} (${q.nseScrip})`}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
};

const QuoteCard: React.FC<{
  quote: PlotlineQuote;
  companyKey: string;
  companyLabel?: string;
  onToggle: (companyKey: string, quoteId: string) => void;
}> = ({ quote, companyKey, companyLabel, onToggle }) => (
  <label
    className={`flex gap-3 p-3 rounded-z-sm border cursor-pointer transition ${
      quote.selected
        ? 'border-brand/30 bg-blue-50/30'
        : 'border-line bg-gray-50/50 opacity-60'
    }`}
  >
    <input
      type="checkbox"
      checked={quote.selected}
      onChange={() => onToggle(companyKey, quote.quoteId)}
      className="mt-1 shrink-0 accent-brand"
    />
    <div className="flex-1 min-w-0">
      {companyLabel && (
        <p className="text-xs text-brand font-medium mb-1">{companyLabel}</p>
      )}
      <p className="text-sm text-gray-800 leading-relaxed">{quote.quote}</p>
      <p className="text-xs text-stone mt-1.5">
        &mdash; {quote.speakerName}{quote.speakerDesignation ? `, ${quote.speakerDesignation}` : ''}
        <span className="ml-2">{quote.periodLabel}</span>
      </p>
    </div>
  </label>
);
