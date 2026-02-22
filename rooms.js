const { Chess } = require('chess.js');
const { createGame, addMove, endGame } = require('./db');

// In-memory room store
const rooms = new Map();

// Session → room mapping for reconnection
const sessionRooms = new Map();

const ROOM_CODE_LENGTH = 6;
const ROOM_TTL_AFTER_END = 5 * 60 * 1000;     // 5 min
const DISCONNECT_GRACE_PERIOD = 60 * 1000;      // 60s

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function parseTimeControl(tc) {
  if (!tc || tc === 'none') return null;
  // Format: "5+0", "10+5", "3+2", etc.
  const match = tc.match(/^(\d+)\+(\d+)$/);
  if (!match) return null;
  return { minutes: parseInt(match[1], 10), increment: parseInt(match[2], 10) };
}

function createRoom(ws, sessionId, name, timeControl) {
  const roomId = generateRoomCode();
  // "any" defaults to 5+0 for room creation
  const effectiveTc = timeControl === 'any' ? '5+0' : timeControl;
  const tc = parseTimeControl(effectiveTc);
  const timeMs = tc ? tc.minutes * 60 * 1000 : 0;

  const room = {
    id: roomId,
    white: { ws, sessionId, name: name || 'White', connected: true },
    black: null,
    chess: new Chess(),
    timeControl: effectiveTc || 'none',
    clocks: tc ? { w: timeMs, b: timeMs, increment: tc.increment * 1000, lastMoveAt: null } : null,
    moves: [],
    status: 'waiting',
    dbGameId: null,
    createdAt: Date.now(),
    cleanupTimer: null,
  };

  rooms.set(roomId, room);
  sessionRooms.set(sessionId, roomId);

  send(ws, 'room_created', { roomId, color: 'w' });
  return room;
}

function joinRoom(ws, sessionId, name, roomId) {
  const room = rooms.get(roomId.toUpperCase());
  if (!room) {
    send(ws, 'error', { message: 'Room not found' });
    return null;
  }
  if (room.status !== 'waiting') {
    // Check for reconnection
    if (room.status === 'playing') {
      return attemptReconnect(ws, sessionId, room);
    }
    send(ws, 'error', { message: 'Room is not accepting players' });
    return null;
  }
  if (room.white.sessionId === sessionId) {
    send(ws, 'error', { message: 'You are already in this room' });
    return null;
  }

  room.black = { ws, sessionId, name: name || 'Black', connected: true };
  room.status = 'playing';
  sessionRooms.set(sessionId, roomId);

  // Create database game record
  room.dbGameId = createGame({
    gameType: 'multiplayer',
    timeControl: room.timeControl,
    startingFen: room.chess.fen(),
    white: { name: room.white.name, isAI: false, elo: null, engineId: null },
    black: { name: room.black.name, isAI: false, elo: null, engineId: null },
  });

  // Start clock if timed
  if (room.clocks) {
    room.clocks.lastMoveAt = Date.now();
  }

  const startPayload = {
    roomId: room.id,
    fen: room.chess.fen(),
    timeControl: room.timeControl,
  };

  send(room.white.ws, 'game_start', { ...startPayload, color: 'w', opponentName: room.black.name });
  send(room.black.ws, 'game_start', { ...startPayload, color: 'b', opponentName: room.white.name });

  return room;
}

