/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        gbf: {
          dark: '#0a0e1a',
          card: '#121829',
          border: '#242f4c',
          gold: '#f5c842',
          goldHover: '#ffd866',
          cyan: '#38bdf8',
          accent: '#e11d48'
        }
      },
      fontFamily: {
        display: ['"Outfit"', 'sans-serif'],
        sans: ['"Noto Sans JP"', 'sans-serif']
      }
    }
  },
  safelist: [
    'bg-red-500/20',
    'text-red-300',
    'bg-blue-500/20',
    'text-blue-300',
    'bg-emerald-500/20',
    'text-emerald-300',
    'border-emerald-500/30',
    'bg-purple-500/20',
    'text-purple-300',
    'border-purple-500/30',
    'text-purple-400',
    'hover:text-purple-300',
    'text-rose-400',
    'bg-rose-500/10',
    'text-rose-300',
    'border-rose-500/30',
    'bg-emerald-500/10',
    'bg-amber-500/10',
    'text-amber-300',
    'border-amber-500/30',
    'bg-violet-500/20',
    'hover:bg-violet-500/30',
    'text-violet-300',
    'border-violet-500/40',
    'opacity-50',
    'cursor-not-allowed'
  ],
  plugins: [],
}
