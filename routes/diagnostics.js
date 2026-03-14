const express = require('express');
const router = express.Router();
const { validateRoomCode } = require('../validation');
const {
  insertDiagnosticEvents,
  getDiagnosticsByGame,
  getDiagnosticsByRoom,
  getDiagnosticsBySession,
  getDiagnosticsRecent,
  getDiagnosticsRecentGames,
  getDiagnosticsLobbyOnlyRooms,
  getGameSessionStates,
  getGame,
  getIssueReportsByGame,
  getIssueReportsByRoomCode,
} = require('../db');
const { renderDiagnosticsHTML } = require('./diagnostics-html');

const MAX_BATCH_SIZE = 100;

// POST /api/chess/diagnostics — receive a batch of diagnostic events
router.post('/diagnostics', (req, res) => {
  try {
    const { sessionId, gameId, roomCode, deviceInfo, events } = req.body;

    if (!sessionId || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'sessionId and non-empty events array required' });
    }
    if (roomCode) {
      const rcCheck = validateRoomCode(roomCode);
      if (!rcCheck.valid) return res.status(400).json({ error: rcCheck.error });
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

// GET /api/chess/diagnostics — HTML dashboard (most recent game, ?gameId=N, or ?roomCode=X)
router.get('/diagnostics', (req, res) => {
  try {
    const { category, limit = 500, offset = 0, gameId: gameIdParam, roomCode: roomCodeParam } = req.query;
    const queryOpts = {
      category: category || null,
      limit: Math.min(parseInt(limit, 10) || 500, 1000),
      offset: parseInt(offset, 10) || 0,
    };

    let result;
    if (gameIdParam) {
      const gameId = parseInt(gameIdParam, 10);
      if (isNaN(gameId)) return res.status(400).send('<p>Invalid game ID.</p>');
      const events = getDiagnosticsByGame(gameId, queryOpts);
      result = { gameId, events, count: events.length };
    } else if (roomCodeParam) {
      const roomCode = roomCodeParam.toUpperCase();
      const events = getDiagnosticsByRoom(roomCode, queryOpts);
      result = { roomCode, gameId: null, events, count: events.length };
    } else {
      result = getDiagnosticsRecent(queryOpts);
      if (result.gameId === null) return res.status(404).send('<p>No game diagnostics found.</p>');
    }

    const recentGames = getDiagnosticsRecentGames();
    const recentGamesWithStates = recentGames.map(g =>
      g.result === null
        ? { ...g, sessionStates: getGameSessionStates(g.gameId) }
        : g
    );
    const lobbyRooms = getDiagnosticsLobbyOnlyRooms();
    const allNavEntries = [...recentGamesWithStates, ...lobbyRooms]
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));

    const game = result.gameId ? getGame(result.gameId) : null;
    const issueReports = result.gameId
      ? getIssueReportsByGame(result.gameId)
      : (result.roomCode ? getIssueReportsByRoomCode(result.roomCode) : []);
    const contextLabel = result.gameId ? `Game ${result.gameId}` : (result.roomCode ? `Room ${result.roomCode}` : 'Unknown');
    return res.send(renderDiagnosticsHTML(result, contextLabel, allNavEntries, game, issueReports));
  } catch (e) {
    console.error('GET /diagnostics error:', e.message);
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
    const issueReports = getIssueReportsByGame(gameId);
    const result = { gameId, events, count: events.length, issueReports };

    res.json(result);
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
    const result = { roomCode, events, count: events.length };

    res.json(result);
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
    const result = { sessionId, events, count: events.length };

    res.json(result);
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

    const issueReports = result.gameId ? getIssueReportsByGame(result.gameId) : [];
    res.json({ ...result, issueReports });
  } catch (e) {
    console.error('GET /diagnostics/recent error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
