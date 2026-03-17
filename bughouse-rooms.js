const { Chess } = require('chess.js');
const { createGame, addMove, endGame } = require('./db');
const {
  createBoardPools,
  addCapturedPiece,
  removePieceFromPool,
  validateDrop,
  applyDrop,
  dropToSan,
} = require('./bughouse-logic');

// In-memory bughouse room store
const bughouseRooms = new Map();

// Session → bughouse room mapping for reconnection
const bughouseSessionRooms = new Map();

const ROOM_CODE_LENGTH = 6;
const ROOM_TTL_AFTER_END = 5 * 60 * 1000;
const DISCONNECT_GRACE_PERIOD = 60 * 1000;
const WAITING_ROOM_TTL = 30 * 60 * 1000;

// --- Helpers ---

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (bughouseRooms.has(code));
  return code;
}

function send(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type, payload }));
  } catch (e) {
    // Connection may have closed
  }
}

function parseTimeControl(tc) {
  if (!tc || tc === 'none') return null;
  const symMatch = tc.match(/^(\d+)\+(\d+)$/);
  if (symMatch) {
    const min = parseInt(symMatch[1], 10);
    return { minutes: min, increment: parseInt(symMatch[2], 10) };
  }
  return null;
}

function broadcastToRoom(room, type, payload) {
  for (const player of Object.values(room.players)) {
    if (player && player.ws) send(player.ws, type, payload);
  }
}

function broadcastToBoard(room, boardId, type, payload) {
  for (const player of Object.values(room.players)) {
    if (player && player.board === boardId && player.ws) {
      send(player.ws, type, payload);
    }
  }
}

function getPartnerBoard(boardId) {
  return boardId === 'a' ? 'b' : 'a';
}

function getPlayerBySession(room, sessionId) {
  return room.players[sessionId] || null;
}

function getOpponent(room, sessionId) {
  const player = getPlayerBySession(room, sessionId);
  if (!player) return null;
  for (const p of Object.values(room.players)) {
    if (p.sessionId !== sessionId && p.board === player.board && p.color !== player.color) {
      return p;
    }
  }
  return null;
}

function getPartner(room, sessionId) {
  const player = getPlayerBySession(room, sessionId);
  if (!player) return null;
  for (const p of Object.values(room.players)) {
    if (p.sessionId !== sessionId && p.team === player.team) {
      return p;
    }
  }
  return null;
}

function getPlayerCount(room) {
  return Object.keys(room.players).length;
}

function getTeamPlayers(room, team) {
  return Object.values(room.players).filter(p => p.team === team);
}

function getBoardPlayers(room, boardId) {
  return Object.values(room.players).filter(p => p.board === boardId);
}

function getSerializablePlayers(room) {
  const result = {};
  for (const [sid, p] of Object.entries(room.players)) {
    result[sid] = {
      name: p.name,
      team: p.team,
      board: p.board,
      color: p.color,
      connected: p.connected,
    };
  }
  return result;
}

function getSerializablePools(room) {
  return { a: room.pools.a, b: room.pools.b };
}

// --- Room Lifecycle ---

function createBughouseRoom(ws, sessionId, name, timeControl) {
  const roomId = generateRoomCode();
  const effectiveTc = timeControl === 'any' ? '5+0' : (timeControl || '5+0');
  const tc = parseTimeControl(effectiveTc);
  const timeMs = tc ? tc.minutes * 60 * 1000 : 0;

  const room = {
    id: roomId,
    type: 'bughouse',
    status: 'waiting',
    players: {
      [sessionId]: {
        ws,
        sessionId,
        name: name || 'Player 1',
        connected: true,
        team: 'alpha',
        board: 'a',
        color: 'w',
        ready: false,
      },
    },
    boards: {
      a: {
        chess: new Chess(),
        moves: [],
        clocks: tc ? { w: timeMs, b: timeMs, increment: tc.increment * 1000, lastMoveAt: null } : null,
        dbGameId: null,
      },
      b: {
        chess: new Chess(),
        moves: [],
        clocks: tc ? { w: timeMs, b: timeMs, increment: tc.increment * 1000, lastMoveAt: null } : null,
        dbGameId: null,
      },
    },
    pools: {
      a: createBoardPools(),
      b: createBoardPools(),
    },
    timeControl: effectiveTc,
    createdAt: Date.now(),
    creatorSessionId: sessionId,
    cleanupTimer: null,
    waitingCleanupTimer: null,
    disconnectTimers: {},
    isPublic: false,
    dbMatchId: null,
  };

  bughouseRooms.set(roomId, room);
  bughouseSessionRooms.set(sessionId, roomId);

  send(ws, 'bug_room_created', {
    roomId,
    team: 'alpha',
    board: 'a',
    color: 'w',
  });

  return room;
}

