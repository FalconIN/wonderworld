/** Public site pages (everything except admin.html). */
module.exports = {
  content: [
    './index.html',
    './faq.html',
    './hours.html',
    './prices.html',
    './contact.html',
    './rules.html',
    './gallery.html',
    './menu.html',
    './privacy.html',
    './rooms.html',
    './login.html',
    './reset-password.html',
    './app.js',
    './auth.js',
    './booking.js',
    './payment.js',
    './gallery.js',
  ],
  theme: {
    extend: {
      colors: {
        teal:     { DEFAULT: '#0E9F6E', light: '#D1FAE5', dark: '#065F46' },
        indigo:   { DEFAULT: '#1E3A8A', light: '#EFF6FF', dark: '#1e3a8a' },
        blue:     { DEFAULT: '#3B82F6', light: '#DBEAFE' },
        // Darkened from the original #F97316 — white text on the stock orange
        // failed WCAG AA contrast on the CTA banner; #C2410C (Tailwind orange-700)
        // passes (~5.2:1) while keeping the same orange identity.
        cta:      { DEFAULT: '#C2410C', dark: '#EA6000' },
        amber:    { DEFAULT: '#F59E0B', light: '#FEF3C7', dark: '#B45309' },
        offwhite: '#EFF6FF',
      },
      fontFamily: {
        display: ['Fredoka', 'sans-serif'],
        body:    ['Nunito', 'sans-serif'],
      },
      borderRadius: { '2xl': '1rem', '3xl': '1.5rem', '4xl': '2rem' },
      boxShadow: {
        soft:  '0 6px 20px rgba(30,58,138,0.08)',
        card:  '0 12px 36px rgba(30,58,138,0.14)',
        clay:  '0 8px 24px rgba(30,58,138,0.10), inset 0 1px 0 rgba(255,255,255,0.9)',
        glow:  '0 0 0 4px rgba(59,130,246,0.2)',
      },
    },
  },
};
