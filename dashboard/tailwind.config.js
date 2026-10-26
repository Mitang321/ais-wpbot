/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm saffron accent (Indian Store Marseille).
        brand: {
          50: '#fff8ed',
          100: '#ffeed4',
          200: '#fed9a8',
          300: '#fdbd71',
          400: '#fb9638',
          500: '#f97a12',
          600: '#e15f08',
          700: '#bb4709',
          800: '#953910',
          900: '#793110',
        },
        // Deep leaf green, the secondary accent.
        leaf: {
          50: '#eefbf3',
          100: '#d6f5e0',
          200: '#b0e9c6',
          300: '#7cd6a5',
          400: '#46bb7f',
          500: '#23a064',
          600: '#15804f',
          700: '#126742',
          800: '#125236',
          900: '#10432e',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      keyframes: {
        flash: {
          '0%': { backgroundColor: '#fff3d6', boxShadow: '0 0 0 3px rgba(249,122,18,.45)' },
          '100%': { backgroundColor: '#ffffff', boxShadow: '0 0 0 0 rgba(249,122,18,0)' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        flash: 'flash 6s ease-out 1',
        'slide-up': 'slide-up .25s ease-out 1',
      },
    },
  },
  plugins: [],
};
