// scripts/inject-env.js
// Injects public env vars into HTML files at startup.
// Run via: node scripts/inject-env.js
// Called by ecosystem.config.js pre-start, or manually.

const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ENV_BLOCK = `
<script>
  window.__ENV__ = {
    FIREBASE_API_KEY:             ${JSON.stringify(process.env.FIREBASE_API_KEY            || '')},
    FIREBASE_AUTH_DOMAIN:         ${JSON.stringify(process.env.FIREBASE_AUTH_DOMAIN        || '')},
    FIREBASE_PROJECT_ID:          ${JSON.stringify(process.env.FIREBASE_PROJECT_ID         || '')},
    FIREBASE_STORAGE_BUCKET:      ${JSON.stringify(process.env.FIREBASE_STORAGE_BUCKET     || '')},
    FIREBASE_MESSAGING_SENDER_ID: ${JSON.stringify(process.env.FIREBASE_MESSAGING_SENDER_ID|| '')},
    FIREBASE_APP_ID:              ${JSON.stringify(process.env.FIREBASE_APP_ID             || '')},
    STRIPE_PK:                    ${JSON.stringify(process.env.STRIPE_PUBLIC_KEY           || '')},
    ENVIRONMENT:                  ${JSON.stringify(process.env.ENVIRONMENT                 || 'production')}
  };
</script>`;

const htmlFiles = ['index.html', 'admin.html', 'login.html', 'prices.html'];

for (const file of htmlFiles) {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) continue;

  let html = fs.readFileSync(filePath, 'utf8');

  // Remove any previously injected __ENV__ block
  html = html.replace(/<script>\s*window\.__ENV__[\s\S]*?<\/script>\n?/g, '');

  // Inject before </head>
  html = html.replace('</head>', `${ENV_BLOCK}\n</head>`);

  fs.writeFileSync(filePath, html);
  console.log(`✅ Injected env into ${file}`);
}

console.log('Env injection complete.');
