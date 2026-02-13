import React, { useState, useCallback, useRef } from 'react';
import { analyzeConcallLinks, analyzePresentation, convertPdfToImages } from './services/geminiService';
import { ModelType, type AppMode, type ChatterAnalysisResult, type ChatterLinkFailure, type PointsAnalysisState } from './types';
import QuoteCard from './components/QuoteCard';
import LoadingState from './components/LoadingState';
import PointsCard from './components/PointsCard';
import { buildChatterClipboardExport } from './utils/chatterCopyExport';

const parseConcallLinks = (input: string): string[] => {
  const rawLinks = input
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(rawLinks));
};

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('chatter');
  const [model, setModel] = useState<ModelType>(ModelType.FLASH);

  // State for "The Chatter" (links only)
  const [concallLinksInput, setConcallLinksInput] = useState('');
  const [isAnalyzingLinks, setIsAnalyzingLinks] = useState(false);
  const [chatterResults, setChatterResults] = useState<ChatterAnalysisResult[]>([]);
  const [chatterFailures, setChatterFailures] = useState<ChatterLinkFailure[]>([]);
  const [chatterErrorMessage, setChatterErrorMessage] = useState('');
  const [copyAllStatus, setCopyAllStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [copyAllErrorMessage, setCopyAllErrorMessage] = useState('');

  // State for "Points & Figures"
  const [pointsFile, setPointsFile] = useState<File | null>(null);
  const [pointsState, setPointsState] = useState<PointsAnalysisState>({ status: 'idle' });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAnalyzeConcallLinks = useCallback(async () => {
    const links = parseConcallLinks(concallLinksInput);
    if (links.length === 0) {
      return;
    }

    setIsAnalyzingLinks(true);
    setChatterErrorMessage('');
    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');

    try {
      const response = await analyzeConcallLinks(links, model);
      setChatterResults(response.results || []);
      setChatterFailures(response.failures || []);

      if ((response.results || []).length === 0 && (response.failures || []).length > 0) {
        setChatterErrorMessage('None of the supplied links could be analyzed. Please check the failed links below.');
      }
    } catch (error: any) {
      setChatterResults([]);
      setChatterFailures([]);
      setChatterErrorMessage(error?.message || 'Failed to analyze concall links.');
    } finally {
      setIsAnalyzingLinks(false);
    }
  }, [concallLinksInput, model]);

  const handlePointsFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setPointsFile(file);
      setPointsState({ status: 'idle' });
    } else if (file) {
      setPointsFile(null);
      setPointsState({ status: 'error', errorMessage: 'Only PDF files are supported for presentations.' });
    }
  };

  const handleAnalyzePresentation = useCallback(async () => {
    if (!pointsFile) return;

    const onProgress = (progressMessage: string) => {
      setPointsState((prev) => ({ ...prev, progressMessage }));
    };

    setPointsState({ status: 'parsing', progressMessage: 'Preparing PDF...' });
    try {
      const pageImages = await convertPdfToImages(pointsFile, onProgress);
      setPointsState({ status: 'analyzing', progressMessage: 'AI is analyzing slides...' });
      const result = await analyzePresentation(pageImages, onProgress);
      setPointsState({ status: 'complete', result });
    } catch (e: any) {
      setPointsState({ status: 'error', errorMessage: e.message });
    }
  }, [pointsFile]);

  const handleCopyAllChatter = useCallback(async () => {
    if (chatterResults.length === 0) {
      return;
    }

    const { html, text } = buildChatterClipboardExport(chatterResults);
    const clipboard = navigator?.clipboard;
    if (!clipboard) {
      setCopyAllStatus('error');
      setCopyAllErrorMessage('Clipboard API is not available in this browser.');
      setTimeout(() => setCopyAllStatus('idle'), 4000);
      return;
    }

    try {
      const ClipboardItemCtor = (window as any).ClipboardItem;
      if (ClipboardItemCtor && window.isSecureContext) {
        const clipboardItem = new ClipboardItemCtor({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        });
        await clipboard.write([clipboardItem]);
      } else {
        await clipboard.writeText(text);
      }
      setCopyAllStatus('copied');
      setCopyAllErrorMessage('');
      setTimeout(() => setCopyAllStatus('idle'), 2000);
    } catch {
      try {
        await clipboard.writeText(text);
        setCopyAllStatus('copied');
        setCopyAllErrorMessage('');
        setTimeout(() => setCopyAllStatus('idle'), 2000);
      } catch (fallbackError: any) {
        setCopyAllStatus('error');
        setCopyAllErrorMessage(fallbackError?.message || 'Copy failed. Please allow clipboard access.');
        setTimeout(() => setCopyAllStatus('idle'), 4000);
      }
    }
  }, [chatterResults]);

  const clearAll = () => {
    setConcallLinksInput('');
    setIsAnalyzingLinks(false);
    setChatterResults([]);
    setChatterFailures([]);
    setChatterErrorMessage('');
    setCopyAllStatus('idle');
    setCopyAllErrorMessage('');

    setPointsFile(null);
    setPointsState({ status: 'idle' });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const renderChatterUI = () => {
    const parsedLinks = parseConcallLinks(concallLinksInput);

    return (
      <>
        <div className="lg:col-span-5 flex flex-col lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)] h-auto">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex flex-col h-full min-h-[500px] lg:min-h-0">
            <div className="flex justify-between items-center mb-4 shrink-0">
              <h2 className="text-lg font-semibold text-gray-800">Concall Links Input</h2>
              <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-600">PDF Links Only</span>
            </div>

            <textarea
              className="flex-1 w-full p-4 bg-gray-50 border rounded-lg text-sm"
              placeholder={[
                'Paste one direct concall PDF URL per line',
                '',
                'https://www.bseindia.com/xml-data/corpfiling/AttachLive/example.pdf',
                'https://files.tijoristack.ai/concall/transcript/example.pdf',
              ].join('\n')}
              value={concallLinksInput}
              onChange={(e) => setConcallLinksInput(e.target.value)}
            />

            <p className="text-xs text-gray-500 mt-3">
              {parsedLinks.length} unique link{parsedLinks.length === 1 ? '' : 's'} detected
            </p>

            <div className="flex gap-3 mt-auto shrink-0 pt-4">
              <button onClick={clearAll} disabled={isAnalyzingLinks} className="px-4 py-3 rounded-lg border">
                Clear
              </button>
              <button
                onClick={handleAnalyzeConcallLinks}
                disabled={parsedLinks.length === 0 || isAnalyzingLinks}
                className="flex-1 bg-gray-900 text-white font-medium py-3 px-4 rounded-lg"
              >
                {isAnalyzingLinks ? 'Analyzing...' : `Analyze ${parsedLinks.length} Link${parsedLinks.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-7 space-y-8">
          {chatterResults.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-gray-600">
                {chatterResults.length} compan{chatterResults.length === 1 ? 'y' : 'ies'} ready for newsletter export
              </p>
              <button
                onClick={handleCopyAllChatter}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  copyAllStatus === 'copied'
                    ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                    : 'bg-gray-900 text-white'
                }`}
              >
                {copyAllStatus === 'copied' ? 'Copied All' : 'Copy All'}
              </button>
            </div>
          )}

          {copyAllStatus === 'error' && copyAllErrorMessage && (
            <div className="bg-red-100 p-4 rounded-lg text-sm text-red-800">{copyAllErrorMessage}</div>
          )}

          {chatterFailures.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-amber-800 mb-2">Skipped Links</h3>
              <div className="space-y-2 text-xs text-amber-900">
                {chatterFailures.map((failure, index) => (
                  <div key={`${failure.link}-${index}`} className="p-2 rounded bg-amber-100 border border-amber-200">
                    <p className="font-medium break-all">{failure.link}</p>
                    <p>{failure.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isAnalyzingLinks && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8">
              <LoadingState />
              <p className="text-center text-sm text-indigo-600 mt-4">Analyzing concall links...</p>
            </div>
          )}

          {!isAnalyzingLinks && chatterErrorMessage && (
            <div className="bg-red-100 p-4 rounded-lg">{chatterErrorMessage}</div>
          )}

          {!isAnalyzingLinks && !chatterErrorMessage && chatterResults.length === 0 && chatterFailures.length === 0 && (
            <div className="text-center p-12 border-2 border-dashed rounded-xl">
              <h3 className="text-xl font-serif">Ready to Analyze Concall Links</h3>
              <p className="text-gray-500 mt-2">Paste direct transcript PDF links to extract quotes in one run.</p>
            </div>
          )}

          {chatterResults.map((result, resultIndex) => (
            <div key={`${result.companyName}-${resultIndex}`}>
              <div className="mb-4">
                <h2 className="text-2xl font-bold mb-2">
                  {result.companyName} | {result.marketCapCategory} | {result.industry}
                </h2>
                <p className="text-sm text-gray-600 mb-2">{result.companyDescription}</p>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <a
                    className="text-indigo-600 underline"
                    href={result.zerodhaStockUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Zerodha
                  </a>
                  <a
                    className="text-indigo-600 underline"
                    href={result.concallUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Concall
                  </a>
                </div>
              </div>
              {result.quotes.map((quote, index) => (
                <QuoteCard key={`${resultIndex}-${index}`} quoteData={quote} index={index} />
              ))}
            </div>
          ))}
        </div>
      </>
    );
  };

  const renderPointsUI = () => (
    <>
      <div className="lg:col-span-5 flex flex-col lg:sticky lg:top-24">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Presentation Input</h2>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center relative hover:bg-gray-100">
            <svg className="w-8 h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
            <p className="text-sm text-gray-500">Select a presentation (PDF only)</p>
            <input ref={fileInputRef} type="file" accept=".pdf" onChange={handlePointsFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"/>
          </div>
          {pointsFile && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg border flex items-center justify-between">
              <span className="text-sm font-medium truncate">{pointsFile.name}</span>
              <button onClick={() => { setPointsFile(null); setPointsState({ status: 'idle' }); if (fileInputRef.current) fileInputRef.current.value = ''; }} className="text-gray-400 hover:text-red-500">X</button>
            </div>
          )}
          <div className="flex gap-3 mt-6">
            <button onClick={clearAll} disabled={pointsState.status === 'analyzing' || pointsState.status === 'parsing'} className="px-4 py-3 rounded-lg border">Clear</button>
            <button onClick={handleAnalyzePresentation} disabled={!pointsFile || pointsState.status === 'analyzing' || pointsState.status === 'parsing'} className="flex-1 bg-gray-900 text-white font-medium py-3 px-4 rounded-lg">{pointsState.status === 'parsing' ? 'Preparing...' : pointsState.status === 'analyzing' ? 'Analyzing...' : 'Find Top 3 Slides'}</button>
          </div>
        </div>
      </div>
      <div className="lg:col-span-7 space-y-8">
        {pointsState.status === 'idle' && <div className="text-center p-12 border-2 border-dashed rounded-xl"><h3 className="text-xl font-serif">Ready to Analyze a Presentation</h3><p className="text-gray-500">Upload an investor presentation to find the top 3 most important slides.</p></div>}
        {(pointsState.status === 'parsing' || pointsState.status === 'analyzing') && <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8"><LoadingState /> <p className="text-center text-sm text-indigo-600 mt-4">{pointsState.progressMessage}</p></div>}
        {pointsState.status === 'error' && <div className="bg-red-100 p-4 rounded-lg">{pointsState.errorMessage}</div>}
        {pointsState.status === 'complete' && pointsState.result && (
          <div>
            <header className="mb-8">
              <h2 className="text-3xl font-serif font-bold text-gray-900">
                {pointsState.result.companyName}
              </h2>
              <p className="text-lg text-gray-500">{pointsState.result.fiscalPeriod} - Key Insights</p>
            </header>
            <div className="space-y-12">
              {pointsState.result.slides.map((slide, index) => (
                <PointsCard key={slide.selectedPageNumber} slide={slide} index={index + 1} />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-24 flex flex-col justify-center">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gray-900 rounded flex items-center justify-center text-white font-serif font-bold text-xl">C</div>
              <h1 className="text-xl font-bold tracking-tight">Chatter Analyst</h1>
            </div>
            {appMode === 'chatter' && (
              <select value={model} onChange={(e) => setModel(e.target.value as ModelType)} className="text-sm border-gray-300 rounded-md shadow-sm">
                <option value={ModelType.FLASH}>Gemini 2.5 Flash (Fast)</option>
                <option value={ModelType.PRO}>Gemini 3 Pro (Deep)</option>
              </select>
            )}
          </div>
          <div className="flex border border-gray-200 rounded-lg p-1 bg-gray-100 w-full">
            <button onClick={() => { setAppMode('chatter'); clearAll(); }} className={`flex-1 py-2 text-sm rounded-md transition-all ${appMode === 'chatter' ? 'bg-white shadow text-indigo-600 font-semibold' : 'text-gray-600'}`}>The Chatter (Concall Links)</button>
            <button onClick={() => { setAppMode('points'); clearAll(); }} className={`flex-1 py-2 text-sm rounded-md transition-all ${appMode === 'points' ? 'bg-white shadow text-indigo-600 font-semibold' : 'text-gray-600'}`}>Points & Figures (Presentations)</button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {appMode === 'chatter' ? renderChatterUI() : renderPointsUI()}
        </div>
      </main>
    </div>
  );
};

export default App;
