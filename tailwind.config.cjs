/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{js,ts,jsx,tsx}',
    './services/**/*.{js,ts,jsx,tsx}',
    './utils/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: '#eef4fb',
        ink: '#132238',
        brand: '#387ed1',
        'brand-soft': '#eaf2ff',
        line: '#d3deec',
        stone: '#5c6f88',
        accent: '#ffa412',
      },
      boxShadow: {
        panel: '0 28px 64px -44px rgba(8, 23, 45, 0.62), 0 12px 24px -18px rgba(24, 38, 63, 0.28)',
        float: '0 18px 44px -26px rgba(31, 65, 112, 0.35)',
      },
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        serif: ['Fraunces', 'ui-serif', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
      },
      keyframes: {
        riseIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        glowSweep: {
          '0%': { transform: 'translateX(-36%)' },
          '100%': { transform: 'translateX(132%)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.62' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'rise-in': 'riseIn 420ms ease-out both',
        'glow-sweep': 'glowSweep 2.8s ease-in-out infinite',
        'pulse-soft': 'pulseSoft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