function joinBughouseRoom(ws, sessionId, name, roomId) {
  const room = bughouseRooms.get(roomId.toUpperCase());
  if (!room) {
    send(ws, 'error', { message: 'Bughouse room not found' });
    return null;
  }

  // Check for reconnection
  const existingPlayer = getPlayerBySession(room, sessionId);
  if (existingPlayer) {
    return attemptBughouseReconnect(ws, sessionId, room);
  }

  if (room.status !== 'waiting') {
    if (room.status === 'playing' || room.status === 'lobby') {
      send(ws, 'error', { message: 'Room is not accepting new players' });
    } else {
      send(ws, 'error', { message: 'Room is not accepting players' });
    }
    return null;
  }

  const count = getPlayerCount(room);
  if (count >= 4) {
    send(ws, 'error', { message: 'Room is full' });
    return null;
  }

  // Assign team/board/color based on join order
  // Slot assignment: alpha-a-w, beta-a-b, beta-b-w, alpha-b-b
  // Team alpha: board A white + board B black
  // Team beta:  board A black + board B white
  const assignments = [
    { team: 'alpha', board: 'a', color: 'w' }, // slot 0 (creator)
    { team: 'beta',  board: 'a', color: 'b' }, // slot 1
    { team: 'beta',  board: 'b', color: 'w' }, // slot 2
    { team: 'alpha', board: 'b', color: 'b' }, // slot 3
  ];

  const assignment = assignments[count];

  room.players[sessionId] = {
    ws,
    sessionId,
    name: name || `Player ${count + 1}`,
    connected: true,
    team: assignment.team,
    board: assignment.board,
    color: assignment.color,
    ready: false,
  };

  bughouseSessionRooms.set(sessionId, roomId);

  // Transition to lobby when 4 players
  if (getPlayerCount(room) === 4) {
    room.status = 'lobby';
  }

  // Notify all players of current state
  const lobbyPayload = {
    roomId: room.id,
    players: getSerializablePlayers(room),
    settings: { timeControl: room.timeControl },
    status: room.status,
  };

  for (const p of Object.values(room.players)) {
    if (p.ws) {
      send(p.ws, 'bug_lobby_update', {
        ...lobbyPayload,
        you: { team: p.team, board: p.board, color: p.color },
      });
    }
  }

  return room;
}

function handleBughouseReady(sessionId, ready) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return;
  const room = bughouseRooms.get(roomId);
  if (!room || room.status !== 'lobby') return;

  const player = getPlayerBySession(room, sessionId);
  if (!player) return;

  player.ready = !!ready;

  // Broadcast ready state
  const readyState = {};
  for (const [sid, p] of Object.entries(room.players)) {
    readyState[sid] = p.ready;
  }
  broadcastToRoom(room, 'bug_ready_state', { ready: readyState });

  // Check if all 4 are ready
  const allReady = Object.values(room.players).every(p => p.ready);
  if (allReady && getPlayerCount(room) === 4) {
    startBughouseGame(room);
  }
}

function handleBughouseSettingChange(sessionId, field, value) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return;
  const room = bughouseRooms.get(roomId);
  if (!room || (room.status !== 'lobby' && room.status !== 'waiting')) return;

  if (field === 'timeControl') {
    room.timeControl = value;
    const tc = parseTimeControl(value);
    const timeMs = tc ? tc.minutes * 60 * 1000 : 0;
    room.boards.a.clocks = tc ? { w: timeMs, b: timeMs, increment: tc.increment * 1000, lastMoveAt: null } : null;
    room.boards.b.clocks = tc ? { w: timeMs, b: timeMs, increment: tc.increment * 1000, lastMoveAt: null } : null;
  }

  // Reset all ready states
  for (const p of Object.values(room.players)) {
    p.ready = false;
  }

  const lobbyPayload = {
    roomId: room.id,
    players: getSerializablePlayers(room),
    settings: { timeControl: room.timeControl },
    status: room.status,
  };

  for (const p of Object.values(room.players)) {
    if (p.ws) {
      send(p.ws, 'bug_lobby_update', {
        ...lobbyPayload,
        you: { team: p.team, board: p.board, color: p.color },
      });
    }
  }
}

