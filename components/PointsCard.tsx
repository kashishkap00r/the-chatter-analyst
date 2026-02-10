import React from 'react';
import { SelectedSlide } from '../types';

interface PointsCardProps {
  slide: SelectedSlide;
  index: number;
}

const PointsCard: React.FC<PointsCardProps> = ({ slide, index }) => {
  return (
    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm space-y-6">
      <header className="border-b border-gray-200 pb-4">
        <h3 className="text-xl font-serif font-bold text-gray-900">
          Insight #{index}
        </h3>
        <p className="text-sm text-gray-500">From Slide {slide.selectedPageNumber}</p>
      </header>

      <figure className="border-2 border-gray-200 bg-gray-50 rounded-lg overflow-hidden">
        <img 
          src={slide.pageAsImage} 
          alt={`Slide ${slide.selectedPageNumber}`} 
          className="w-full h-auto"
        />
      </figure>

      <div className="space-y-6">
        <section className="bg-indigo-50 rounded-lg p-4 border border-indigo-100">
          <h4 className="text-sm font-bold text-indigo-800 uppercase tracking-wider mb-2">
            Why This Slide Matters
          </h4>
          <p className="text-base text-indigo-900 leading-relaxed">
            {slide.whyThisSlide}
          </p>
        </section>

        <section>
          <h4 className="text-sm font-bold text-gray-600 uppercase tracking-wider mb-2">
            What This Slide Reveals
          </h4>
          <div 
            className="prose prose-base max-w-none text-gray-700 leading-relaxed" 
            dangerouslySetInnerHTML={{ __html: slide.whatThisSlideReveals.replace(/\n/g, '<br />') }} 
          />
        </section>
      </div>
    </div>
  );
};

export default PointsCard;