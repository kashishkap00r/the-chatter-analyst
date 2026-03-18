/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{js,ts,jsx,tsx}',
    './services/**/*.{js,ts,jsx,tsx}',
    './src/**/*.{js,ts,jsx,tsx}',
    './utils/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: '#FFFFFF',
        ink: '#222222',
        brand: '#387ED1',
        'brand-soft': '#F5F7FB',
        line: '#E7E7E7',
        stone: '#666666',
        accent: '#FFA412',
      },
      boxShadow: {
        panel: '0 1px 3px rgba(213, 213, 213, 0.4)',
        float: '0 4px 16px rgba(213, 213, 213, 0.4)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        'z-sm': '8px',
        'z-md': '16px',
        'z-lg': '32px',
      },
      keyframes: {
        riseIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'rise-in': 'riseIn 380ms ease-out both',
      },
    },
  },
  plugins: [],
};
