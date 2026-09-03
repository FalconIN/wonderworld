// No server-side HTML-escaping existed anywhere before this — every email
// template interpolates fields raw. This is scoped to the one new
// interpolation point that needs it (admin_notes in the resend-confirmation
// email, see server/routes/admin.js); the existing unescaped fields
// elsewhere are a separate, pre-existing issue, not fixed here.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
