import React, { useState, useCallback, useRef } from 'react';
import { analyzeTranscript, parsePdfToText, analyzePresentation, convertPdfToImages } from './services/geminiService';
import { ModelType, type AppMode, type ChatterAnalysisState, type BatchFile, type PointsAnalysisState } from './types';
import QuoteCard from './components/QuoteCard';
import LoadingState from './components/LoadingState';
import PointsCard from './components/PointsCard';

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('chatter');
  const [inputMode, setInputMode] = useState<'text' | 'file'>('file');
  const [textInput, setTextInput] = useState('');
  const [model, setModel] = useState<ModelType>(ModelType.FLASH);
  
  // State for "The Chatter"
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isAnalyzingBatch, setIsAnalyzingBatch] = useState(false);
  const [chatterSingleState, setChatterSingleState] = useState<ChatterAnalysisState>({ status: 'idle' });

  // State for "Points & Figures"
  const [pointsFile, setPointsFile] = useState<File | null>(null);
  const [pointsState, setPointsState] = useState<PointsAnalysisState>({ status: 'idle' });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- "The Chatter" Handlers ---
  const handleAnalyzeText = useCallback(async () => {
    if (!textInput.trim()) return;
    setChatterSingleState({ status: 'analyzing' });
    try {
      const result = await analyzeTranscript(textInput, model);
      setChatterSingleState({ status: 'complete', result });
    } catch (e: any) {
      setChatterSingleState({ status: 'error', errorMessage: e.message });
    }
  }, [textInput, model]);

  const handleAnalyzeBatch = useCallback(async () => {
    const pendingFiles = batchFiles.filter(f => f.status === 'ready');
    if (pendingFiles.length === 0) return;
    setIsAnalyzingBatch(true);
    const newFilesState = [...batchFiles];
    for (let i = 0; i < newFilesState.length; i++) {
        if (newFilesState[i].status !== 'ready') continue;
        newFilesState[i] = { ...newFilesState[i], status: 'analyzing', error: undefined };
        setBatchFiles([...newFilesState]);
        try {
            const result = await analyzeTranscript(newFilesState[i].content, model);
            newFilesState[i] = { ...newFilesState[i], status: 'complete', result };
        } catch (error: any) {
            newFilesState[i] = { ...newFilesState[i], status: 'error', error: error.message || "Failed" };
        }
        setBatchFiles([...newFilesState]);
    }
    setIsAnalyzingBatch(false);
  }, [batchFiles, model]);

  const handleChatterFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const promises = Array.from(files).map(async (file: File) => {
        const id = `${file.name}-${Date.now()}`;
        const batchItem: BatchFile = { id, name: file.name, content: '', status: 'parsing' };
        try {
            if (file.name.toLowerCase().endsWith('.pdf')) {
              batchItem.content = await parsePdfToText(file);
            } else {
              batchItem.content = await file.text();
            }
            batchItem.status = 'ready';
        } catch (err: any) {
            batchItem.status = 'error';
            batchItem.error = err.message;
        }
        return batchItem;
    });
    const newFiles = await Promise.all(promises);
    setBatchFiles(prev => [...prev, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  
  // --- "Points & Figures" Handlers ---
  const handlePointsFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
        setPointsFile(file);
        setPointsState({ status: 'idle' }); // Reset state for new file
    } else if (file) {
        setPointsFile(null);
        setPointsState({ status: 'error', errorMessage: 'Only PDF files are supported for presentations.' });
    }
  };

  const handleAnalyzePresentation = useCallback(async () => {
    if (!pointsFile) return;

    const onProgress = (progressMessage: string) => {
        setPointsState(prev => ({ ...prev, progressMessage }));
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


  // --- General Handlers ---
  const removeBatchFile = (id: string) => setBatchFiles(prev => prev.filter(f => f.id !== id));
  
  const clearAll = () => {
      setBatchFiles([]);
      setTextInput('');
      setChatterSingleState({ status: 'idle' });
      setPointsFile(null);
      setPointsState({ status: 'idle' });
      if (fileInputRef.current) fileInputRef.current.value = '';
  };
  
  const renderChatterUI = () => (
    <>
      <div className="lg:col-span-5 flex flex-col lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)] h-auto">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex flex-col h-full min-h-[500px] lg:min-h-0">
          <div className="flex justify-between items-center mb-4 shrink-0">
            <h2 className="text-lg font-semibold text-gray-800">Transcript Input</h2>
            <div className="flex bg-gray-100 rounded-lg p-1">
              <button onClick={() => setInputMode('file')} className={`px-3 py-1 text-sm rounded-md transition-all ${inputMode === 'file' ? 'bg-white shadow-sm text-indigo-600 font-medium' : 'text-gray-500'}`}>Files (Batch)</button>
              <button onClick={() => setInputMode('text')} className={`px-3 py-1 text-sm rounded-md transition-all ${inputMode === 'text' ? 'bg-white shadow-sm text-indigo-600 font-medium' : 'text-gray-500'}`}>Paste Text</button>
            </div>
          </div>
          {inputMode === 'text' ? (
            <textarea className="flex-1 w-full p-4 bg-gray-50 border rounded-lg" placeholder="Paste transcript..." value={textInput} onChange={(e) => setTextInput(e.target.value)}></textarea>
          ) : (
             <div className="flex-1 flex flex-col overflow-hidden">
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center relative hover:bg-gray-100 shrink-0">
                    <p className="text-sm text-gray-500">Select transcripts (PDF/TXT)</p>
                    <input ref={fileInputRef} type="file" accept=".txt,.pdf" multiple onChange={handleChatterFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"/>
                </div>
                <div className="flex-1 overflow-y-auto space-y-2 mt-4 pr-2">
                    {batchFiles.map(file => (
                        <div key={file.id} className={`flex items-center justify-between p-3 rounded-lg border ${file.status === 'error' ? 'bg-red-50' : 'bg-gray-50'}`}>
                            <span className="text-sm truncate">{file.result?.companyName || file.name}</span>
                            <span className="text-xs">{file.status === 'complete' ? `Done (${file.result?.quotes.length})` : file.status}</span>
                            <button onClick={() => removeBatchFile(file.id)}>X</button>
                        </div>
                    ))}
                </div>
            </div>
          )}
          <div className="flex gap-3 mt-auto shrink-0 pt-4">
             <button onClick={clearAll} disabled={isAnalyzingBatch || chatterSingleState.status === 'analyzing'} className="px-4 py-3 rounded-lg border">Clear</button>
            {inputMode === 'text' ? (
                <button onClick={handleAnalyzeText} disabled={!textInput || chatterSingleState.status === 'analyzing'} className="flex-1 bg-gray-900 text-white font-medium py-3 px-4 rounded-lg">{chatterSingleState.status === 'analyzing' ? 'Analyzing...' : 'Extract Insights'}</button>
            ) : (
                <button onClick={handleAnalyzeBatch} disabled={batchFiles.filter(f => f.status === 'ready').length === 0 || isAnalyzingBatch} className="flex-1 bg-gray-900 text-white font-medium py-3 px-4 rounded-lg">{isAnalyzingBatch ? 'Processing...' : `Analyze ${batchFiles.filter(f => f.status === 'ready').length} Files`}</button>
            )}
          </div>
        </div>
      </div>
      <div className="lg:col-span-7 space-y-8">
        {chatterSingleState.status === 'idle' && batchFiles.length === 0 && <div className="text-center p-12 border-2 border-dashed rounded-xl"><h3 className="text-xl font-serif">Ready to Analyze Transcripts</h3></div>}
        {chatterSingleState.status === 'analyzing' && <LoadingState />}
        {chatterSingleState.status === 'error' && <div className="bg-red-100 p-4 rounded-lg">{chatterSingleState.errorMessage}</div>}
        {chatterSingleState.status === 'complete' && chatterSingleState.result && chatterSingleState.result.quotes.map((q, i) => <QuoteCard key={i} quoteData={q} index={i} />)}
        {batchFiles.map(file => file.result && <div key={file.id}> <h2 className="text-2xl font-bold mb-4">{file.result.companyName}</h2> {file.result.quotes.map((q, i) => <QuoteCard key={`${file.id}-${i}`} quoteData={q} index={i} />)} </div>)}
      </div>
    </>
  );

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
                <button onClick={() => { setAppMode('chatter'); clearAll(); }} className={`flex-1 py-2 text-sm rounded-md transition-all ${appMode === 'chatter' ? 'bg-white shadow text-indigo-600 font-semibold' : 'text-gray-600'}`}>The Chatter (Transcripts)</button>
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
