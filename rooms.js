const { Chess } = require('chess.js');
const { createGame, addMove, endGame } = require('./db');

// In-memory room store
const rooms = new Map();

// Session → room mapping for reconnection
const sessionRooms = new Map();

const ROOM_CODE_LENGTH = 6;
const ROOM_TTL_AFTER_END = 5 * 60 * 1000;     // 5 min
const DISCONNECT_GRACE_PERIOD = 60 * 1000;      // 60s
const WAITING_ROOM_TTL = 30 * 60 * 1000;        // 30 min grace for pending rooms

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

function generateChess960FEN() {
  const pieces = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  let backRank;
  let valid = false;
  while (!valid) {
    // Fisher-Yates shuffle
    backRank = pieces.slice();
    for (let i = backRank.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [backRank[i], backRank[j]] = [backRank[j], backRank[i]];
    }
    const kingPos = backRank.indexOf('k');
    const rook1Pos = backRank.indexOf('r');
    const rook2Pos = backRank.lastIndexOf('r');
    const bishop1Pos = backRank.indexOf('b');
    const bishop2Pos = backRank.lastIndexOf('b');
    const bishopsOnOppositeColors = (bishop1Pos % 2) !== (bishop2Pos % 2);
    const kingBetweenRooks = rook1Pos < kingPos && kingPos < rook2Pos;
    valid = bishopsOnOppositeColors && kingBetweenRooks;
  }
  const rank8 = backRank.join('');
  const rank1 = backRank.join('').toUpperCase();
  return `${rank8}/pppppppp/8/8/8/8/PPPPPPPP/${rank1} w - - 0 1`;
}

function parseTimeControl(tc) {
  if (!tc || tc === 'none') return null;
  // Symmetric format: "5+0", "10+5", "3+2", etc.
  const symMatch = tc.match(/^(\d+)\+(\d+)$/);
  if (symMatch) {
    const min = parseInt(symMatch[1], 10);
    return { whiteMinutes: min, blackMinutes: min, increment: parseInt(symMatch[2], 10) };
  }
  // Asymmetric/odds format: "10/5+3" (white 10 min, black 5 min, 3 sec increment)
  const oddsMatch = tc.match(/^(\d+)\/(\d+)\+(\d+)$/);
  if (oddsMatch) {
    return {
      whiteMinutes: parseInt(oddsMatch[1], 10),
      blackMinutes: parseInt(oddsMatch[2], 10),
      increment:    parseInt(oddsMatch[3], 10),
    };
  }
  return null;
}

function createRoom(ws, sessionId, name, timeControl, camMode, chess960) {
  const roomId = generateRoomCode();
  // "any" defaults to 5+0 for room creation
  const effectiveTc = timeControl === 'any' ? '5+0' : timeControl;
  const tc = parseTimeControl(effectiveTc);
  const whiteMsBase = tc ? tc.whiteMinutes * 60 * 1000 : 0;
  const blackMsBase = tc ? tc.blackMinutes * 60 * 1000 : 0;

  const is960 = !!chess960;
  const startFen = is960 ? generateChess960FEN() : undefined;
  const effectiveCamMode = ['none', 'king-cam', 'board-face'].includes(camMode) ? camMode : 'none';

  const room = {
    id: roomId,
    white: { ws, sessionId, name: name || 'Opponent', connected: true, videoReady: false },
    black: null,
    chess: startFen ? new Chess(startFen) : new Chess(),
    startingFen: startFen || null,
    timeControl: effectiveTc || 'none',
    clocks: tc ? { w: whiteMsBase, b: blackMsBase, increment: tc.increment * 1000, lastMoveAt: null } : null,
    moves: [],
    status: 'waiting',
    dbGameId: null,
    createdAt: Date.now(),
    cleanupTimer: null,
    camMode: effectiveCamMode,
    videoEnabled: effectiveCamMode !== 'none', // backward compat
    chess960: is960,
    creatorSessionId: sessionId,
  };

  rooms.set(roomId, room);
  sessionRooms.set(sessionId, roomId);

  send(ws, 'room_created', { roomId, color: 'w', camMode: room.camMode, videoEnabled: room.videoEnabled });
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
    if (room.status === 'lobby') {
      return attemptLobbyReconnect(ws, sessionId, room);
    }
    send(ws, 'error', { message: 'Room is not accepting players' });
    return null;
  }
  if (room.white.sessionId === sessionId) {
    // Creator reconnecting to their waiting room
    room.white.ws = ws;
    room.white.connected = true;
    if (room.waitingCleanupTimer) {
      clearTimeout(room.waitingCleanupTimer);
      room.waitingCleanupTimer = null;
    }
    send(ws, 'room_created', { roomId: room.id, color: 'w' });
    return room;
  }

  // Randomly assign colors — 50/50 chance creator gets white or black
  const joiner = { ws, sessionId, name: name || 'Opponent', connected: true, videoReady: false };
  const creator = room.white;
  if (Math.random() < 0.5) {
    room.white = joiner;
    room.black = creator;
  } else {
    room.black = joiner;
  }
  room.status = 'lobby';
  room.ready = { w: false, b: false };
  sessionRooms.set(sessionId, roomId);

  const lobbyPayload = {
    roomId: room.id,
    settings: { timeControl: room.timeControl, chess960: room.chess960, videoEnabled: room.videoEnabled },
    white: { name: room.white.name, ready: false },
    black: { name: room.black.name, ready: false },
  };

  send(room.white.ws, 'lobby_joined', { ...lobbyPayload, color: 'w', opponentName: room.black.name });
  send(room.black.ws, 'lobby_joined', { ...lobbyPayload, color: 'b', opponentName: room.white.name });

  return room;
}

