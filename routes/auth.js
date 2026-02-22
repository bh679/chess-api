const express = require('express');
const { upsertUser, formatUser, getRatings } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const WP_URL = process.env.WP_URL || 'https://brennan.games/wp';

// POST /api/auth/login — proxy credentials to WordPress JWT endpoint
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const wpRes = await fetch(`${WP_URL}/wp-json/jwt-auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!wpRes.ok) {
      const err = await wpRes.json().catch(() => ({}));
      return res.status(401).json({ error: err.message || 'Invalid credentials' });
    }

    const wpData = await wpRes.json();
    const token = wpData.token;
    const wpUserId = wpData.user_id || wpData.data?.user?.id;
    const displayName = wpData.user_display_name || wpData.user_nicename || username;
    const avatarUrl = wpData.user_avatar || null;

    // Upsert user in local database
    const user = upsertUser(wpUserId, username, displayName, avatarUrl);

    res.json({
      token,
      user: formatUser(user)
    });
  } catch (e) {
    console.error('WordPress auth error:', e.message);
    res.status(502).json({ error: 'Authentication service unavailable' });
  }
});

// POST /api/auth/validate — verify token is still valid
router.post('/validate', requireAuth, (req, res) => {
  res.json({ valid: true, user: formatUser(req.user) });
});

// POST /api/auth/logout — server-side no-op (client clears token)
router.post('/logout', (req, res) => {
  res.json({ ok: true });
});

// GET /api/auth/me — full user profile with ratings
router.get('/me', requireAuth, (req, res) => {
  const ratings = getRatings(req.user.id);
  res.json({
    user: formatUser(req.user),
    ratings
  });
});

module.exports = router;
