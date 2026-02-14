import React, { useState } from 'react';
import { ExtractedQuote } from '../types';

interface QuoteCardProps {
  quoteData: ExtractedQuote;
  index: number;
}

const getCategoryStyle = (cat: string) => {
  if (cat.includes('Financial') || cat.includes('Capital')) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (cat.includes('Cost') || cat.includes('Supply')) return 'bg-amber-50 text-amber-700 border-amber-200';
  if (cat.includes('Tech') || cat.includes('Disruption')) return 'bg-sky-50 text-sky-700 border-sky-200';
  if (cat.includes('Regulation') || cat.includes('Legal')) return 'bg-rose-50 text-rose-700 border-rose-200';
  if (cat.includes('Macro') || cat.includes('Climate')) return 'bg-indigo-50 text-indigo-700 border-indigo-200';
  return 'bg-stone-100 text-stone-700 border-stone-200';
};

const QuoteCard: React.FC<QuoteCardProps> = ({ quoteData, index }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = `${quoteData.summary}\n\n"${quoteData.quote}"\n— ${quoteData.speaker.name}, ${quoteData.speaker.designation}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <article className="rounded-2xl border border-line bg-white shadow-panel p-5 sm:p-6">
      <header className="flex items-start justify-between gap-4 mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-canvas border border-line px-2.5 py-1 text-xs font-semibold text-stone">
            Quote {index + 1}
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] ${getCategoryStyle(
              quoteData.category,
            )}`}
          >
            {quoteData.category}
          </span>
        </div>

        <button
          onClick={handleCopy}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
            copied ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-line text-stone hover:text-ink hover:bg-canvas'
          }`}
          title="Copy formatting for newsletter"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>

      <section className="rounded-xl border border-brand/20 bg-brand-soft/40 p-4 mb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand mb-1.5">Context</p>
        <p className="text-sm leading-relaxed text-ink/90">{quoteData.summary}</p>
      </section>

      <blockquote className="border-l-4 border-brand pl-4 sm:pl-5">
        <p className="font-serif text-xl leading-relaxed text-ink italic">"{quoteData.quote}"</p>
      </blockquote>

      <footer className="mt-5 pt-4 border-t border-line text-right">
        <p className="text-sm font-semibold text-ink">{quoteData.speaker.name}</p>
        <p className="text-xs text-stone">{quoteData.speaker.designation}</p>
      </footer>
    </article>
  );
};

export default QuoteCard;
