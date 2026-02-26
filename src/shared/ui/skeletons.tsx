import React from 'react';

export const QuoteSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6 animate-pulse">
    <div className="h-4 w-28 bg-line rounded mb-4" />
    <div className="h-20 bg-canvas rounded-xl mb-4" />
    <div className="h-5 w-11/12 bg-line rounded mb-2" />
    <div className="h-5 w-10/12 bg-line rounded mb-6" />
    <div className="h-4 w-40 bg-line rounded ml-auto" />
  </div>
);

export const SlideSkeleton: React.FC = () => (
  <div className="rounded-2xl border border-line bg-white shadow-panel studio-panel p-5 sm:p-6 animate-pulse">
    <div className="h-6 w-48 bg-line rounded mb-4" />
    <div className="h-52 bg-canvas rounded-xl mb-4" />
    <div className="h-4 w-full bg-line rounded mb-2" />
    <div className="h-4 w-5/6 bg-line rounded" />
  </div>
);
