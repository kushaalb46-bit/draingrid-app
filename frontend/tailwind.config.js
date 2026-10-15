/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"SF Pro Display"',
          '"Helvetica Neue"',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
      },
      colors: {
        apple: {
          bg: '#f5f5f7',
          blue: '#0071e3',
          'blue-hover': '#0077ed',
          ink: '#1d1d1f',
          muted: '#6e6e73',
        },
      },
      boxShadow: {
        glass:
          '0 1px 0 0 rgba(255,255,255,0.7) inset, 0 12px 40px -14px rgba(0,0,0,0.14), 0 2px 8px -2px rgba(0,0,0,0.04)',
        lift: '0 24px 60px -24px rgba(0,0,0,0.28)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(14px) scale(0.99)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pop: {
          '0%': { opacity: '0', transform: 'scale(0.6)' },
          '60%': { opacity: '1', transform: 'scale(1.1)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        float: {
          '0%, 100%': { transform: 'translate3d(0, 0, 0) scale(1)' },
          '50%': { transform: 'translate3d(40px, -30px, 0) scale(1.08)' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(300%)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(20px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.7s cubic-bezier(0.32, 0.72, 0, 1) both',
        'fade-in': 'fade-in 0.4s ease-out both',
        pop: 'pop 0.5s cubic-bezier(0.32, 0.72, 0, 1) both',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        float: 'float 18s ease-in-out infinite',
        'float-slow': 'float 26s ease-in-out infinite reverse',
        scan: 'scan 1.6s ease-in-out infinite',
        'toast-in': 'toast-in 0.5s cubic-bezier(0.32, 0.72, 0, 1) both',
      },
    },
  },
  plugins: [],
}
