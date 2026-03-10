const express = require('express');
const router = express.Router();
const {
  insertDiagnosticEvents,
  getDiagnosticsByGame,
  getDiagnosticsByRoom,
  getDiagnosticsBySession,
  getDiagnosticsRecent,
} = require('../db');

const MAX_BATCH_SIZE = 100;

// POST /api/chess/diagnostics — receive a batch of diagnostic events
router.post('/diagnostics', (req, res) => {
  try {
    const { sessionId, gameId, roomCode, deviceInfo, events } = req.body;

    if (!sessionId || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'sessionId and non-empty events array required' });
    }

    const batch = events.slice(0, MAX_BATCH_SIZE);
    const deviceInfoJson = JSON.stringify(deviceInfo || {});

    insertDiagnosticEvents(batch.map(event => ({
      gameId: gameId || null,
      roomCode: roomCode || null,
      sessionId,
      timestamp: event.timestamp || Date.now(),
      category: event.category || 'unknown',
      eventType: event.eventType || 'unknown',
      data: JSON.stringify(event.data || {}),
      deviceInfo: deviceInfoJson,
    })));

    res.status(204).end();
  } catch (e) {
    console.error('POST /diagnostics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chess/diagnostics/game/:id — query diagnostics for a game
router.get('/diagnostics/game/:id', (req, res) => {
  try {
    const gameId = parseInt(req.params.id, 10);
    if (isNaN(gameId)) return res.status(400).json({ error: 'Invalid game ID' });

    const { category, limit = 500, offset = 0 } = req.query;
    const events = getDiagnosticsByGame(gameId, {
      category: category || null,
      limit: Math.min(parseInt(limit, 10) || 500, 1000),
      offset: parseInt(offset, 10) || 0,
    });

    res.json({ gameId, events, count: events.length });
  } catch (e) {
    console.error('GET /diagnostics/game/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chess/diagnostics/room/:code — query diagnostics for a room
router.get('/diagnostics/room/:code', (req, res) => {
  try {
    const roomCode = req.params.code.toUpperCase();
    const { category, limit = 500, offset = 0 } = req.query;
    const events = getDiagnosticsByRoom(roomCode, {
      category: category || null,
      limit: Math.min(parseInt(limit, 10) || 500, 1000),
      offset: parseInt(offset, 10) || 0,
    });

    res.json({ roomCode, events, count: events.length });
  } catch (e) {
    console.error('GET /diagnostics/room/:code error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chess/diagnostics/session/:id — query diagnostics for a session
router.get('/diagnostics/session/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { category, limit = 500, offset = 0 } = req.query;
    const events = getDiagnosticsBySession(sessionId, {
      category: category || null,
      limit: Math.min(parseInt(limit, 10) || 500, 1000),
      offset: parseInt(offset, 10) || 0,
    });

    res.json({ sessionId, events, count: events.length });
  } catch (e) {
    console.error('GET /diagnostics/session/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chess/diagnostics/recent — diagnostics for the most recent game
router.get('/diagnostics/recent', (req, res) => {
  try {
    const { category, limit = 500, offset = 0 } = req.query;
    const result = getDiagnosticsRecent({
      category: category || null,
      limit: Math.min(parseInt(limit, 10) || 500, 1000),
      offset: parseInt(offset, 10) || 0,
    });
    if (result.gameId === null) return res.status(404).json({ error: 'No game diagnostics found' });
    res.json(result);
  } catch (e) {
    console.error('GET /diagnostics/recent error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
