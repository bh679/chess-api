const bughouseRooms = require('./bughouse-rooms');

// Queue per time control: Map<timeControl, Array<{ ws, sessionId, name }>>
const bughouseQueues = new Map();

const DEFAULT_TC = '5+0';

function joinBughouseQueue(ws, sessionId, name, timeControl) {
  const tc = timeControl || DEFAULT_TC;

  // Check if already in a bughouse queue
  for (const [, q] of bughouseQueues) {
    if (q.some(p => p.sessionId === sessionId)) {
      send(ws, 'error', { message: 'Already in bughouse queue' });
      return;
    }
  }

  // Check if already in an active bughouse room
  const existingRoom = bughouseRooms.getBughouseRoomForSession(sessionId);
  if (existingRoom && existingRoom.status !== 'finished') {
    send(ws, 'error', { message: 'Already in a bughouse game' });
    return;
  }

  const player = { ws, sessionId, name: name || 'Player' };

  if (!bughouseQueues.has(tc)) bughouseQueues.set(tc, []);
  const queue = bughouseQueues.get(tc);
  queue.push(player);

  send(ws, 'bug_queue_joined', { timeControl: tc, position: queue.length });

  // Check if we have 4 players
  if (queue.length >= 4) {
    const players = queue.splice(0, 4);
    if (queue.length === 0) bughouseQueues.delete(tc);

    // Verify all players are still connected
    const connected = players.filter(p => p.ws && p.ws.readyState === 1);
    if (connected.length < 4) {
      // Re-queue connected players
      for (const p of connected) {
        joinBughouseQueue(p.ws, p.sessionId, p.name, tc);
      }
      return;
    }

    // Create room with first player, others join
    const room = bughouseRooms.createBughouseRoom(
      players[0].ws, players[0].sessionId, players[0].name, tc
    );

    for (let i = 1; i < 4; i++) {
      bughouseRooms.joinBughouseRoom(
        players[i].ws, players[i].sessionId, players[i].name, room.id
      );
    }
  }
}

function leaveBughouseQueue(sessionId) {
  for (const [tc, queue] of bughouseQueues) {
    const idx = queue.findIndex(p => p.sessionId === sessionId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      if (queue.length === 0) bughouseQueues.delete(tc);
      return true;
    }
  }
  return false;
}

function handleBughouseDisconnect(sessionId) {
  leaveBughouseQueue(sessionId);
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
  joinBughouseQueue,
  leaveBughouseQueue,
  handleBughouseDisconnect,
};
