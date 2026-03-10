'use strict';

const CATEGORY_COLORS = {
  lifecycle: '#3b82f6',
  error: '#ef4444',
  move: '#22c55e',
  connection: '#f59e0b',
  sync: '#8b5cf6',
  unknown: '#6b7280',
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function deviceCards(events) {
  const bySession = new Map();
  for (const e of events) {
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, e);
  }
  if (bySession.size === 0) return '<p style="color:#6b7280">No device info</p>';
  return [...bySession.values()].map(e => {
    const d = e.deviceInfo || {};
    const shortId = String(e.sessionId || '').slice(0, 8);
    return `<div class="device-card">
      <div class="device-name">${escapeHtml(d.device || 'Unknown')} — ${escapeHtml(d.browser || '?')} ${escapeHtml(d.browserVersion || '')}</div>
      <div class="device-meta">
        <span>${escapeHtml(d.os || '?')} ${escapeHtml(d.osVersion || '')}</span>
        <span>${escapeHtml(d.screenWidth || '?')}×${escapeHtml(d.screenHeight || '?')}</span>
        <span class="session-id" title="${escapeHtml(e.sessionId || '')}">${shortId}…</span>
      </div>
    </div>`;
  }).join('\n');
}

function eventRows(events) {
  return events.map(e => {
    const color = categoryColor(e.category);
    const dataStr = escapeHtml(JSON.stringify(e.data || {}, null, 2));
    return `<tr data-category="${escapeHtml(e.category || 'unknown')}">
      <td class="ts">${formatTs(e.timestamp)}</td>
      <td><span class="badge" style="background:${color}">${escapeHtml(e.category || 'unknown')}</span></td>
      <td class="event-type">${escapeHtml(e.eventType || '—')}</td>
      <td class="session-col">${escapeHtml(String(e.sessionId || '').slice(0, 8))}…</td>
      <td><details><summary>data</summary><pre>${dataStr}</pre></details></td>
    </tr>`;
  }).join('\n');
}

function categoryFilterButtons(events) {
  const cats = [...new Set(events.map(e => e.category || 'unknown'))];
  const buttons = cats.map(cat => {
    const color = categoryColor(cat);
    return `<button class="filter-btn" data-cat="${escapeHtml(cat)}" style="--cat-color:${color}">${escapeHtml(cat)}</button>`;
  }).join('\n');
  return `<button class="filter-btn active" data-cat="all" style="--cat-color:#e2e8f0">All</button>\n${buttons}`;
}

function renderDiagnosticsHTML(result, context) {
  const { gameId, events = [], count = 0 } = result;
  const ctxLabel = context || `Game ${gameId}`;
  const firstTs = events.length ? events[0].timestamp : null;
  const lastTs = events.length ? events[events.length - 1].timestamp : null;
  const timeRange = firstTs
    ? `${formatTs(firstTs)} → ${formatTs(lastTs)}`
    : 'No events';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diagnostics — ${escapeHtml(ctxLabel)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, monospace; font-size: 13px; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  .header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .header-title { font-size: 18px; font-weight: 700; color: #f1f5f9; flex: 1; }
  .header-meta { color: #94a3b8; font-size: 12px; }
  .refresh-btn { background: #1e3a5f; border: 1px solid #3b82f6; color: #60a5fa; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .refresh-btn:hover { background: #1d4ed8; color: #fff; }

  /* Sections */
  .section { padding: 20px 24px; border-bottom: 1px solid #1e293b; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #64748b; margin-bottom: 12px; }

  /* Device cards */
  .devices { display: flex; flex-wrap: wrap; gap: 10px; }
  .device-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; min-width: 200px; }
  .device-name { font-weight: 600; color: #f1f5f9; margin-bottom: 4px; }
  .device-meta { color: #94a3b8; font-size: 11px; display: flex; gap: 10px; flex-wrap: wrap; }
  .session-id { color: #475569; }

  /* Filters */
  .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .filter-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 4px 12px; border-radius: 999px; cursor: pointer; font-size: 12px; font-family: inherit; transition: all .15s; }
  .filter-btn:hover { border-color: var(--cat-color); color: var(--cat-color); }
  .filter-btn.active { background: var(--cat-color); border-color: var(--cat-color); color: #fff; font-weight: 600; }

  /* Table */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #64748b; padding: 6px 10px; border-bottom: 1px solid #334155; white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
  tr:hover td { background: #1e293b; }
  tr[hidden] { display: none; }
  .ts { color: #94a3b8; white-space: nowrap; }
  .event-type { color: #e2e8f0; }
  .session-col { color: #475569; font-size: 11px; }

  /* Badge */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; }

  /* Details / pre */
  details summary { cursor: pointer; color: #475569; font-size: 11px; }
  details summary:hover { color: #94a3b8; }
  details[open] summary { color: #60a5fa; }
  pre { background: #0f172a; border: 1px solid #1e293b; border-radius: 4px; padding: 8px; margin-top: 6px; font-size: 11px; color: #a5f3fc; white-space: pre-wrap; word-break: break-all; max-width: 480px; }

  /* Nav links */
  .nav { display: flex; gap: 16px; flex-wrap: wrap; }
  .nav a { color: #60a5fa; font-size: 12px; }

  /* Empty state */
  .empty { color: #475569; padding: 32px; text-align: center; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="header-title">Chess Diagnostics</div>
    <div class="header-meta">${escapeHtml(ctxLabel)} &nbsp;·&nbsp; ${count} event${count !== 1 ? 's' : ''} &nbsp;·&nbsp; ${timeRange}</div>
  </div>
  <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
</div>

<div class="section">
  <div class="section-title">Navigation</div>
  <div class="nav">
    <a href="?">Recent game</a>
    <span style="color:#334155">|</span>
    <span style="color:#475569">Game: /api/chess/diagnostics/game/:id</span>
    <span style="color:#475569">Room: /api/chess/diagnostics/room/:code</span>
    <span style="color:#475569">Session: /api/chess/diagnostics/session/:id</span>
  </div>
</div>

<div class="section">
  <div class="section-title">Devices (${[...new Set(events.map(e => e.sessionId))].length} session${[...new Set(events.map(e => e.sessionId))].length !== 1 ? 's' : ''})</div>
  <div class="devices">
    ${deviceCards(events)}
  </div>
</div>

<div class="section">
  <div class="section-title">Events (${count})</div>
  ${events.length === 0 ? '<div class="empty">No events found</div>' : `
  <div class="filters" id="filters">
    ${categoryFilterButtons(events)}
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Time</th><th>Category</th><th>Event</th><th>Session</th><th>Data</th></tr></thead>
      <tbody id="tbody">
        ${eventRows(events)}
      </tbody>
    </table>
  </div>
  `}
</div>

<script>
  document.getElementById('filters') && document.getElementById('filters').addEventListener('click', function(e) {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const cat = btn.dataset.cat;
    document.querySelectorAll('#tbody tr').forEach(function(row) {
      row.hidden = cat !== 'all' && row.dataset.category !== cat;
    });
  });
</script>
</body>
</html>`;
}

module.exports = { renderDiagnosticsHTML };
