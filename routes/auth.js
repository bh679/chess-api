const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { upsertUser, formatUser, getRatings, getUserByUsername, createLocalUser, getUserWithPassword, getDb } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const WP_URL = process.env.WP_URL || 'https://brennan.games/wp';
const BCRYPT_ROUNDS = 10;

/** Sign a JWT for a local user. Matches WordPress JWT format so middleware works. */
function signToken(user) {
  return jwt.sign(
    { data: { user: { id: user.wp_user_id } }, sub: user.id },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register — create a local account
router.post('/register', async (req, res) => {
  const { username, password, displayName } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, underscores)' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = getUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = createLocalUser(username, displayName || username, passwordHash);
    const token = signToken(user);

    res.status(201).json({
      token,
      user: formatUser(user)
    });
  } catch (e) {
    console.error('Registration error:', e.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login — try local auth first, fall back to WordPress
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // 1. Try local auth
  const localUser = getUserWithPassword(username);
  if (localUser && localUser.password_hash) {
    try {
      const match = await bcrypt.compare(password, localUser.password_hash);
      if (match) {
        getDb().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), localUser.id);
        const token = signToken(localUser);
        return res.json({
          token,
          user: formatUser(localUser)
        });
      }
    } catch (e) {
      // bcrypt error — fall through to WP
    }
  }

  // 2. Fall back to WordPress auth
  try {
    const wpRes = await fetch(`${WP_URL}/wp-json/jwt-auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!wpRes.ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const wpData = await wpRes.json();
    const token = wpData.token;
    const wpUserId = wpData.user_id || wpData.data?.user?.id;
    const displayName = wpData.user_display_name || wpData.user_nicename || username;
    const avatarUrl = wpData.user_avatar || null;

    const user = upsertUser(wpUserId, username, displayName, avatarUrl);

    res.json({
      token,
      user: formatUser(user)
    });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid username or password' });
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
