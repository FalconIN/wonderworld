/** Admin dashboard only — kept separate because admin.html uses its own
 * theme values (different indigo shade, Inter body font, dark mode) that
 * must not bleed into the public-site build. */
module.exports = {
  darkMode: 'class',
  content: [
    './admin.html',
    './admin.js',
  ],
  theme: {
    extend: {
      fontFamily: { display: ['Fredoka', 'sans-serif'], body: ['Inter', 'sans-serif'] },
      colors: {
        teal:   { DEFAULT: '#0E9F6E', light: '#D1FAE5' },
        indigo: { DEFAULT: '#4F46E5', light: '#EEF2FF' },
        amber:  { DEFAULT: '#F59E0B', light: '#FEF3C7' },
      },
    },
  },
};
