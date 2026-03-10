/**
 * ICE server configuration endpoint.
 *
 * Returns STUN servers always. Returns TURN credentials as well when
 * configured via environment variables.
 *
 * Two TURN credential modes are supported:
 *
 * 1. Static credentials (Open Relay / Metered.ca):
 *    TURN_URL, TURN_USERNAME, TURN_PASSWORD
 *    Use this for openrelay.metered.ca or any service with static creds.
 *
 * 2. HMAC-SHA1 time-limited credentials (self-hosted coturn):
 *    TURN_URL, TURN_SECRET
 *    Generates 24-hour tokens using the coturn REST API format.
 *
 * Static mode takes precedence if both are configured.
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
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnPassword = process.env.TURN_PASSWORD;
  const turnSecret = process.env.TURN_SECRET;

  if (!turnUrl) {
    return res.json(STUN_SERVERS);
  }

  let username, credential;

  if (turnUsername && turnPassword) {
    // Static credentials (Open Relay, Metered.ca, etc.)
    username = turnUsername;
    credential = turnPassword;
  } else if (turnSecret) {
    // HMAC-SHA1 time-limited credentials (coturn REST API format, expire in 24h)
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    username = String(expiry);
    credential = crypto
      .createHmac('sha1', turnSecret)
      .update(username)
      .digest('base64');
  } else {
    return res.json(STUN_SERVERS);
  }

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