function handleSettingChange(sessionId, field, value) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') return;

  const validFields = ['timeControl', 'chess960', 'colorSwap'];
  if (!validFields.includes(field)) return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  // Apply the change immediately
  if (field === 'timeControl') {
    room.timeControl = value;
    const tc = parseTimeControl(value);
    if (tc) {
      room.clocks = { w: tc.whiteMinutes * 60 * 1000, b: tc.blackMinutes * 60 * 1000, increment: tc.increment * 1000, lastMoveAt: null };
    } else {
      room.clocks = null;
    }
  } else if (field === 'chess960') {
    room.chess960 = !!value;
    if (room.chess960) {
      const newFen = generateChess960FEN();
      room.chess = new Chess(newFen);
      room.startingFen = newFen;
    } else {
      room.chess = new Chess();
      room.startingFen = null;
    }
  } else if (field === 'colorSwap') {
    const oldWhite = room.white;
    const oldBlack = room.black;
    room.white = { ...oldBlack };
    room.black = { ...oldWhite };
  }

  // Reset ready states on any change
  room.ready = { w: false, b: false };

  const updatedSettings = {
    timeControl: room.timeControl,
    chess960: room.chess960,
    videoEnabled: room.videoEnabled,
  };

  send(room.white.ws, 'setting_changed', { field, settings: updatedSettings, ready: { w: false, b: false }, color: 'w', changedBy: side });
  send(room.black.ws, 'setting_changed', { field, settings: updatedSettings, ready: { w: false, b: false }, color: 'b', changedBy: side });
}

function handlePlayerReady(sessionId, ready) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  room.ready[side] = ready;

  send(room.white.ws, 'ready_state', { w: room.ready.w, b: room.ready.b });
  send(room.black.ws, 'ready_state', { w: room.ready.w, b: room.ready.b });

  if (room.ready.w && room.ready.b) {
    startGameFromLobby(room);
  }
}

function startGameFromLobby(room) {
  room.status = 'playing';

  // For odds TC: if creator ended up as black, swap clocks and TC string so
  // white/black values correctly reflect each player's actual starting time
  const oddsMatch = room.timeControl.match(/^(\d+)\/(\d+)\+(\d+)$/);
  if (oddsMatch && room.clocks && room.black.sessionId === room.creatorSessionId) {
    const temp = room.clocks.w;
    room.clocks.w = room.clocks.b;
    room.clocks.b = temp;
    room.timeControl = `${oddsMatch[2]}/${oddsMatch[1]}+${oddsMatch[3]}`;
  }

  // Create database game record
  room.dbGameId = createGame({
    gameType: 'multiplayer',
    timeControl: room.timeControl,
    startingFen: room.chess.fen(),
    white: { name: room.white.name, isAI: false, elo: null, engineId: null },
    black: { name: room.black.name, isAI: false, elo: null, engineId: null },
  });

  if (room.clocks) {
    room.clocks.lastMoveAt = Date.now();
  }

  const startPayload = {
    roomId: room.id,
    fen: room.chess.fen(),
    timeControl: room.timeControl,
    chess960: room.chess960,
    dbGameId: room.dbGameId,
  };

  send(room.white.ws, 'game_start', { ...startPayload, color: 'w', opponentName: room.black.name, camMode: room.camMode, videoEnabled: room.videoEnabled });
  send(room.black.ws, 'game_start', { ...startPayload, color: 'b', opponentName: room.white.name, camMode: room.camMode, videoEnabled: room.videoEnabled });
}

