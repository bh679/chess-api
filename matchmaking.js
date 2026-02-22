const rooms = require('./rooms');

// Queue per time control: Map<timeControl, Array<{ ws, sessionId, name }>>
const queues = new Map();

const DEFAULT_TC = '5+0';

function joinQueue(ws, sessionId, name, timeControl) {
  const tc = timeControl || DEFAULT_TC;

  // Check if already in a queue
  for (const [, q] of queues) {
    if (q.some(p => p.sessionId === sessionId)) {
      send(ws, 'error', { message: 'Already in queue' });
      return;
    }
  }

  // Check if already in a room
  if (rooms.getRoomForSession(sessionId)) {
    send(ws, 'error', { message: 'Already in a game' });
    return;
  }

  const player = { ws, sessionId, name: name || 'Player' };

  // Try to find a match
  const match = findMatch(tc);
  if (match) {
    const { opponent, matchTc } = match;

    // Verify opponent is still connected
    if (!opponent.ws || opponent.ws.readyState !== 1) {
      // Opponent disconnected, remove them and retry
      removeFromQueue(opponent.sessionId);
      return joinQueue(ws, sessionId, name, timeControl);
    }

    // Match found — create a room with randomly assigned colors
    const creatorIsWhite = Math.random() < 0.5;
    const whitePlayer = creatorIsWhite ? opponent : player;
    const blackPlayer = creatorIsWhite ? player : opponent;

    const room = rooms.createRoom(whitePlayer.ws, whitePlayer.sessionId, whitePlayer.name, matchTc);
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
function findMatch(tc) {
  if (tc === 'any') {
    // "Any" player: check all queues for any waiting player
    for (const [queueTc, queue] of queues) {
      if (queue.length > 0) {
        const opponent = queue.shift();
        if (queue.length === 0) queues.delete(queueTc);
        // Use the other player's TC, or default if both are "any"
        const matchTc = queueTc === 'any' ? DEFAULT_TC : queueTc;
        return { opponent, matchTc };
      }
    }
    return null;
  }

  // Specific TC: check same-TC queue first
  const sameQueue = queues.get(tc);
  if (sameQueue && sameQueue.length > 0) {
    const opponent = sameQueue.shift();
    if (sameQueue.length === 0) queues.delete(tc);
    return { opponent, matchTc: tc };
  }

  // Then check "any" queue
  const anyQueue = queues.get('any');
  if (anyQueue && anyQueue.length > 0) {
    const opponent = anyQueue.shift();
    if (anyQueue.length === 0) queues.delete('any');
    return { opponent, matchTc: tc };
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