function handleBughouseTeamSwap(sessionId, targetSessionId) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return;
  const room = bughouseRooms.get(roomId);
  if (!room || room.status !== 'lobby') return;

  const player1 = getPlayerBySession(room, sessionId);
  const player2 = getPlayerBySession(room, targetSessionId);
  if (!player1 || !player2 || player1.team === player2.team) return;

  // Swap team, board, and color assignments
  const temp = { team: player1.team, board: player1.board, color: player1.color };
  player1.team = player2.team;
  player1.board = player2.board;
  player1.color = player2.color;
  player2.team = temp.team;
  player2.board = temp.board;
  player2.color = temp.color;

  // Reset ready states
  for (const p of Object.values(room.players)) {
    p.ready = false;
  }

  const lobbyPayload = {
    roomId: room.id,
    players: getSerializablePlayers(room),
    settings: { timeControl: room.timeControl },
    status: room.status,
  };

  for (const p of Object.values(room.players)) {
    if (p.ws) {
      send(p.ws, 'bug_lobby_update', {
        ...lobbyPayload,
        you: { team: p.team, board: p.board, color: p.color },
      });
    }
  }
}

function startBughouseGame(room) {
  room.status = 'playing';

  const now = Date.now();

  // Create database records for both boards
  for (const boardId of ['a', 'b']) {
    const boardPlayers = getBoardPlayers(room, boardId);
    const whitePlayer = boardPlayers.find(p => p.color === 'w');
    const blackPlayer = boardPlayers.find(p => p.color === 'b');

    room.boards[boardId].dbGameId = createGame({
      gameType: 'bughouse',
      timeControl: room.timeControl,
      startingFen: room.boards[boardId].chess.fen(),
      white: { name: whitePlayer ? whitePlayer.name : 'Unknown', isAI: false, elo: null, engineId: null },
      black: { name: blackPlayer ? blackPlayer.name : 'Unknown', isAI: false, elo: null, engineId: null },
    });

    if (room.boards[boardId].clocks) {
      room.boards[boardId].clocks.lastMoveAt = now;
    }
  }

  // Build start payload
  const startPayload = {
    roomId: room.id,
    boards: {
      a: { fen: room.boards.a.chess.fen() },
      b: { fen: room.boards.b.chess.fen() },
    },
    pools: getSerializablePools(room),
    players: getSerializablePlayers(room),
    timeControl: room.timeControl,
  };

  for (const p of Object.values(room.players)) {
    if (p.ws) {
      send(p.ws, 'bug_game_start', {
        ...startPayload,
        you: { team: p.team, board: p.board, color: p.color },
      });
    }
  }
}

// --- Moves and Drops ---

function handleBughouseMove(sessionId, boardId, san) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return { error: 'Not in a room' };

  const room = bughouseRooms.get(roomId);
  if (!room || room.status !== 'playing') return { error: 'Game not in progress' };

  const player = getPlayerBySession(room, sessionId);
  if (!player) return { error: 'Not a player' };
  if (player.board !== boardId) return { error: 'Wrong board' };

  const board = room.boards[boardId];
  const turn = board.chess.turn();
  if (player.color !== turn) return { error: 'Not your turn' };

  let move;
  try {
    move = board.chess.move(san);
  } catch (e) {
    return { error: 'Invalid move' };
  }
  if (!move) return { error: 'Invalid move' };

  const now = Date.now();
  const fen = board.chess.fen();

  // Update clock
  const clockResult = updateBoardClock(board, turn, now);
  if (clockResult.timedOut) {
    finishBughouseGame(room, turn === 'w' ? 'beta' : 'alpha', boardId, clockResult.result, 'timeout');
    return { ok: true };
  }

  // Record move
  const moveRecord = { ply: board.moves.length, san: move.san, fen, timestamp: now, side: turn };
  board.moves.push(moveRecord);
  if (board.dbGameId) addMove(board.dbGameId, moveRecord);

  // Handle capture — transfer piece to partner board's pool
  if (move.captured) {
    const partnerBoardId = getPartnerBoard(boardId);
    addCapturedPiece(room.pools[partnerBoardId], move.captured, turn);
  }

  // Build broadcast payload
  const clockPayload = board.clocks ? { w: board.clocks.w, b: board.clocks.b } : null;

  broadcastToRoom(room, 'bug_move', {
    board: boardId,
    san: move.san,
    fen,
    clocks: clockPayload,
    pools: getSerializablePools(room),
    captured: move.captured || null,
  });

  // Check game end
  checkBughouseGameEnd(room, boardId, turn);

  return { ok: true };
}