function attemptLobbyReconnect(ws, sessionId, room) {
  const side = getPlayerSide(room, sessionId);
  if (!side) {
    send(ws, 'error', { message: 'You are not a player in this room' });
    return null;
  }

  const player = getPlayerBySide(room, side);
  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;

  sessionRooms.set(sessionId, room.id);

  if (room.disconnectTimer) {
    clearTimeout(room.disconnectTimer);
    room.disconnectTimer = null;
  }

  const lobbyPayload = {
    roomId: room.id,
    settings: { timeControl: room.timeControl, chess960: room.chess960, videoEnabled: room.videoEnabled },
    white: { name: room.white.name, ready: room.ready.w },
    black: { name: room.black.name, ready: room.ready.b },
  };
  send(ws, 'lobby_joined', { ...lobbyPayload, color: side, opponentName: getPlayerBySide(room, side === 'w' ? 'b' : 'w').name });

  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'opponent_reconnected', {});
  }

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
  room.review = null; // Clear review state on rematch
  const oldWhite = room.white;
  const oldBlack = room.black;

  room.white = { ws: oldBlack.ws, sessionId: oldBlack.sessionId, name: oldBlack.name, connected: oldBlack.connected };
  room.black = { ws: oldWhite.ws, sessionId: oldWhite.sessionId, name: oldWhite.name, connected: oldWhite.connected };
  const rematchFen = room.chess960 ? generateChess960FEN() : undefined;
  room.chess = rematchFen ? new Chess(rematchFen) : new Chess();
  room.moves = [];
  room.status = 'playing';
  room.rematchOfferedBy = null;

  // Reset clocks
  const tc = parseTimeControl(room.timeControl);
  if (tc) {
    room.clocks = {
      w: tc.whiteMinutes * 60 * 1000,
      b: tc.blackMinutes * 60 * 1000,
      increment: tc.increment * 1000,
      lastMoveAt: Date.now(),
    };
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
    chess960: room.chess960,
    dbGameId: room.dbGameId,
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
    // Creator disconnected — keep room alive with a grace period
    if (!room.waitingCleanupTimer) {
      room.waitingCleanupTimer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.status === 'waiting' && !r.white.connected) {
          cleanupRoom(roomId);
        }
      }, WAITING_ROOM_TTL);
    }
    return;
  }

  if (room.status === 'lobby') {
    // Keep lobby alive — same grace period as waiting
    if (!room.disconnectTimer) {
      room.disconnectTimer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.status === 'lobby') {
          cleanupRoom(roomId);
        }
      }, DISCONNECT_GRACE_PERIOD);
    }
    const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
    if (opponent && opponent.ws) {
      send(opponent.ws, 'opponent_disconnected', { timeout: DISCONNECT_GRACE_PERIOD / 1000 });
    }
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

  // Restore session→room mapping (defensive: handles edge cases where it was lost)
  sessionRooms.set(sessionId, room.id);

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
    startingFen: room.startingFen,
    timeControl: room.timeControl,
    moves: room.moves.map(m => m.san),
    clocks: clockPayload,
    opponentName: getPlayerBySide(room, side === 'w' ? 'b' : 'w').name,
    opponentConnected: getPlayerBySide(room, side === 'w' ? 'b' : 'w').connected,
    camMode: room.camMode,
    videoEnabled: room.videoEnabled,
    chess960: room.chess960,
    dbGameId: room.dbGameId,
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

  // Initialize shared review state
  room.review = {
    players: new Set(),
    currentPly: -1,
    analysisProvider: null,
  };

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
  clearTimeout(room.waitingCleanupTimer);
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

/**
 * Fallback room lookup by scanning all active rooms.
 * Used when sessionRooms mapping is missing due to edge cases.
 * Also restores the mapping if found.
 */
function findRoomBySession(sessionId) {
  for (const room of rooms.values()) {
    if (room.status !== 'playing' && room.status !== 'waiting' && room.status !== 'lobby') continue;
    if (room.white?.sessionId === sessionId || room.black?.sessionId === sessionId) {
      sessionRooms.set(sessionId, room.id);
      return room;
    }
  }
  return null;
}

function getRoomCount() {
  return rooms.size;
}

