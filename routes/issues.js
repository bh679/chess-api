const express = require('express');
const router = express.Router();
const {
  createIssueReport,
  updateIssueReport,
  getIssueReportByGame,
  getIssueReport,
} = require('../db');

// POST /api/chess/issues — create a new issue report (flag a game)
router.post('/issues', (req, res) => {
  try {
    const { gameId, sessionId, roomCode, autoDetected, deviceInfo } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const report = createIssueReport(
      gameId || null,
      sessionId,
      roomCode || null,
      !!autoDetected,
      deviceInfo || {}
    );

    res.status(201).json(report);
  } catch (e) {
    console.error('POST /issues error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/chess/issues/:id — update categories and/or description
router.patch('/issues/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid report ID' });

    const existing = getIssueReport(id);
    if (!existing) return res.status(404).json({ error: 'Report not found' });

    const { categories, description } = req.body;
    const updates = {};

    if (categories !== undefined) {
      if (!Array.isArray(categories)) {
        return res.status(400).json({ error: 'categories must be an array' });
      }
      updates.categories = categories;
    }

    if (description !== undefined) {
      if (typeof description !== 'string') {
        return res.status(400).json({ error: 'description must be a string' });
      }
      updates.description = description;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updateIssueReport(id, updates);
    res.status(200).json({ success: true });
  } catch (e) {
    console.error('PATCH /issues/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chess/issues/game/:id — check if a game has been flagged
router.get('/issues/game/:id', (req, res) => {
  try {
    const gameId = parseInt(req.params.id, 10);
    if (isNaN(gameId)) return res.status(400).json({ error: 'Invalid game ID' });

    const report = getIssueReportByGame(gameId);
    res.json({ report });
  } catch (e) {
    console.error('GET /issues/game/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
