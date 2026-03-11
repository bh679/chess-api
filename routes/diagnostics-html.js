'use strict';

// --- Pill status ---

const ONGOING_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

const PILL_COLORS = {
  complete:          { border: '#22c55e', bg: '#14532d', activeBg: '#166534', text: '#4ade80' },
  abandoned:         { border: '#eab308', bg: '#422006', activeBg: '#713f12', text: '#fbbf24' },
  connection_failed: { border: '#ef4444', bg: '#450a0a', activeBg: '#7f1d1d', text: '#f87171' },
  ongoing:           { border: '#3b82f6', bg: '#0c2340', activeBg: '#1d4ed8', text: '#60a5fa' },
};

function computePillStatus(game) {
  const { result, resultReason, moveCount, lastTs } = game;
  if (result === null) {
    return (Date.now() - (lastTs || 0)) < ONGOING_THRESHOLD_MS ? 'ongoing' : 'connection_failed';
  }
  if (resultReason === 'abandoned') return 'connection_failed';
  if ((moveCount || 0) <= 2 || resultReason === 'resignation') return 'abandoned';
  return 'complete';
}

const DOT_RECENT_MS = 5  * 60 * 1000; // 5 min — actively connected
const DOT_GRACE_MS  = 30 * 60 * 1000; // 30 min — grace period

function computeDotColor(sessionState) {
  const { connectionState, lastTs } = sessionState;
  const age = Date.now() - (lastTs || 0);
  const connected    = connectionState === 'connected' || connectionState === 'completed';
  const disconnected = connectionState === 'disconnected' || connectionState === 'failed' || connectionState === 'closed';

  if (connected && age < DOT_RECENT_MS) return '#4ade80'; // green — actively connected
  if (connected && age < DOT_GRACE_MS)  return '#fbbf24'; // yellow — was connected, grace period
  if (disconnected)                      return '#f87171'; // red — explicitly disconnected
  if (age < DOT_GRACE_MS)               return '#fbbf24'; // yellow — no state, still recent
  return '#f87171';                                        // red — stale / no activity
}

// --- Category colors ---

const CATEGORY_COLORS = {
  lifecycle: '#3b82f6',
  error:     '#ef4444',
  move:      '#22c55e',
  connection:'#f59e0b',
  sync:      '#8b5cf6',
  webrtc:    '#06b6d4',
  unknown:   '#6b7280',
};

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS.unknown;
}

