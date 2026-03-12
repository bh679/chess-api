/**
 * ICE server configuration endpoint.
 *
 * Returns STUN servers always. Returns TURN credentials as well when
 * configured via environment variables.
 *
 * Three TURN credential modes are supported:
 *
 * 1. Cloudflare TURN (primary, with Metered.ca fallback):
 *    CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN
 *
 *    Makes a server-side fetch to the Cloudflare TURN credentials API and
 *    returns those ICE servers combined with any configured Metered servers.
 *    If the Cloudflare API fails, falls back to Metered-only.
 *
 * 2. Static credentials (Metered.ca / Open Relay):
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
 * 3. HMAC-SHA1 time-limited credentials (self-hosted coturn):
 *    TURN_URL, TURN_SECRET
 *    Generates 24-hour tokens using the coturn REST API format.
 *
 * Static mode (2) takes precedence over HMAC (3) if both are configured.
 * Cloudflare mode (1) takes precedence over all others if configured.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

let cloudflareFetchCount = 0;

// Fetch ICE servers from Cloudflare TURN credentials API.
// Returns an array of ICE server objects, or null on failure.
async function fetchCloudflareIceServers(keyId, apiToken) {
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!response.ok) {
      console.error(`[ice-servers] Cloudflare TURN API error: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    cloudflareFetchCount++;
    console.log(`[ice-servers] Cloudflare credentials generated (total this session: ${cloudflareFetchCount})`);
    return data.iceServers || null;
  } catch (err) {
    console.error('[ice-servers] Cloudflare TURN fetch failed:', err.message);
    return null;
  }
}

// Build Metered/static TURN servers from env vars. Returns an array (may be empty).
function buildMeteredServers() {
  const turnUrls = process.env.TURN_URLS;
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnPassword = process.env.TURN_PASSWORD;
  const turnSecret = process.env.TURN_SECRET;

  if (!turnUrls && !turnUrl) return [];

  let username, credential;

  if (turnUsername && turnPassword) {
    username = turnUsername;
    credential = turnPassword;
  } else if (turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    username = String(expiry);
    credential = crypto
      .createHmac('sha1', turnSecret)
      .update(username)
      .digest('base64');
  } else {
    return [];
  }

  let urls;
  if (turnUrls) {
    urls = turnUrls.split(',').map(u => u.trim()).filter(Boolean);
  } else {
    urls = [`turn:${turnUrl}`, `turns:${turnUrl}`];
  }

  return [{ urls, username, credential }];
}

// GET /api/chess/ice-servers — returns ICE server config for WebRTC
router.get('/ice-servers', async (req, res) => {
  const cfKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const cfToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (cfKeyId && cfToken) {
    const cfServers = await fetchCloudflareIceServers(cfKeyId, cfToken);
    const meteredServers = buildMeteredServers();

    if (cfServers) {
      // Cloudflare primary + Metered fallback (WebRTC tries all in parallel)
      return res.json([...STUN_SERVERS, ...cfServers, ...meteredServers]);
    }

    // Cloudflare failed — fall back to Metered only
    console.warn('[ice-servers] Falling back to Metered-only due to Cloudflare API failure');
    if (meteredServers.length > 0) {
      return res.json([...STUN_SERVERS, ...meteredServers]);
    }
    return res.json(STUN_SERVERS);
  }

  // No Cloudflare config — use Metered/static/HMAC mode
  const meteredServers = buildMeteredServers();
  if (meteredServers.length === 0) {
    return res.json(STUN_SERVERS);
  }
  return res.json([...STUN_SERVERS, ...meteredServers]);
});

module.exports = router;
