const express = require('express');
const router = express.Router();
const { listRoomsForSession } = require('../rooms');

// GET /api/rooms/active — List active/pending rooms for a session
router.get('/rooms/active', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId query parameter required' });
  }
  const activeRooms = listRoomsForSession(sessionId);
  res.json({ rooms: activeRooms });
});

module.exports = router;