function handleBughouseDrop(sessionId, boardId, piece, square) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return { error: 'Not in a room' };

  const room = bughouseRooms.get(roomId);
  if (!room || room.status !== 'playing') return { error: 'Game not in progress' };

  const player = getPlayerBySession(room, sessionId);
  if (!player) return { error: 'Not a player' };
  if (player.board !== boardId) return { error: 'Wrong board' };

  const board = room.boards[boardId];
  const turn = board.chess.turn();
  if (player.color !== turn) return { error: 'Not your turn' };

  // Check if player has the piece in pool
  const pool = room.pools[boardId];
  if (!pool[turn] || pool[turn][piece.toLowerCase()] <= 0) {
    return { error: 'You do not have that piece' };
  }

  // Validate and apply drop
  const dropResult = applyDrop(board.chess, turn, piece, square);
  if (!dropResult.success) return { error: dropResult.error };

  // Remove piece from pool
  removePieceFromPool(pool, turn, piece);

  const now = Date.now();
  const fen = dropResult.newFen;

  // Update clock
  const clockResult = updateBoardClock(board, turn, now);
  if (clockResult.timedOut) {
    finishBughouseGame(room, turn === 'w' ? 'beta' : 'alpha', boardId, clockResult.result, 'timeout');
    return { ok: true };
  }

  // Record drop as a move (using drop SAN notation: P@e4)
  const san = dropToSan(piece, square, fen);
  const moveRecord = { ply: board.moves.length, san, fen, timestamp: now, side: turn };
  board.moves.push(moveRecord);
  if (board.dbGameId) addMove(board.dbGameId, moveRecord);

  const clockPayload = board.clocks ? { w: board.clocks.w, b: board.clocks.b } : null;

  broadcastToRoom(room, 'bug_drop', {
    board: boardId,
    piece,
    square,
    san,
    fen,
    clocks: clockPayload,
    pools: getSerializablePools(room),
  });

  // Check game end (drops can deliver checkmate)
  checkBughouseGameEnd(room, boardId, turn);

  return { ok: true };
}

// --- Clock ---

function updateBoardClock(board, turn, now) {
  if (!board.clocks) return { timedOut: false };
  if (board.moves.length > 0) {
    const elapsed = now - board.clocks.lastMoveAt;
    board.clocks[turn] -= elapsed;
    if (board.clocks[turn] <= 0) {
      board.clocks[turn] = 0;
      const winner = turn === 'w' ? 'b' : 'w';
      const result = winner === 'w' ? '1-0' : '0-1';
      return { timedOut: true, result, reason: 'timeout' };
    }
    board.clocks[turn] += board.clocks.increment;
  }
  board.clocks.lastMoveAt = now;
  return { timedOut: false };
}

function getCurrentBoardClockTime(board, side) {
  if (!board.clocks) return null;
  const base = board.clocks[side];
  if (board.chess.turn() === side && board.clocks.lastMoveAt) {
    const elapsed = Date.now() - board.clocks.lastMoveAt;
    return Math.max(0, base - elapsed);
  }
  return base;
}

// --- Game End ---

function checkBughouseGameEnd(room, boardId, turn) {
  const board = room.boards[boardId];
  if (!board.chess.isGameOver()) return;

  let result, reason;
  if (board.chess.isCheckmate()) {
    result = turn === 'w' ? '1-0' : '0-1';
    reason = 'checkmate';
  } else if (board.chess.isDraw()) {
    result = '1/2-1/2';
    if (board.chess.isStalemate()) reason = 'stalemate';
    else if (board.chess.isThreefoldRepetition()) reason = 'repetition';
    else if (board.chess.isInsufficientMaterial()) reason = 'insufficient';
    else reason = 'fifty-move';
  }

  // Determine winning team
  // The side that just moved won (in case of checkmate)
  // Board A white is team alpha, Board A black is team beta
  // Board B white is team beta, Board B black is team alpha
  let winningTeam = null;
  if (result === '1-0') {
    winningTeam = boardId === 'a' ? 'alpha' : 'beta';
  } else if (result === '0-1') {
    winningTeam = boardId === 'a' ? 'beta' : 'alpha';
  }

  finishBughouseGame(room, winningTeam, boardId, result, reason);
}

