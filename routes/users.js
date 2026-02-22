const express = require('express');
const { getUserByUsername, updateUser, formatUser, getRatings, getRatingHistory, listGamesByUser } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/users/:username — public profile
router.get('/users/:username', optionalAuth, (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Check privacy — profile visible to owner or if public
  const isOwner = req.user && req.user.id === user.id;
  if (!user.profile_public && !isOwner) {
    return res.status(404).json({ error: 'User not found' });
  }

  const ratings = getRatings(user.id);
  res.json({
    user: formatUser(user),
    ratings
  });
});

// GET /api/users/:username/games — user's game history
router.get('/users/:username/games', optionalAuth, (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isOwner = req.user && req.user.id === user.id;
  if (!user.games_public && !isOwner) {
    return res.status(403).json({ error: 'Game history is private' });
  }

  const { limit, offset, category, result, opponent, gameType, playerType, timeControl, eloMin, eloMax } = req.query;
  const data = listGamesByUser(user.id, {
    limit: parseInt(limit) || 15,
    offset: parseInt(offset) || 0,
    category,
    result,
    opponent,
    gameType,
    playerType,
    timeControl,
    eloMin,
    eloMax
  });
  res.json(data);
});

// GET /api/users/:username/ratings — rating breakdown
router.get('/users/:username/ratings', optionalAuth, (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isOwner = req.user && req.user.id === user.id;
  if (!user.profile_public && !isOwner) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(getRatings(user.id));
});

// GET /api/users/:username/rating-history — rating changes over time
router.get('/users/:username/rating-history', optionalAuth, (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isOwner = req.user && req.user.id === user.id;
  if (!user.profile_public && !isOwner) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { category, limit } = req.query;
  if (!category) {
    return res.status(400).json({ error: 'Category query parameter is required' });
  }

  const history = getRatingHistory(user.id, category, parseInt(limit) || 50, 0);
  res.json(history.map(h => ({
    gameId: h.game_id,
    oldRating: h.old_rating,
    newRating: h.new_rating,
    oldRd: h.old_rd,
    newRd: h.new_rd,
    opponentRating: h.opponent_rating,
    result: h.result,
    timestamp: h.timestamp
  })));
});

// PATCH /api/users/me — update own profile
router.patch('/users/me', requireAuth, (req, res) => {
  const { displayName, bio, avatarUrl, profilePublic, gamesPublic } = req.body;
  const fields = {};
  if (displayName !== undefined) fields.display_name = String(displayName).slice(0, 50);
  if (bio !== undefined) fields.bio = String(bio).slice(0, 500);
  if (avatarUrl !== undefined) fields.avatar_url = avatarUrl;
  if (profilePublic !== undefined) fields.profile_public = profilePublic ? 1 : 0;
  if (gamesPublic !== undefined) fields.games_public = gamesPublic ? 1 : 0;

  updateUser(req.user.id, fields);
  const updated = getUserByUsername(req.user.username);
  res.json({ user: formatUser(updated) });
});

module.exports = router;
