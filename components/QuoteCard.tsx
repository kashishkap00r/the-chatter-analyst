import React, { useState } from 'react';
import { ExtractedQuote } from '../types';

interface QuoteCardProps {
  quoteData: ExtractedQuote;
  index: number;
}

const QuoteCard: React.FC<QuoteCardProps> = ({ quoteData, index }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // UPDATED FORMAT: Summary first, then quote, with no "Summary:" label.
    const text = `${quoteData.summary}\n\n"${quoteData.quote}"\n— ${quoteData.speaker.name}, ${quoteData.speaker.designation}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getCategoryStyle = (cat: string) => {
    // Using a mapping for the new categories
    if (cat.includes('Financial') || cat.includes('Capital')) return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    if (cat.includes('Cost') || cat.includes('Supply')) return 'bg-orange-100 text-orange-800 border-orange-200';
    if (cat.includes('Tech') || cat.includes('Disruption')) return 'bg-indigo-100 text-indigo-800 border-indigo-200';
    if (cat.includes('Regulation') || cat.includes('Legal')) return 'bg-red-100 text-red-800 border-red-200';
    if (cat.includes('Macro') || cat.includes('Climate')) return 'bg-blue-100 text-blue-800 border-blue-200';
    return 'bg-gray-100 text-gray-800 border-gray-200';
  };

  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-all duration-300 mb-6 group">
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-2">
            <span className="text-gray-400 font-mono text-xs font-bold">#{index + 1}</span>
            <span className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider border ${getCategoryStyle(quoteData.category)}`}>
            {quoteData.category}
            </span>
        </div>
        
        <button 
          onClick={handleCopy}
          className="text-gray-400 hover:text-indigo-600 transition-colors text-sm font-medium flex items-center gap-1"
          title="Copy formatting for newsletter"
        >
          {copied ? (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
              Copied
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
              Copy
            </>
          )}
        </button>
      </div>

      {/* REORDERED: Summary now appears before the quote */}
      <div className="bg-gray-50 rounded-lg p-4 border border-gray-100 mb-6">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Summary of Implication</p>
        <p className="text-sm text-gray-600 leading-relaxed">
          {quoteData.summary}
        </p>
      </div>

      <div className="relative">
         {/* Decorative quote mark */}
         <div className="absolute -top-2 -left-2 text-gray-100 font-serif text-6xl -z-10 select-none">“</div>
         
         <p className="font-serif text-lg md:text-xl text-gray-900 leading-relaxed italic relative z-0">
          {quoteData.quote}
        </p>
      </div>

      <div className="text-right mt-4 pt-4 border-t border-gray-100">
        <p className="text-sm font-bold text-gray-800">
            {quoteData.speaker.name}
        </p>
        <p className="text-xs text-gray-500">
            {quoteData.speaker.designation}
        </p>
      </div>
    </div>
  );
};

export default QuoteCard;