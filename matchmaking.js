const rooms = require('./rooms');

// Queue per time control: Map<timeControl, Array<{ ws, sessionId, name }>>
const queues = new Map();

const DEFAULT_TC = '5+0';

function joinQueue(ws, sessionId, name, timeControl, camMode, chess960) {
  const tc = timeControl || DEFAULT_TC;
  const effectiveCamMode = ['none', 'king-cam', 'board-face', 'tile-cam', 'split-cam', 'split-cam-h'].includes(camMode) ? camMode : 'none';
  const wantsVideo = effectiveCamMode !== 'none';

  // Check if already in a queue
  for (const [, q] of queues) {
    if (q.some(p => p.sessionId === sessionId)) {
      send(ws, 'error', { message: 'Already in queue' });
      return;
    }
  }

  // Check if already in an active room
  const existingRoom = rooms.getRoomForSession(sessionId);
  if (existingRoom && existingRoom.status !== 'finished') {
    send(ws, 'error', { message: 'Already in a game' });
    return;
  }

  const wantsChess960 = !!chess960;
  const player = { ws, sessionId, name: name || 'Opponent', camMode: effectiveCamMode, videoEnabled: wantsVideo, chess960: wantsChess960 };

  // Try to find a match (video and chess960 preferences must match)
  const match = findMatch(tc, wantsVideo, wantsChess960);
  if (match) {
    const { opponent, matchTc } = match;

    // Verify opponent is still connected
    if (!opponent.ws || opponent.ws.readyState !== 1) {
      // Opponent disconnected, remove them and retry
      removeFromQueue(opponent.sessionId);
      return joinQueue(ws, sessionId, name, timeControl, camMode, chess960);
    }

    // Match found — create a room with randomly assigned colors
    const creatorIsWhite = Math.random() < 0.5;
    const whitePlayer = creatorIsWhite ? opponent : player;
    const blackPlayer = creatorIsWhite ? player : opponent;

    // Use cam mode only if both players want video; prefer the joiner's cam mode
    const matchCamMode = (wantsVideo && opponent.videoEnabled) ? (player.camMode || opponent.camMode) : 'none';
    const matchChess960 = wantsChess960 && opponent.chess960;
    const room = rooms.createRoom(whitePlayer.ws, whitePlayer.sessionId, whitePlayer.name, matchTc, matchCamMode, matchChess960);
    rooms.joinRoom(blackPlayer.ws, blackPlayer.sessionId, blackPlayer.name, room.id);
  } else {
    // No match — add to queue
    if (!queues.has(tc)) queues.set(tc, []);
    queues.get(tc).push(player);
    send(ws, 'queue_joined', { timeControl: tc, position: queues.get(tc).length });
  }
}

/**
 * Find a matching opponent for the given time control.
 * "any" matches with any TC queue. Specific TCs also check the "any" queue.
 * Returns { opponent, matchTc } or null.
 */
function findMatch(tc, wantsVideo, wantsChess960) {
  // Filter helper: only match players with the same video and chess960 preferences
  function preferencesMatch(player) {
    return !!player.videoEnabled === !!wantsVideo && !!player.chess960 === !!wantsChess960;
  }

  function takeFirstMatch(queue, queueTc) {
    const idx = queue.findIndex(preferencesMatch);
    if (idx === -1) return null;
    const opponent = queue.splice(idx, 1)[0];
    if (queue.length === 0) queues.delete(queueTc);
    return opponent;
  }

  if (tc === 'any') {
    // "Any" player: check all queues for any waiting player with matching video pref
    for (const [queueTc, queue] of queues) {
      const opponent = takeFirstMatch(queue, queueTc);
      if (opponent) {
        const matchTc = queueTc === 'any' ? DEFAULT_TC : queueTc;
        return { opponent, matchTc };
      }
    }
    return null;
  }

  // Specific TC: check same-TC queue first
  const sameQueue = queues.get(tc);
  if (sameQueue) {
    const opponent = takeFirstMatch(sameQueue, tc);
    if (opponent) return { opponent, matchTc: tc };
  }

  // Then check "any" queue
  const anyQueue = queues.get('any');
  if (anyQueue) {
    const opponent = takeFirstMatch(anyQueue, 'any');
    if (opponent) return { opponent, matchTc: tc };
  }

  return null;
}

function removeFromQueue(sessionId) {
  for (const [tc, queue] of queues) {
    const idx = queue.findIndex(p => p.sessionId === sessionId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      if (queue.length === 0) queues.delete(tc);
      return true;
    }
  }
  return false;
}

function leaveQueue(sessionId) {
  return removeFromQueue(sessionId);
}

function handleDisconnect(sessionId) {
  leaveQueue(sessionId);
}

function getQueueSize(timeControl) {
  const queue = queues.get(timeControl);
  return queue ? queue.length : 0;
}

function send(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type, payload }));
  } catch (e) {
    // Connection may have closed
  }
}

module.exports = {
  joinQueue,
  leaveQueue,
  handleDisconnect,
  getQueueSize,
};