function finishBughouseGame(room, winningTeam, decidingBoard, result, reason) {
  room.status = 'finished';

  // End both board games in DB
  for (const boardId of ['a', 'b']) {
    const board = room.boards[boardId];
    if (board.dbGameId) {
      const boardResult = boardId === decidingBoard ? result : '*';
      endGame(board.dbGameId, boardResult, reason);
    }
  }

  broadcastToRoom(room, 'bug_game_end', {
    result,
    reason,
    winningTeam,
    decidingBoard,
  });

  // Schedule cleanup
  room.cleanupTimer = setTimeout(() => cleanupBughouseRoom(room.id), ROOM_TTL_AFTER_END);
}

// --- Resign ---

function handleBughouseResign(sessionId) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return;

  const room = bughouseRooms.get(roomId);
  if (!room || room.status !== 'playing') return;

  const player = getPlayerBySession(room, sessionId);
  if (!player) return;

  // Resigning loses for the entire team
  const losingTeam = player.team;
  const winningTeam = losingTeam === 'alpha' ? 'beta' : 'alpha';
  const result = losingTeam === 'alpha' ? '0-1' : '1-0';

  finishBughouseGame(room, winningTeam, player.board, result, 'resignation');
}

// --- Disconnect / Reconnect ---

function handleBughouseDisconnect(sessionId) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return;

  const room = bughouseRooms.get(roomId);
  if (!room) return;

  const player = getPlayerBySession(room, sessionId);
  if (!player) return;

  player.connected = false;
  player.ws = null;
  player.disconnectedAt = Date.now();

  if (room.status === 'waiting' || room.status === 'lobby') {
    if (!room.waitingCleanupTimer) {
      room.waitingCleanupTimer = setTimeout(() => {
        const r = bughouseRooms.get(roomId);
        if (r && (r.status === 'waiting' || r.status === 'lobby')) {
          cleanupBughouseRoom(roomId);
        }
      }, WAITING_ROOM_TTL);
    }
    broadcastToRoom(room, 'bug_player_disconnected', {
      sessionId,
      timeout: Math.ceil(WAITING_ROOM_TTL / 1000),
    });
    return;
  }

  // Playing — notify others and start grace period
  broadcastToRoom(room, 'bug_player_disconnected', {
    sessionId,
    timeout: Math.ceil(DISCONNECT_GRACE_PERIOD / 1000),
  });

  if (!room.disconnectTimers[sessionId]) {
    room.disconnectTimers[sessionId] = setTimeout(() => {
      const p = getPlayerBySession(room, sessionId);
      if (p && !p.connected && room.status === 'playing') {
        const losingTeam = p.team;
        const winningTeam = losingTeam === 'alpha' ? 'beta' : 'alpha';
        const result = losingTeam === 'alpha' ? '0-1' : '1-0';
        finishBughouseGame(room, winningTeam, p.board, result, 'abandoned');
      }
    }, DISCONNECT_GRACE_PERIOD);
  }
}