/**
 * List all rooms where the session is a participant (waiting or playing).
 * Returns serializable room summaries (no ws references).
 */
function listRoomsForSession(sessionId) {
  const result = [];
  for (const room of rooms.values()) {
    const side = getPlayerSide(room, sessionId);
    if (!side) continue;
    if (room.status !== 'waiting' && room.status !== 'playing' && room.status !== 'lobby') continue;
    result.push({
      roomId: room.id,
      status: room.status,
      timeControl: room.timeControl,
      createdAt: room.createdAt,
      color: side,
      moveCount: room.moves.length,
      white: { name: room.white.name },
      black: room.black ? { name: room.black.name } : null,
      dbGameId: room.dbGameId,
    });
  }
  return result;
}

/**
 * Cancel a waiting room owned by the session.
 * Returns true if cancelled, false if not found or not allowed.
 */
function cancelRoom(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return false;

  const room = rooms.get(roomId);
  if (!room || room.status !== 'waiting') return false;
  if (room.white.sessionId !== sessionId) return false;

  cleanupRoom(roomId);
  return true;
}

// --- WebRTC video signaling ---

function relaySignaling(sessionId, type, payload) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const side = getPlayerSide(room, sessionId);
  if (!side) return;
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, type, payload);
  }
}

function handleVideoReady(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.videoEnabled) return;
  const side = getPlayerSide(room, sessionId);
  if (!side) return;
  const player = getPlayerBySide(room, side);
  player.videoReady = true;
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.videoReady) {
    // White is always the WebRTC initiator (creates the offer)
    send(room.white.ws, 'video_start', { initiator: true });
    send(room.black.ws, 'video_start', { initiator: false });
  } else if (opponent && opponent.ws) {
    send(opponent.ws, 'video_peer_ready', {});
  }
}

// --- Shared post-game review ---

function handleReviewEnter(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || room.status !== 'finished' || !room.review) return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  room.review.players.add(side);
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'review_entered', { side });
  }
}

function handleReviewNavigate(sessionId, ply) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.review) return;

  const side = getPlayerSide(room, sessionId);
  if (!side || !room.review.players.has(side)) return;

  room.review.currentPly = ply;
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws && room.review.players.has(side === 'w' ? 'b' : 'w')) {
    send(opponent.ws, 'review_navigate', { ply, side });
  }
}

function handleReviewArrow(sessionId, action, from, to) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.review) return;

  const side = getPlayerSide(room, sessionId);
  if (!side || !room.review.players.has(side)) return;

  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws && room.review.players.has(side === 'w' ? 'b' : 'w')) {
    send(opponent.ws, 'review_arrow', { action, from, to, side });
  }
}

function handleReviewClearArrows(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.review) return;

  const side = getPlayerSide(room, sessionId);
  if (!side || !room.review.players.has(side)) return;

  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws && room.review.players.has(side === 'w' ? 'b' : 'w')) {
    send(opponent.ws, 'review_clear_arrows', { side });
  }
}

function handleReviewAnalysisStarted(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.review) return;

  const side = getPlayerSide(room, sessionId);
  if (!side || !room.review.players.has(side)) return;

  room.review.analysisProvider = side;
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws && room.review.players.has(side === 'w' ? 'b' : 'w')) {
    send(opponent.ws, 'review_analysis_started', { side });
  }
}

function handleReviewAnalysis(sessionId, data) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.review) return;

  const side = getPlayerSide(room, sessionId);
  if (!side || !room.review.players.has(side)) return;

  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws && room.review.players.has(side === 'w' ? 'b' : 'w')) {
    send(opponent.ws, 'review_analysis', data);
  }
}

function handleReviewExit(sessionId) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || !room.review) return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  room.review.players.delete(side);
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'review_exited', { side });
  }
}

module.exports = {
  createRoom,
  joinRoom,
  handleSettingChange,
  handlePlayerReady,
  makeMove,
  handleResign,
  handleDrawOffer,
  handleDrawResponse,
  handleRematchOffer,
  handleRematchResponse,
  handleDisconnect,
  relaySignaling,
  handleVideoReady,
  handleReviewEnter,
  handleReviewNavigate,
  handleReviewArrow,
  handleReviewClearArrows,
  handleReviewAnalysisStarted,
  handleReviewAnalysis,
  handleReviewExit,
  getRoomForSession,
  findRoomBySession,
  getRoomCount,
  listRoomsForSession,
  cancelRoom,
  sessionRooms,
};