function makeMove(sessionId, san) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return { error: 'Not in a room' };

  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return { error: 'Game not in progress' };

  // Verify it's this player's turn
  const turn = room.chess.turn();
  const player = getPlayerBySide(room, turn);
  if (!player || player.sessionId !== sessionId) return { error: 'Not your turn' };

  // Validate and apply move server-side
  let move;
  try {
    move = room.chess.move(san);
  } catch (e) {
    return { error: 'Invalid move' };
  }
  if (!move) return { error: 'Invalid move' };

  const now = Date.now();
  const fen = room.chess.fen();

  // Update clocks
  if (room.clocks && room.moves.length > 0) {
    const elapsed = now - room.clocks.lastMoveAt;
    room.clocks[turn] -= elapsed;
    if (room.clocks[turn] <= 0) {
      room.clocks[turn] = 0;
      // Time out — the player who just moved ran out (they used too long)
      const loser = turn;
      const winner = turn === 'w' ? 'b' : 'w';
      const result = winner === 'w' ? '1-0' : '0-1';
      finishGame(room, result, 'timeout');
      return { ok: true };
    }
    // Add increment
    room.clocks[turn] += room.clocks.increment;
  }
  if (room.clocks) {
    room.clocks.lastMoveAt = now;
  }

  // Record move
  const moveRecord = { ply: room.moves.length, san: move.san, fen, timestamp: now, side: turn };
  room.moves.push(moveRecord);

  // Persist to database
  if (room.dbGameId) {
    addMove(room.dbGameId, moveRecord);
  }

  // Build clock payload
  const clockPayload = room.clocks ? { w: room.clocks.w, b: room.clocks.b } : null;

  // Broadcast move to opponent
  const opponent = getPlayerBySide(room, turn === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'move', { san: move.san, fen, clocks: clockPayload });
  }

  // Send clock confirmation to mover
  if (player.ws && clockPayload) {
    send(player.ws, 'move_ack', { clocks: clockPayload });
  }

  // Check for game end
  if (room.chess.isGameOver()) {
    let result, reason;
    if (room.chess.isCheckmate()) {
      result = turn === 'w' ? '1-0' : '0-1';
      reason = 'checkmate';
    } else if (room.chess.isDraw()) {
      result = '1/2-1/2';
      if (room.chess.isStalemate()) reason = 'stalemate';
      else if (room.chess.isThreefoldRepetition()) reason = 'repetition';
      else if (room.chess.isInsufficientMaterial()) reason = 'insufficient';
      else reason = 'fifty-move';
    }
    finishGame(room, result, reason);
  }

  return { ok: true };
}

function handleResign(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  const result = side === 'w' ? '0-1' : '1-0';
  finishGame(room, result, 'resignation');
}

function handleDrawOffer(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'draw_offered', {});
  }
}

function handleDrawResponse(sessionId, accept) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  if (accept) {
    finishGame(room, '1/2-1/2', 'agreement');
  } else {
    const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
    if (opponent && opponent.ws) {
      send(opponent.ws, 'draw_declined', {});
    }
  }
}

function handleRematchOffer(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room || room.status !== 'finished') return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  room.rematchOfferedBy = side;
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'rematch_offered', {});
  }
}

function handleRematchResponse(sessionId, accept) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room || room.status !== 'finished') return;

  if (!accept) {
    const side = getPlayerSide(room, sessionId);
    const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
    if (opponent && opponent.ws) {
      send(opponent.ws, 'rematch_declined', {});
    }
    return;
  }

  // Swap colors and start new game
  clearTimeout(room.cleanupTimer);
  const oldWhite = room.white;
  const oldBlack = room.black;

  room.white = { ws: oldBlack.ws, sessionId: oldBlack.sessionId, name: oldBlack.name, connected: oldBlack.connected };
  room.black = { ws: oldWhite.ws, sessionId: oldWhite.sessionId, name: oldWhite.name, connected: oldWhite.connected };
  room.chess = new Chess();
  room.moves = [];
  room.status = 'playing';
  room.rematchOfferedBy = null;

  // Reset clocks
  const tc = parseTimeControl(room.timeControl);
  if (tc) {
    const timeMs = tc.minutes * 60 * 1000;
    room.clocks = { w: timeMs, b: timeMs, increment: tc.increment * 1000, lastMoveAt: Date.now() };
  }

  // Create new DB game
  room.dbGameId = createGame({
    gameType: 'multiplayer',
    timeControl: room.timeControl,
    startingFen: room.chess.fen(),
    white: { name: room.white.name, isAI: false, elo: null, engineId: null },
    black: { name: room.black.name, isAI: false, elo: null, engineId: null },
  });

  const startPayload = {
    roomId: room.id,
    fen: room.chess.fen(),
    timeControl: room.timeControl,
  };

  send(room.white.ws, 'rematch_start', { ...startPayload, color: 'w', opponentName: room.black.name });
  send(room.black.ws, 'rematch_start', { ...startPayload, color: 'b', opponentName: room.white.name });
}

