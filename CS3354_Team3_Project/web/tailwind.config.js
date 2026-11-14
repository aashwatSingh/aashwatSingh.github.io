/*
 * @author Tyler Gaines (themes & accessibility)
 * @description Tailwind design tokens. Every semantic color reads a CSS variable so light / dark theme and
 *   the color-blindness palettes (SE-FR-14, SE-FR-15) can swap the whole app's colors at once.
 * @traces SE-FR-14, SE-FR-15
 */
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: v('canvas'),
        surface: v('surface'),
        'surface-2': v('surface-2'),
        line: v('line'),
        ink: v('ink'),
        muted: v('muted'),
        brand: v('brand'),
        'brand-ink': v('brand-ink'),
        ok: v('ok'),
        warn: v('warn'),
        danger: v('danger'),
        info: v('info'),
        accent: v('accent'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(15 23 42 / 0.06), 0 1px 3px rgb(15 23 42 / 0.08)',
        pop: '0 12px 32px rgb(15 23 42 / 0.18)',
      },
      keyframes: {
        shake: { '0%,100%': { transform: 'translateX(0)' }, '25%': { transform: 'translateX(-6px)' }, '75%': { transform: 'translateX(6px)' } },
      },
      animation: { shake: 'shake 0.3s ease-in-out 2' },
    },
  },
  plugins: [],
};
