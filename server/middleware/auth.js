const admin = require('firebase-admin');

// Initialize Firebase Admin once (idempotent)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  const pool = require('../db');
  await requireAuth(req, res, async () => {
    try {
      const { rows } = await pool.query(
        'SELECT is_admin FROM users WHERE id = $1',
        [req.user.uid]
      );
      if (!rows[0]?.is_admin) return res.status(403).json({ error: 'Admin access required' });
      next();
    } catch {
      res.status(500).json({ error: 'Auth check failed' });
    }
  });
}

module.exports = { requireAuth, requireAdmin };
