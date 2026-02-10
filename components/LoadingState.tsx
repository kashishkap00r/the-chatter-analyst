import React, { useEffect, useState } from 'react';

const LoadingState: React.FC = () => {
  const [message, setMessage] = useState("Reading transcript...");

  useEffect(() => {
    const messages = [
      "Reading transcript...",
      "Filtering out corporate fluff...",
      "Identifying key strategic shifts...",
      "Extracting verbatim quotes...",
      "Finalizing insights..."
    ];
    let index = 0;

    const interval = setInterval(() => {
      index = (index + 1) % messages.length;
      setMessage(messages[index]);
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center p-12 space-y-6 animate-pulse">
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 border-4 border-gray-200 rounded-full"></div>
        <div className="absolute inset-0 border-4 border-t-indigo-600 border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin"></div>
      </div>
      <h3 className="text-lg font-medium text-gray-700 font-serif">{message}</h3>
    </div>
  );
};

export default LoadingState;