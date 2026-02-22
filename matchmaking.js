const rooms = require('./rooms');

// Queue per time control: Map<timeControl, Array<{ ws, sessionId, name }>>
const queues = new Map();

function joinQueue(ws, sessionId, name, timeControl) {
  const tc = timeControl || '10+0';

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

  if (!queues.has(tc)) {
    queues.set(tc, []);
  }

  const queue = queues.get(tc);

  // Check for a waiting opponent
  if (queue.length > 0) {
    const opponent = queue.shift();

    // Verify opponent is still connected
    if (!opponent.ws || opponent.ws.readyState !== 1) {
      // Opponent disconnected, try next or add self
      return joinQueue(ws, sessionId, name, timeControl);
    }

    // Match found — create a room
    // Randomly assign colors
    const creatorIsWhite = Math.random() < 0.5;
    const whitePlayer = creatorIsWhite ? opponent : { ws, sessionId, name: name || 'Player' };
    const blackPlayer = creatorIsWhite ? { ws, sessionId, name: name || 'Player' } : opponent;

    // Create room with opponent as white, then have current player join
    const room = rooms.createRoom(whitePlayer.ws, whitePlayer.sessionId, whitePlayer.name, tc);
    rooms.joinRoom(blackPlayer.ws, blackPlayer.sessionId, blackPlayer.name, room.id);
  } else {
    // No match — add to queue
    queue.push({ ws, sessionId, name: name || 'Player' });
    send(ws, 'queue_joined', { timeControl: tc, position: queue.length });
  }
}

function leaveQueue(sessionId) {
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