function attemptBughouseReconnect(ws, sessionId, room) {
  const player = getPlayerBySession(room, sessionId);
  if (!player) {
    send(ws, 'error', { message: 'You are not a player in this room' });
    return null;
  }

  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;

  bughouseSessionRooms.set(sessionId, room.id);

  // Clear disconnect timer
  if (room.disconnectTimers[sessionId]) {
    clearTimeout(room.disconnectTimers[sessionId]);
    delete room.disconnectTimers[sessionId];
  }

  if (room.waitingCleanupTimer) {
    clearTimeout(room.waitingCleanupTimer);
    room.waitingCleanupTimer = null;
  }

  if (room.status === 'playing') {
    // Send full state for reconnection
    send(ws, 'bug_reconnect', {
      roomId: room.id,
      status: room.status,
      you: { team: player.team, board: player.board, color: player.color },
      boards: {
        a: {
          fen: room.boards.a.chess.fen(),
          moves: room.boards.a.moves.map(m => m.san),
          clocks: room.boards.a.clocks ? {
            w: getCurrentBoardClockTime(room.boards.a, 'w'),
            b: getCurrentBoardClockTime(room.boards.a, 'b'),
          } : null,
        },
        b: {
          fen: room.boards.b.chess.fen(),
          moves: room.boards.b.moves.map(m => m.san),
          clocks: room.boards.b.clocks ? {
            w: getCurrentBoardClockTime(room.boards.b, 'w'),
            b: getCurrentBoardClockTime(room.boards.b, 'b'),
          } : null,
        },
      },
      pools: getSerializablePools(room),
      players: getSerializablePlayers(room),
      timeControl: room.timeControl,
    });
  } else {
    // Lobby/waiting reconnect
    send(ws, 'bug_lobby_update', {
      roomId: room.id,
      players: getSerializablePlayers(room),
      settings: { timeControl: room.timeControl },
      status: room.status,
      you: { team: player.team, board: player.board, color: player.color },
    });
  }

  broadcastToRoom(room, 'bug_player_reconnected', { sessionId });
  return room;
}

// --- Cleanup ---

function cleanupBughouseRoom(roomId) {
  const room = bughouseRooms.get(roomId);
  if (!room) return;

  for (const sessionId of Object.keys(room.players)) {
    bughouseSessionRooms.delete(sessionId);
  }
  clearTimeout(room.cleanupTimer);
  clearTimeout(room.waitingCleanupTimer);
  for (const timer of Object.values(room.disconnectTimers)) {
    clearTimeout(timer);
  }
  bughouseRooms.delete(roomId);
}

// --- Room Lookup ---

function getBughouseRoomForSession(sessionId) {
  const roomId = bughouseSessionRooms.get(sessionId);
  return roomId ? bughouseRooms.get(roomId) : null;
}

function findBughouseRoomBySession(sessionId) {
  for (const room of bughouseRooms.values()) {
    if (room.players[sessionId]) {
      bughouseSessionRooms.set(sessionId, room.id);
      return room;
    }
  }
  return null;
}

function cancelBughouseRoom(sessionId) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return false;

  const room = bughouseRooms.get(roomId);
  if (!room) return false;

  if (room.status !== 'waiting' && room.status !== 'lobby') return false;

  // Only creator can cancel in waiting, anyone in lobby
  if (room.status === 'waiting' && room.creatorSessionId !== sessionId) return false;

  broadcastToRoom(room, 'bug_room_cancelled', {});
  cleanupBughouseRoom(roomId);
  return true;
}

function listPublicBughouseRooms(excludeSessionId) {
  const result = [];
  for (const room of bughouseRooms.values()) {
    if (room.status !== 'waiting' || !room.isPublic) continue;
    if (excludeSessionId && room.creatorSessionId === excludeSessionId) continue;
    result.push({
      roomId: room.id,
      type: 'bughouse',
      timeControl: room.timeControl,
      playerCount: getPlayerCount(room),
      hostName: Object.values(room.players)[0]?.name || 'Unknown',
      createdAt: room.createdAt,
    });
  }
  return result;
}

function setPublicBughouseRoom(sessionId, isPublic) {
  const roomId = bughouseSessionRooms.get(sessionId);
  if (!roomId) return { error: 'Not in a room' };
  const room = bughouseRooms.get(roomId);
  if (!room || room.status !== 'waiting') return { error: 'Room is not in waiting state' };
  if (room.creatorSessionId !== sessionId) return { error: 'Only creator can change visibility' };
  room.isPublic = !!isPublic;
  return { ok: true, isPublic: room.isPublic };
}

module.exports = {
  createBughouseRoom,
  joinBughouseRoom,
  handleBughouseReady,
  handleBughouseSettingChange,
  handleBughouseTeamSwap,
  handleBughouseMove,
  handleBughouseDrop,
  handleBughouseResign,
  handleBughouseDisconnect,
  getBughouseRoomForSession,
  findBughouseRoomBySession,
  cancelBughouseRoom,
  listPublicBughouseRooms,
  setPublicBughouseRoom,
  bughouseSessionRooms,
};
