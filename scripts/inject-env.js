// scripts/inject-env.js
// Runs at Vercel build time to inject public env vars into HTML files.
// Secret keys are NEVER injected — only public-safe values.

const fs = require('fs');
const path = require('path');

const ENV_BLOCK = `
<script>
  window.__ENV__ = {
    SUPABASE_URL: ${JSON.stringify(process.env.SUPABASE_URL || '')},
    SUPABASE_ANON: ${JSON.stringify(process.env.SUPABASE_ANON_KEY || '')},
    STRIPE_PK: ${JSON.stringify(process.env.STRIPE_PUBLIC_KEY || '')},
    ENVIRONMENT: ${JSON.stringify(process.env.ENVIRONMENT || 'production')}
  };
</script>`;

const htmlFiles = ['index.html', 'admin.html', 'login.html', 'prices.html'];

for (const file of htmlFiles) {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) continue;

  let html = fs.readFileSync(filePath, 'utf8');

  // Replace placeholder comment or inject before </head>
  if (html.includes('<!-- __ENV_INJECT__ -->')) {
    html = html.replace('<!-- __ENV_INJECT__ -->', ENV_BLOCK);
  } else {
    html = html.replace('</head>', `${ENV_BLOCK}\n</head>`);
  }

  fs.writeFileSync(filePath, html);
  console.log(`✅ Injected env into ${file}`);
}

console.log('Build complete.');