function handleDisconnect(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  const player = getPlayerBySide(room, side);
  player.connected = false;
  player.ws = null;
  player.disconnectedAt = Date.now();

  if (room.status === 'waiting') {
    // Creator disconnected before anyone joined — remove room
    cleanupRoom(roomId);
    return;
  }

  // Notify opponent
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'opponent_disconnected', { timeout: DISCONNECT_GRACE_PERIOD / 1000 });
  }

  // Start grace period
  if (!room.disconnectTimer) {
    room.disconnectTimer = setTimeout(() => {
      // Check if still disconnected
      const p = getPlayerBySide(room, side);
      if (!p.connected && room.status === 'playing') {
        const result = side === 'w' ? '0-1' : '1-0';
        finishGame(room, result, 'abandoned');
      }
    }, DISCONNECT_GRACE_PERIOD);
  }
}

function attemptReconnect(ws, sessionId, room) {
  const side = getPlayerSide(room, sessionId);
  if (!side) {
    send(ws, 'error', { message: 'You are not a player in this room' });
    return null;
  }

  const player = getPlayerBySide(room, side);
  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;

  // Clear disconnect timer
  if (room.disconnectTimer) {
    clearTimeout(room.disconnectTimer);
    room.disconnectTimer = null;
  }

  // Send reconnection state
  const clockPayload = room.clocks ? { w: getCurrentClockTime(room, 'w'), b: getCurrentClockTime(room, 'b') } : null;

  send(ws, 'reconnect', {
    roomId: room.id,
    color: side,
    fen: room.chess.fen(),
    timeControl: room.timeControl,
    moves: room.moves.map(m => m.san),
    clocks: clockPayload,
    opponentName: getPlayerBySide(room, side === 'w' ? 'b' : 'w').name,
    opponentConnected: getPlayerBySide(room, side === 'w' ? 'b' : 'w').connected,
  });

  // Notify opponent
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'opponent_reconnected', {});
  }

  return room;
}

function getCurrentClockTime(room, side) {
  if (!room.clocks) return null;
  const base = room.clocks[side];
  // If it's this side's turn and clock is running, deduct elapsed time
  if (room.status === 'playing' && room.chess.turn() === side && room.clocks.lastMoveAt) {
    const elapsed = Date.now() - room.clocks.lastMoveAt;
    return Math.max(0, base - elapsed);
  }
  return base;
}

// --- Internal helpers ---

function finishGame(room, result, reason) {
  room.status = 'finished';

  // Persist result
  if (room.dbGameId) {
    endGame(room.dbGameId, result, reason);
  }

  // Broadcast game end
  const payload = { result, reason };
  if (room.white.ws) send(room.white.ws, 'game_end', payload);
  if (room.black.ws) send(room.black.ws, 'game_end', payload);

  // Schedule cleanup
  room.cleanupTimer = setTimeout(() => cleanupRoom(room.id), ROOM_TTL_AFTER_END);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.white) sessionRooms.delete(room.white.sessionId);
  if (room.black) sessionRooms.delete(room.black.sessionId);
  clearTimeout(room.cleanupTimer);
  clearTimeout(room.disconnectTimer);
  rooms.delete(roomId);
}

function getPlayerSide(room, sessionId) {
  if (room.white && room.white.sessionId === sessionId) return 'w';
  if (room.black && room.black.sessionId === sessionId) return 'b';
  return null;
}

function getPlayerBySide(room, side) {
  return side === 'w' ? room.white : room.black;
}

function send(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return; // 1 = OPEN
  try {
    ws.send(JSON.stringify({ type, payload }));
  } catch (e) {
    // Connection may have closed between check and send
  }
}

function getRoomForSession(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  return roomId ? rooms.get(roomId) : null;
}

function getRoomCount() {
  return rooms.size;
}

module.exports = {
  createRoom,
  joinRoom,
  makeMove,
  handleResign,
  handleDrawOffer,
  handleDrawResponse,
  handleRematchOffer,
  handleRematchResponse,
  handleDisconnect,
  getRoomForSession,
  getRoomCount,
  sessionRooms,
};
