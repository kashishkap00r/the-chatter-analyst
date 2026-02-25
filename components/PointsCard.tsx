import React from 'react';
import { SelectedSlide } from '../types';

interface PointsCardProps {
  slide: SelectedSlide;
  index: number;
}

const PointsCard: React.FC<PointsCardProps> = ({ slide, index }) => {
  return (
    <article className="rounded-2xl border border-line bg-white shadow-panel studio-panel overflow-hidden">
      <header className="px-5 sm:px-6 py-4 border-b border-line bg-brand-soft/45">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-serif text-xl text-ink">Insight {index}</h3>
          <p className="text-xs uppercase tracking-[0.12em] text-stone">Slide {slide.selectedPageNumber}</p>
        </div>
      </header>

      <figure className="p-4 sm:p-6 border-b border-line bg-canvas/72">
        <img
          src={slide.pageAsImage}
          alt={`Slide ${slide.selectedPageNumber}`}
          className="w-full h-auto rounded-xl border border-line shadow-float"
        />
      </figure>

      <div className="p-5 sm:p-6">
        <section className="rounded-xl border border-brand/20 bg-brand-soft/60 px-4 py-3.5">
          <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-brand mb-2">Context</h4>
          <p className="text-sm leading-relaxed text-ink ml-4 border-l-2 border-brand/40 pl-4">{slide.context}</p>
        </section>
      </div>
    </article>
  );
};

export default PointsCard;
