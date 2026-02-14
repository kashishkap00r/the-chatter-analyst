import React from 'react';

interface LoadingStateProps {
  message: string;
  compact?: boolean;
}

const LoadingState: React.FC<LoadingStateProps> = ({ message, compact = false }) => {
  return (
    <div className={`flex items-center ${compact ? 'gap-3' : 'gap-4'} ${compact ? '' : 'py-6 justify-center'}`}>
      <span className={`relative inline-flex ${compact ? 'w-4 h-4' : 'w-10 h-10'}`}>
        <span className="absolute inset-0 rounded-full border-2 border-brand/30" />
        <span className="absolute inset-0 rounded-full border-2 border-t-brand border-r-transparent border-b-transparent border-l-transparent animate-spin" />
      </span>
      <p className={`${compact ? 'text-sm' : 'text-base'} text-ink font-medium`}>{message}</p>
    </div>
  );
};

export default LoadingState;
