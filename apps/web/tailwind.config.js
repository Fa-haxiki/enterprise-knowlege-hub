import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
        },
        surface: 'rgb(var(--surface) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        subtle: 'rgb(var(--subtle) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        ink: {
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
        },
      },
      borderRadius: {
        card: '12px',
        bubble: '16px',
      },
      boxShadow: {
        card: '0 1px 3px rgb(0 0 0 / 0.06), 0 4px 12px rgb(0 0 0 / 0.04)',
        pop: '0 4px 16px rgb(0 0 0 / 0.10), 0 12px 32px rgb(0 0 0 / 0.08)',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        blink: 'blink 1s step-end infinite',
        // 不用 both：fill-forwards 会保留 translateY(0)，使后代 fixed 定位失效
        fadeUp: 'fadeUp 0.25s ease-out',
      },
    },
  },
  plugins: [typography],
};
