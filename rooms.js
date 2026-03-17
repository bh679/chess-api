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
    return { creatorMinutes: min, opponentMinutes: min, increment: parseInt(symMatch[2], 10) };
  }
  // Asymmetric/odds format: "10/5+3" (creator 10 min, opponent 5 min, 3 sec increment)
  const oddsMatch = tc.match(/^(\d+)\/(\d+)\+(\d+)$/);
  if (oddsMatch) {
    return {
      creatorMinutes: parseInt(oddsMatch[1], 10),
      opponentMinutes: parseInt(oddsMatch[2], 10),
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
  const creatorMsBase = tc ? tc.creatorMinutes * 60 * 1000 : 0;
  const opponentMsBase = tc ? tc.opponentMinutes * 60 * 1000 : 0;

  const is960 = !!chess960;
  const startFen = is960 ? generateChess960FEN() : undefined;
  const effectiveCamMode = ['none', 'king-cam', 'board-face', 'tile-cam', 'split-cam', 'split-cam-h'].includes(camMode) ? camMode : 'none';

  const room = {
    id: roomId,
    white: { ws, sessionId, name: name || 'Opponent', connected: true, videoReady: false },
    black: null,
    chess: startFen ? new Chess(startFen) : new Chess(),
    startingFen: startFen || null,
    timeControl: effectiveTc || 'none',
    clocks: tc ? { creator: creatorMsBase, opponent: opponentMsBase, increment: tc.increment * 1000, lastMoveAt: null } : null,
    moves: [],
    status: 'waiting',
    dbGameId: null,
    createdAt: Date.now(),
    cleanupTimer: null,
    camMode: effectiveCamMode,
    videoEnabled: effectiveCamMode !== 'none', // backward compat
    chess960: is960,
    creatorSessionId: sessionId,
    isPublic: false,
    colorPreference: 'random', // 'white' | 'black' | 'random'
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

  // Assign colors based on creator's preference (or random if unset)
  const joiner = { ws, sessionId, name: name || 'Opponent', connected: true, videoReady: false };
  const creator = room.white;
  const creatorGetsWhite = room.colorPreference === 'white' ? true
    : room.colorPreference === 'black' ? false
    : Math.random() < 0.5;
  if (creatorGetsWhite) {
    room.black = joiner;
    // room.white is already the creator
  } else {
    room.white = joiner;
    room.black = creator;
  }
  room.status = 'lobby';
  room.ready = { w: false, b: false };
  sessionRooms.set(sessionId, roomId);

  const lobbyPayload = {
    roomId: room.id,
    settings: { timeControl: room.timeControl, chess960: room.chess960, videoEnabled: room.videoEnabled, camMode: room.camMode },
    white: { name: room.white.name, ready: false },
    black: { name: room.black.name, ready: false },
  };

  send(room.white.ws, 'lobby_joined', { ...lobbyPayload, color: 'w', opponentName: room.black.name, isCreator: room.white.sessionId === room.creatorSessionId });
  send(room.black.ws, 'lobby_joined', { ...lobbyPayload, color: 'b', opponentName: room.white.name, isCreator: room.black.sessionId === room.creatorSessionId });

  return room;
}

function handleSettingChange(sessionId, field, value) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || (room.status !== 'lobby' && room.status !== 'waiting')) return;

  const validFields = ['timeControl', 'chess960', 'colorSwap', 'camMode', 'colorPreference'];
  if (!validFields.includes(field)) return;

  // colorSwap requires two players
  if (field === 'colorSwap' && room.status === 'waiting') return;

  const side = getPlayerSide(room, sessionId);
  if (!side) return;

  // Apply the change immediately
  if (field === 'timeControl') {
    room.timeControl = value;
    const tc = parseTimeControl(value);
    if (tc) {
      room.clocks = { creator: tc.creatorMinutes * 60 * 1000, opponent: tc.opponentMinutes * 60 * 1000, increment: tc.increment * 1000, lastMoveAt: null };
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
  } else if (field === 'camMode') {
    const validCamModes = ['none', 'king-cam', 'board-face', 'tile-cam', 'split-cam', 'split-cam-h'];
    if (validCamModes.includes(value)) {
      room.camMode = value;
      room.videoEnabled = value !== 'none';
    }
  } else if (field === 'colorPreference') {
    if (['white', 'black', 'random'].includes(value)) {
      room.colorPreference = value;
    }
  }

  // While waiting: just acknowledge the change back to the creator
  if (room.status === 'waiting') {
    const updatedSettings = {
      timeControl: room.timeControl,
      chess960: room.chess960,
      videoEnabled: room.videoEnabled,
      colorPreference: room.colorPreference,
    };
    send(room.white.ws, 'setting_changed', { field, settings: updatedSettings, ready: { w: false, b: false }, color: 'w', changedBy: 'w' });
    return;
  }

  // Reset ready states on any change
  room.ready = { w: false, b: false };

  const updatedSettings = {
    timeControl: room.timeControl,
    chess960: room.chess960,
    videoEnabled: room.videoEnabled,
    camMode: room.camMode,
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

  // Reassign colors based on colorPreference at game start
  const creatorIsCurrentlyWhite = room.white.sessionId === room.creatorSessionId;
  const pref = room.colorPreference ?? 'random';
  const creatorShouldBeWhite = pref === 'white' ? true
    : pref === 'black' ? false
    : Math.random() < 0.5;
  if (creatorIsCurrentlyWhite !== creatorShouldBeWhite) {
    const tmp = room.white;
    room.white = room.black;
    room.black = tmp;
  }

  // Map creator/opponent clock times to w/b based on which color the creator was assigned
  if (room.clocks) {
    const creatorIsWhite = room.white.sessionId === room.creatorSessionId;
    room.clocks = {
      w: creatorIsWhite ? room.clocks.creator : room.clocks.opponent,
      b: creatorIsWhite ? room.clocks.opponent : room.clocks.creator,
      increment: room.clocks.increment,
      lastMoveAt: null,
    };
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

  send(room.white.ws, 'game_start', { ...startPayload, color: 'w', opponentName: room.black.name, camMode: room.camMode, videoEnabled: room.videoEnabled, isCreator: room.white.sessionId === room.creatorSessionId });
  send(room.black.ws, 'game_start', { ...startPayload, color: 'b', opponentName: room.white.name, camMode: room.camMode, videoEnabled: room.videoEnabled, isCreator: room.black.sessionId === room.creatorSessionId });
}

function attemptLobbyReconnect(ws, sessionId, room) {
  const side = getPlayerSide(room, sessionId);
  if (!side) {
    send(ws, 'error', { message: 'You are not a player in this room' });
    return null;
  }

  // Log lobby reconnection for debugging mid-game reset issues
  console.log(`[rooms] attemptLobbyReconnect: session=${sessionId.slice(0, 8)} room=${room.id} side=${side} status=${room.status} moves=${room.moves?.length || 0}`);

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
    settings: { timeControl: room.timeControl, chess960: room.chess960, videoEnabled: room.videoEnabled, camMode: room.camMode },
    white: { name: room.white.name, ready: room.ready.w },
    black: { name: room.black.name, ready: room.ready.b },
  };
  send(ws, 'lobby_joined', { ...lobbyPayload, color: side, opponentName: getPlayerBySide(room, side === 'w' ? 'b' : 'w').name, isCreator: sessionId === room.creatorSessionId });

  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'opponent_reconnected', {});
  }

  return room;
}

