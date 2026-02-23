const express = require('express');
const { listGamesByUser, claimGame, getGame, updatePlayerName } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/my-games — authenticated user's game history
router.get('/my-games', requireAuth, (req, res) => {
  const { limit, offset, category, result, opponent } = req.query;
  const data = listGamesByUser(req.user.id, {
    limit: parseInt(limit) || 15,
    offset: parseInt(offset) || 0,
    category,
    result,
    opponent
  });
  res.json(data);
});

// POST /api/games/:id/claim — link an anonymous game to user account
router.post('/games/:id/claim', requireAuth, (req, res) => {
  const gameId = parseInt(req.params.id);
  const { side } = req.body;
  if (!side || (side !== 'white' && side !== 'black')) {
    return res.status(400).json({ error: 'Side must be white or black' });
  }

  const success = claimGame(gameId, side, req.user.id);
  if (!success) {
    return res.status(409).json({ error: 'Game not found or already claimed' });
  }
  res.json({ ok: true });
});

// POST /api/games/claim-batch — bulk claim anonymous games on first login
router.post('/games/claim-batch', requireAuth, (req, res) => {
  const { gameIds } = req.body;
  if (!Array.isArray(gameIds)) {
    return res.status(400).json({ error: 'gameIds array is required' });
  }

  let claimed = 0;
  const userName = req.user.display_name || req.user.username;
  for (const gameId of gameIds) {
    const game = getGame(gameId);
    if (!game) continue;

    // Claim any unclaimed non-AI side and update player name
    if (!game.white.isAI && !game.white.userId) {
      updatePlayerName(gameId, 'white', userName);
      if (claimGame(gameId, 'white', req.user.id)) claimed++;
    }
    if (!game.black.isAI && !game.black.userId) {
      updatePlayerName(gameId, 'black', userName);
      if (claimGame(gameId, 'black', req.user.id)) claimed++;
    }
  }

  res.json({ claimed, total: gameIds.length });
});

module.exports = router;
