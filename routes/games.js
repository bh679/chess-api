const express = require('express');
const router = express.Router();
const db = require('../db');
const { optionalAuth } = require('../middleware/auth');

// POST /api/games — Create a new game
router.post('/games', optionalAuth, (req, res) => {
  try {
    const { gameType, timeControl, startingFen, white, black } = req.body;
    if (!startingFen || !white || !black) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // If logged in, set player name and link user to non-AI sides
    if (req.user) {
      const displayName = req.user.display_name || req.user.username;
      if (!white.isAI) white.name = displayName;
      if (!black.isAI) black.name = displayName;
    }
    const userId = req.user ? req.user.id : null;
    const id = db.createGame({ gameType, timeControl, startingFen, white, black }, userId);
    res.status(201).json({ id: Number(id) });
  } catch (e) {
    console.error('POST /games error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/games/:id/moves — Add a move (idempotent)
router.post('/games/:id/moves', (req, res) => {
  try {
    const gameId = parseInt(req.params.id, 10);
    if (isNaN(gameId)) return res.status(400).json({ error: 'Invalid game ID' });

    const { ply, san, fen, timestamp, side } = req.body;
    if (san === undefined || fen === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const inserted = db.addMove(gameId, { ply, san, fen, timestamp, side });
    res.status(inserted ? 204 : 409).end();
  } catch (e) {
    console.error('POST /games/:id/moves error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/games/:id/end — End a game
router.patch('/games/:id/end', (req, res) => {
  try {
    const gameId = parseInt(req.params.id, 10);
    if (isNaN(gameId)) return res.status(400).json({ error: 'Invalid game ID' });

    const { result, resultReason } = req.body;
    db.endGame(gameId, result, resultReason);
    res.status(204).end();
  } catch (e) {
    console.error('PATCH /games/:id/end error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/games/:id/player — Update player name
router.patch('/games/:id/player', (req, res) => {
  try {
    const gameId = parseInt(req.params.id, 10);
    if (isNaN(gameId)) return res.status(400).json({ error: 'Invalid game ID' });

    const { side, name } = req.body;
    if (!side || !name) return res.status(400).json({ error: 'Missing side or name' });
    if (side !== 'white' && side !== 'black') {
      return res.status(400).json({ error: 'Side must be "white" or "black"' });
    }
    db.updatePlayerName(gameId, side, name);
    res.status(204).end();
  } catch (e) {
    console.error('PATCH /games/:id/player error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/games/:id — Get full game with moves
router.get('/games/:id', (req, res) => {
  try {
    const gameId = parseInt(req.params.id, 10);
    if (isNaN(gameId)) return res.status(400).json({ error: 'Invalid game ID' });

    const game = db.getGame(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    res.json(game);
  } catch (e) {
    console.error('GET /games/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/games/list — List games for given IDs
router.post('/games/list', (req, res) => {
  try {
    const { ids, limit = 15, offset = 0 } = req.body;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'ids must be an array' });
    }
    // Sanitize: only allow positive integers
    const cleanIds = ids.filter(id => Number.isInteger(id) && id > 0);
    const result = db.listGames(cleanIds, limit, offset);
    res.json(result);
  } catch (e) {
    console.error('POST /games/list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/games/list-all — List all games (public)
router.post('/games/list-all', (req, res) => {
  try {
    const { limit = 15, offset = 0 } = req.body || {};
    const result = db.listAllGames(limit, offset);
    res.json(result);
  } catch (e) {
    console.error('POST /games/list-all error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/games/:id — Delete a game
router.delete('/games/:id', (req, res) => {
  try {
    const gameId = parseInt(req.params.id, 10);
    if (isNaN(gameId)) return res.status(400).json({ error: 'Invalid game ID' });

    db.deleteGame(gameId);
    res.status(204).end();
  } catch (e) {
    console.error('DELETE /games/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