// Returns { error } on failure, or { move, turn } on success (move already applied to room.chess)
function validateMove(room, sessionId, san) {
  if (!room || room.status !== 'playing') return { error: 'Game not in progress' };
  const turn = room.chess.turn();
  const player = getPlayerBySide(room, turn);
  if (!player || player.sessionId !== sessionId) return { error: 'Not your turn' };
  let move;
  try {
    move = room.chess.move(san);
  } catch (e) {
    return { error: 'Invalid move' };
  }
  if (!move) return { error: 'Invalid move' };
  return { move, turn };
}

// Decrements the active clock, adds increment, updates lastMoveAt.
// Returns { timedOut: true, result, reason } on timeout, else { timedOut: false }.
function updateClock(room, turn, now) {
  if (!room.clocks) return { timedOut: false };
  if (room.moves.length > 0) {
    const elapsed = now - room.clocks.lastMoveAt;
    room.clocks[turn] -= elapsed;
    if (room.clocks[turn] <= 0) {
      room.clocks[turn] = 0;
      const winner = turn === 'w' ? 'b' : 'w';
      const result = winner === 'w' ? '1-0' : '0-1';
      return { timedOut: true, result, reason: 'timeout' };
    }
    room.clocks[turn] += room.clocks.increment;
  }
  room.clocks.lastMoveAt = now;
  return { timedOut: false };
}

