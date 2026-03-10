/**
 * ICE server configuration endpoint.
 *
 * Returns STUN servers always. Returns TURN credentials as well when
 * configured via environment variables.
 *
 * Two TURN credential modes are supported:
 *
 * 1. Static credentials (Metered.ca / Open Relay):
 *    TURN_URLS, TURN_USERNAME, TURN_PASSWORD
 *
 *    TURN_URLS is a comma-separated list of complete TURN URLs (including scheme
 *    and any transport params), e.g.:
 *      turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp
 *
 *    All URLs share the same username/credential.
 *
 *    TURN_URL (singular) is a legacy fallback — expands to turn:<URL> and turns:<URL>.
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
  const turnUrls = process.env.TURN_URLS;
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnPassword = process.env.TURN_PASSWORD;
  const turnSecret = process.env.TURN_SECRET;

  const hasTurnConfig = turnUrls || turnUrl;
  if (!hasTurnConfig) {
    return res.json(STUN_SERVERS);
  }

  let username, credential;

  if (turnUsername && turnPassword) {
    // Static credentials (Metered.ca, Open Relay, etc.)
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

  // Build the list of TURN URLs.
  // TURN_URLS: comma-separated complete URLs (recommended, e.g. from Metered dashboard).
  // TURN_URL: legacy single base URL — expands to turn:<URL> and turns:<URL>.
  let urls;
  if (turnUrls) {
    urls = turnUrls.split(',').map(u => u.trim()).filter(Boolean);
  } else {
    urls = [`turn:${turnUrl}`, `turns:${turnUrl}`];
  }

  const servers = [
    ...STUN_SERVERS,
    { urls, username, credential },
  ];

  res.json(servers);
});

module.exports = router;
