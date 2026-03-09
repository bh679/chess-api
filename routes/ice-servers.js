/**
 * ICE server configuration endpoint.
 *
 * Returns STUN servers always. Returns TURN credentials as well if
 * TURN_SECRET and TURN_URL are configured as environment variables.
 *
 * TURN credentials use the coturn REST API format (HMAC-SHA1 with a
 * shared secret), giving 24-hour time-limited tokens.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// GET /api/chess/ice-servers — returns ICE server config for WebRTC
router.get('/ice-servers', (req, res) => {
  const turnSecret = process.env.TURN_SECRET;
  const turnUrl = process.env.TURN_URL;

  if (!turnSecret || !turnUrl) {
    return res.json(STUN_SERVERS);
  }

  // Generate time-limited TURN credentials (expire in 24h)
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const username = String(expiry);
  const credential = crypto
    .createHmac('sha1', turnSecret)
    .update(username)
    .digest('base64');

  const servers = [
    ...STUN_SERVERS,
    {
      urls: [`turn:${turnUrl}`, `turns:${turnUrl}`],
      username,
      credential,
    },
  ];

  res.json(servers);
});

module.exports = router;