// Calls finishGame if the position is game-over. turn = side that just moved.
function checkGameEnd(room, turn) {
  if (!room.chess.isGameOver()) return;
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

function makeMove(sessionId, san) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return { error: 'Not in a room' };

  const room = rooms.get(roomId);
  const validation = validateMove(room, sessionId, san);
  if (validation.error) return { error: validation.error };
  const { move, turn } = validation;

  const now = Date.now();
  const fen = room.chess.fen();

  const clockUpdate = updateClock(room, turn, now);
  if (clockUpdate.timedOut) {
    finishGame(room, clockUpdate.result, clockUpdate.reason);
    return { ok: true };
  }

  // Record move
  const moveRecord = { ply: room.moves.length, san: move.san, fen, timestamp: now, side: turn };
  room.moves.push(moveRecord);
  if (room.dbGameId) addMove(room.dbGameId, moveRecord);

  // Broadcast
  const clockPayload = room.clocks ? { w: room.clocks.w, b: room.clocks.b } : null;
  const opponent = getPlayerBySide(room, turn === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) send(opponent.ws, 'move', { san: move.san, fen, clocks: clockPayload });
  const player = getPlayerBySide(room, turn);
  if (player.ws && clockPayload) send(player.ws, 'move_ack', { clocks: clockPayload });

  checkGameEnd(room, turn);
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

  // Create a fresh room with same settings, swapped colors
  clearTimeout(room.cleanupTimer);
  const oldWhite = room.white;
  const oldBlack = room.black;

  // Colors swap on rematch
  const newWhite = { ws: oldBlack.ws, sessionId: oldBlack.sessionId, name: oldBlack.name, connected: oldBlack.connected, videoReady: false };
  const newBlack = { ws: oldWhite.ws, sessionId: oldWhite.sessionId, name: oldWhite.name, connected: oldWhite.connected, videoReady: false };

  const rematchFen = room.chess960 ? generateChess960FEN() : undefined;
  const tc = parseTimeControl(room.timeControl);
  const creatorIsWhite = newWhite.sessionId === room.creatorSessionId;

  const newRoom = {
    id: generateRoomCode(),
    white: newWhite,
    black: newBlack,
    chess: rematchFen ? new Chess(rematchFen) : new Chess(),
    startingFen: rematchFen || null,
    timeControl: room.timeControl,
    clocks: tc ? {
      w: (creatorIsWhite ? tc.creatorMinutes : tc.opponentMinutes) * 60 * 1000,
      b: (creatorIsWhite ? tc.opponentMinutes : tc.creatorMinutes) * 60 * 1000,
      increment: tc.increment * 1000,
      lastMoveAt: Date.now(),
    } : null,
    moves: [],
    status: 'playing',
    dbGameId: null,
    createdAt: Date.now(),
    cleanupTimer: null,
    camMode: room.camMode,
    videoEnabled: room.videoEnabled,
    chess960: room.chess960,
    creatorSessionId: room.creatorSessionId,
    isPublic: false,
    colorPreference: room.colorPreference,
    rematchOfferedBy: null,
    review: null,
  };

  // Register new room and clean up old one
  rooms.set(newRoom.id, newRoom);
  sessionRooms.set(newWhite.sessionId, newRoom.id);
  sessionRooms.set(newBlack.sessionId, newRoom.id);
  rooms.delete(room.id);

  // Create new DB game
  newRoom.dbGameId = createGame({
    gameType: 'multiplayer',
    timeControl: newRoom.timeControl,
    startingFen: newRoom.chess.fen(),
    white: { name: newRoom.white.name, isAI: false, elo: null, engineId: null },
    black: { name: newRoom.black.name, isAI: false, elo: null, engineId: null },
  });

  const startPayload = {
    roomId: newRoom.id,
    fen: newRoom.chess.fen(),
    timeControl: newRoom.timeControl,
    chess960: newRoom.chess960,
    dbGameId: newRoom.dbGameId,
    videoEnabled: newRoom.videoEnabled,
  };

  send(newRoom.white.ws, 'rematch_start', { ...startPayload, color: 'w', opponentName: newRoom.black.name, isCreator: newRoom.white.sessionId === newRoom.creatorSessionId });
  send(newRoom.black.ws, 'rematch_start', { ...startPayload, color: 'b', opponentName: newRoom.white.name, isCreator: newRoom.black.sessionId === newRoom.creatorSessionId });
}

