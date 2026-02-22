const express = require('express');
const { getSettings, updateSettings } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/settings — get saved settings
router.get('/settings', requireAuth, (req, res) => {
  const settings = getSettings(req.user.id);
  res.json({ settings });
});

// PUT /api/settings — save/merge settings
router.put('/settings', requireAuth, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Settings object is required' });
  }
  updateSettings(req.user.id, settings);
  res.json({ ok: true });
});

module.exports = router;