function formatTs(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-AU', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function formatRelativeMs(a, b) {
  const diff = b - a;
  if (diff < 0) return '';
  if (diff < 1000) return `+${diff}ms`;
  return `+${(diff / 1000).toFixed(1)}s`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function groupBySession(events) {
  const sessionsMap = new Map();
  for (const e of events) {
    const sid = e.sessionId || 'unknown';
    if (!sessionsMap.has(sid)) sessionsMap.set(sid, []);
    sessionsMap.get(sid).push(e);
  }
  // Sort sessions by their first event timestamp
  return [...sessionsMap.entries()]
    .sort((a, b) => (a[1][0].timestamp || 0) - (b[1][0].timestamp || 0));
}

function categoryLegend(events) {
  const cats = [...new Set(events.map(e => e.category || 'unknown'))];
  return cats.map(cat => {
    const color = categoryColor(cat);
    return `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${escapeHtml(cat)}</span>`;
  }).join('');
}

/**
 * Compute WebRTC summary stats from a session's events.
 * Returns null if no webrtc events exist for the session.
 */
function computeWebRtcSummary(events) {
  const webrtcEvents = events.filter(e => e.category === 'webrtc');
  if (webrtcEvents.length === 0) return null;

  const summary = {
    hasTurn: false,
    serverCount: 0,
    candidates: { host: 0, srflx: 0, relay: 0, prflx: 0, unknown: 0 },
    iceState: null,
    connectionState: null,
    videoReceived: false,
    audioReceived: false,
  };

  for (const e of webrtcEvents) {
    const d = e.data || {};
    if (e.eventType === 'ice_servers_config') {
      summary.hasTurn = !!d.hasTurn;
      summary.serverCount = d.count || 0;
    } else if (e.eventType === 'ice_candidate_local') {
      const t = d.type || 'unknown';
      if (t in summary.candidates) summary.candidates[t]++;
      else summary.candidates.unknown++;
    } else if (e.eventType === 'ice_state_change') {
      summary.iceState = d.state || d.iceState || null;
    } else if (e.eventType === 'connection_state_change') {
      summary.connectionState = d.state || d.connectionState || null;
    } else if (e.eventType === 'remote_track_received') {
      if (d.kind === 'video') summary.videoReceived = true;
      if (d.kind === 'audio') summary.audioReceived = true;
    }
  }

  return summary;
}

function renderWebRtcSummary(summary) {
  if (!summary) return '';

  const relayCount = summary.candidates.relay;
  const turnOk = relayCount > 0;
  const iceOk = summary.iceState === 'connected' || summary.iceState === 'completed';
  const connOk = summary.connectionState === 'connected';

  const turnLabel = summary.hasTurn
    ? (turnOk
        ? `<span class="wrtc-ok">TURN ✓ (${relayCount} relay)</span>`
        : `<span class="wrtc-warn">TURN ⚠ (0 relay)</span>`)
    : `<span class="wrtc-off">TURN off</span>`;

  const iceLabel = summary.iceState
    ? (iceOk
        ? `<span class="wrtc-ok">ICE: ${escapeHtml(summary.iceState)}</span>`
        : `<span class="wrtc-fail">ICE: ${escapeHtml(summary.iceState)}</span>`)
    : '';

  const connLabel = summary.connectionState
    ? (connOk
        ? `<span class="wrtc-ok">conn: ${escapeHtml(summary.connectionState)}</span>`
        : `<span class="wrtc-fail">conn: ${escapeHtml(summary.connectionState)}</span>`)
    : '';

  const candidateLabel = `<span class="wrtc-dim">host:${summary.candidates.host} srflx:${summary.candidates.srflx} relay:${relayCount}</span>`;

  const videoLabel = summary.videoReceived
    ? `<span class="wrtc-ok">video ✓</span>`
    : `<span class="wrtc-fail">video ✗</span>`;

  return `<div class="webrtc-summary">${turnLabel} · ${iceLabel}${connLabel ? ' · ' + connLabel : ''} · ${candidateLabel} · ${videoLabel}</div>`;
}

function renderEventRow(e, baseTs) {
  const color = categoryColor(e.category);
  const dataStr = escapeHtml(JSON.stringify(e.data || {}, null, 2));
  const rel = baseTs ? formatRelativeMs(baseTs, e.timestamp) : '';
  return `<div class="event-row">
    <div class="event-time">
      <span class="ts-abs">${formatTs(e.timestamp)}</span>
      ${rel ? `<span class="ts-rel">${escapeHtml(rel)}</span>` : ''}
    </div>
    <span class="badge" style="background:${color}">${escapeHtml(e.category || 'unknown')}</span>
    <span class="event-type">${escapeHtml(e.eventType || '—')}</span>
    <details class="data-detail"><summary>data</summary><pre>${dataStr}</pre></details>
  </div>`;
}

function renderSessionSection(sessionId, events) {
  const d = events[0].deviceInfo || {};
  const shortId = String(sessionId).slice(0, 8);
  const baseTs = events[0].timestamp;
  const catCounts = events.reduce((acc, e) => {
    const c = e.category || 'unknown';
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});
  const catSummary = Object.entries(catCounts)
    .map(([c, n]) => `<span class="badge sm" style="background:${categoryColor(c)}">${n} ${escapeHtml(c)}</span>`)
    .join(' ');

  const webRtcSummary = renderWebRtcSummary(computeWebRtcSummary(events));

  return `<details class="session-section" open>
  <summary class="session-header">
    <div class="session-device">
      <span class="device-icon">${escapeHtml(d.device || '?')}</span>
      <span class="device-browser">${escapeHtml(d.browser || '?')} ${escapeHtml(d.browserVersion || '')}</span>
      <span class="device-os">${escapeHtml(d.os || '?')} ${escapeHtml(d.osVersion || '')}</span>
      <span class="device-screen">${escapeHtml(String(d.screenWidth || '?'))}×${escapeHtml(String(d.screenHeight || '?'))}</span>
    </div>
    <div class="session-right">
      ${catSummary}
      <span class="session-id" title="${escapeHtml(sessionId)}">${escapeHtml(shortId)}…</span>
    </div>
  </summary>
  ${webRtcSummary}
  <div class="session-events">
    ${events.map(e => renderEventRow(e, baseTs)).join('\n')}
  </div>
</details>`;
}

function renderConnectionDots(sessionStates) {
  if (!sessionStates || sessionStates.length === 0) return '';
  return sessionStates.slice(0, 2).map(s => {
    const color = computeDotColor(s);
    const title = `Session ${String(s.sessionId).slice(0, 8)}… · state: ${s.connectionState || 'unknown'}`;
    return `<span class="conn-dot" style="background:${color}" title="${escapeHtml(title)}"></span>`;
  }).join('');
}

function renderGamesNav(recentGames, currentGameId) {
  if (!recentGames || recentGames.length === 0) return '';

  const items = recentGames.map(g => {
    const isCurrent = g.gameId === currentGameId;
    const status = computePillStatus(g);
    const colors = PILL_COLORS[status];
    const label = `#${g.gameId} · ${g.eventCount} event${g.eventCount !== 1 ? 's' : ''} · ${formatTs(g.lastTs)}`;

    const dots = status === 'ongoing' ? renderConnectionDots(g.sessionStates) : '';
    const pillBg = isCurrent ? colors.activeBg : colors.bg;
    const inlineStyle = `background:${pillBg};border-color:${colors.border};color:${colors.text};`;

    if (isCurrent) {
      return `<span class="game-nav-item game-nav-current" style="${inlineStyle}" title="Currently viewing">${dots}${escapeHtml(label)}</span>`;
    }
    return `<a class="game-nav-item" href="/api/chess/diagnostics?gameId=${g.gameId}" style="${inlineStyle}">${dots}${escapeHtml(label)}</a>`;
  }).join('');

  const legend = `<div class="pill-legend">
    <span class="pill-legend-item" style="color:#4ade80">■ complete</span>
    <span class="pill-legend-item" style="color:#fbbf24">■ abandoned / short</span>
    <span class="pill-legend-item" style="color:#f87171">■ conn. failed</span>
    <span class="pill-legend-item" style="color:#60a5fa">■ ongoing</span>
    <span class="pill-legend-item" style="color:#94a3b8">· dots = player conn. status</span>
  </div>`;

  return `<div class="games-nav">
  <span class="games-nav-label">GAMES</span>
  <div class="games-nav-list">${items}</div>
</div>
${legend}`;
}

function renderDiagnosticsHTML(result, context, recentGames = []) {
  const { events = [], count = 0 } = result;
  const ctxLabel = context || `Game ${result.gameId}`;
  const firstTs = events.length ? events[0].timestamp : null;
  const lastTs  = events.length ? events[events.length - 1].timestamp : null;
  const timeRange = firstTs ? `${formatTs(firstTs)} → ${formatTs(lastTs)}` : 'No events';
  const sessions = groupBySession(events);
  const rawJson = escapeHtml(JSON.stringify(result, null, 2));
  const roomCodes = [...new Set(events.map(e => e.roomCode).filter(Boolean))].join(', ') || '—';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diagnostics — ${escapeHtml(ctxLabel)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, monospace; font-size: 13px; background: #0f172a; color: #e2e8f0; min-height: 100vh; }

  /* Header */
  .header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: flex-start; gap: 16px; }
  .header-title { font-size: 20px; font-weight: 700; color: #f1f5f9; }
  .header-meta { color: #94a3b8; font-size: 12px; margin-top: 4px; }
  .header-actions { margin-left: auto; display: flex; gap: 8px; flex-shrink: 0; }
  .btn { background: #1e3a5f; border: 1px solid #3b82f6; color: #60a5fa; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; white-space: nowrap; }
  .btn:hover { background: #1d4ed8; color: #fff; }

  /* Summary card */
  .summary { display: flex; flex-wrap: wrap; gap: 20px; padding: 16px 24px; background: #1e293b; border-bottom: 1px solid #334155; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
  .stat-value { font-size: 15px; font-weight: 600; color: #f1f5f9; }

  /* Games nav */
  .games-nav { padding: 10px 24px; border-bottom: 1px solid #334155; background: #0f172a; display: flex; align-items: flex-start; gap: 12px; }
  .games-nav-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #475569; white-space: nowrap; padding-top: 3px; }
  .games-nav-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .game-nav-item { font-size: 11px; padding: 3px 10px; border-radius: 999px; border: 1px solid transparent; text-decoration: none; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
  .game-nav-item:hover { filter: brightness(1.25); }
  .game-nav-current { cursor: default; }
  .conn-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .pill-legend { padding: 4px 24px 8px; display: flex; gap: 14px; flex-wrap: wrap; border-bottom: 1px solid #1e293b; }
  .pill-legend-item { font-size: 10px; white-space: nowrap; }

  /* Legend */
  .legend { padding: 8px 24px 12px; display: flex; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid #1e293b; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #94a3b8; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

  /* Sessions */
  .sessions { padding: 16px 24px; display: flex; flex-direction: column; gap: 16px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #64748b; margin-bottom: 12px; }

  .session-section { background: #1e293b; border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
  .session-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; cursor: pointer; list-style: none; gap: 12px; flex-wrap: wrap; }
  .session-header::-webkit-details-marker { display: none; }
  .session-section[open] .session-header { border-bottom: 1px solid #334155; background: #243147; }
  .session-header:hover { background: #243147; }
  .session-device { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .device-icon { font-size: 11px; font-weight: 700; color: #f1f5f9; background: #0f172a; padding: 2px 8px; border-radius: 4px; }
  .device-browser { color: #e2e8f0; font-weight: 600; }
  .device-os { color: #94a3b8; }
  .device-screen { color: #475569; font-size: 11px; }
  .session-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto; }
  .session-id { color: #475569; font-size: 11px; }

  /* WebRTC summary bar */
  .webrtc-summary { padding: 6px 16px; background: #0f172a; border-bottom: 1px solid #1e293b; font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .wrtc-ok   { color: #4ade80; font-weight: 600; }
  .wrtc-warn { color: #fb923c; font-weight: 600; }
  .wrtc-fail { color: #f87171; font-weight: 600; }
  .wrtc-off  { color: #475569; }
  .wrtc-dim  { color: #64748b; }

  /* Events */
  .session-events { padding: 0 16px 12px; display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .event-row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 8px; border-radius: 6px; flex-wrap: wrap; }
  .event-row:hover { background: #1a2740; }
  .event-time { display: flex; flex-direction: column; min-width: 145px; }
  .ts-abs { color: #94a3b8; font-size: 11px; white-space: nowrap; }
  .ts-rel { color: #475569; font-size: 10px; }
  .event-type { color: #e2e8f0; flex: 1; min-width: 120px; }

  /* Badges */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; }
  .badge.sm { font-size: 10px; padding: 1px 6px; }

  /* Data detail */
  .data-detail summary { cursor: pointer; color: #475569; font-size: 11px; }
  .data-detail summary:hover { color: #94a3b8; }
  .data-detail[open] summary { color: #60a5fa; }
  pre { background: #0f172a; border: 1px solid #1e293b; border-radius: 4px; padding: 8px; margin-top: 6px; font-size: 11px; color: #a5f3fc; white-space: pre-wrap; word-break: break-all; max-width: 520px; }

  /* Copy JSON */
  .copy-section { padding: 20px 24px 40px; border-top: 1px solid #1e293b; display: flex; justify-content: center; }

  /* Empty */
  .empty { color: #475569; padding: 48px; text-align: center; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="header-title">Chess Diagnostics</div>
    <div class="header-meta">${escapeHtml(ctxLabel)}</div>
  </div>
  <div class="header-actions">
    ${result.gameId ? `<button class="btn" id="api-link-btn" onclick="copyApiLink()">⧉ Copy API link</button>` : ''}
    <button class="btn" onclick="location.reload()">↻ Refresh</button>
  </div>
</div>

<div class="summary">
  <div class="stat"><span class="stat-label">Game ID</span><span class="stat-value">${escapeHtml(String(result.gameId || '—'))}</span></div>
  <div class="stat"><span class="stat-label">Room</span><span class="stat-value">${escapeHtml(roomCodes)}</span></div>
  <div class="stat"><span class="stat-label">Events</span><span class="stat-value">${count}</span></div>
  <div class="stat"><span class="stat-label">Sessions</span><span class="stat-value">${sessions.length}</span></div>
  <div class="stat"><span class="stat-label">Time range</span><span class="stat-value" style="font-size:12px">${timeRange}</span></div>
</div>

${renderGamesNav(recentGames, result.gameId)}

${events.length > 0 ? `<div class="legend">${categoryLegend(events)}</div>` : ''}

<div class="sessions">
  ${events.length === 0
    ? '<div class="empty">No diagnostic events found</div>'
    : `<div class="section-title">${sessions.length} Session${sessions.length !== 1 ? 's' : ''}</div>
       ${sessions.map(([sid, evts]) => renderSessionSection(sid, evts)).join('\n')}`
  }
</div>

<div class="copy-section">
  <button class="btn" id="copy-btn" onclick="copyJson()">⧉ Copy JSON</button>
</div>

<script>
var _json = ${JSON.stringify(JSON.stringify(result))};
var _gameId = ${result.gameId ? result.gameId : 'null'};
function copyApiLink() {
  var url = location.origin + '/api/chess/diagnostics/game/' + _gameId;
  navigator.clipboard.writeText(url).then(function() {
    var btn = document.getElementById('api-link-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(function() { btn.textContent = '⧉ Copy API link'; }, 2000);
  }).catch(function() {
    var btn = document.getElementById('api-link-btn');
    btn.textContent = 'Copy failed';
  });
}
function copyJson() {
  navigator.clipboard.writeText(_json).then(function() {
    var btn = document.getElementById('copy-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(function() { btn.textContent = '⧉ Copy JSON'; }, 2000);
  }).catch(function() {
    var btn = document.getElementById('copy-btn');
    btn.textContent = 'Copy failed';
  });
}
</script>
</body>
</html>`;
}

module.exports = { renderDiagnosticsHTML };