function getGracePeriod(room, side) {
  if (room.clocks) {
    const remaining = getCurrentClockTime(room, side);
    return Math.max(remaining, 10_000);
  }
  return 10 * 60 * 1000;
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
  const gracePeriod = getGracePeriod(room, side);
  const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
  if (opponent && opponent.ws) {
    send(opponent.ws, 'opponent_disconnected', { timeout: Math.ceil(gracePeriod / 1000) });
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
    }, gracePeriod);
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
    isCreator: sessionId === room.creatorSessionId,
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
  if (!room) return false;

  // Allow cancelling waiting rooms (by creator) and lobby rooms (by either player)
  if (room.status === 'waiting') {
    if (room.white.sessionId !== sessionId) return false;
  } else if (room.status === 'lobby') {
    const side = getPlayerSide(room, sessionId);
    if (!side) return false;
    // Notify the other player before cleanup
    const opponent = getPlayerBySide(room, side === 'w' ? 'b' : 'w');
    if (opponent && opponent.ws) {
      send(opponent.ws, 'room_cancelled', {});
    }
  } else {
    return false;
  }

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
  if (player.videoReady) return;
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

/**
 * Toggle public visibility for a waiting room.
 * Only the room creator can change this, and only while in 'waiting' status.
 */
function setPublicRoom(sessionId, isPublic) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return { error: 'Not in a room' };
  const room = rooms.get(roomId);
  if (!room || room.status !== 'waiting') return { error: 'Room is not in waiting state' };
  if (room.creatorSessionId !== sessionId) return { error: 'Only the room creator can change visibility' };
  room.isPublic = !!isPublic;
  return { ok: true, isPublic: room.isPublic };
}

/**
 * List all public waiting rooms (for lobby discovery).
 * Excludes the requesting session's own rooms.
 */
function updatePlayerName(sessionId, name) {
  const roomId = sessionRooms.get(sessionId);
  if (!roomId) return { updated: false };
  const room = rooms.get(roomId);
  if (!room) return { updated: false };
  const side = getPlayerSide(room, sessionId);
  if (!side) return { updated: false };
  const player = getPlayerBySide(room, side);
  player.name = name || '';
  const isPublicWaiting = room.isPublic && room.status === 'waiting';
  return { updated: true, isPublicWaiting };
}

function listPublicRooms(excludeSessionId) {
  const result = [];
  for (const room of rooms.values()) {
    if (room.status !== 'waiting' || !room.isPublic) continue;
    if (excludeSessionId && room.creatorSessionId === excludeSessionId) continue;
    result.push({
      roomId: room.id,
      timeControl: room.timeControl,
      chess960: room.chess960,
      camMode: room.camMode,
      hostName: room.white.name,
      camMode: room.camMode,
      createdAt: room.createdAt,
    });
  }
  return result;
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
  setPublicRoom,
  listPublicRooms,
  updatePlayerName,
  sessionRooms,
};
