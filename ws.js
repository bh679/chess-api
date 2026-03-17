const { WebSocketServer } = require('ws');
const rooms = require('./rooms');
const matchmaking = require('./matchmaking');
const bughouseRooms = require('./bughouse-rooms');
const bughouseMatchmaking = require('./bughouse-matchmaking');

// Map WebSocket → sessionId for disconnect handling
const connections = new Map();

// Track connection count per sessionId for multi-tab safety
const sessionConnectionCount = new Map();

function initWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let sessionId = null;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        send(ws, 'error', { message: 'Invalid JSON' });
        return;
      }

      const { type, payload } = msg;

      // First message must be auth
      if (!sessionId) {
        if (type !== 'auth' || !payload?.sessionId) {
          send(ws, 'error', { message: 'First message must be auth with sessionId' });
          return;
        }
        sessionId = payload.sessionId;
        connections.set(ws, sessionId);

        // Track connection count for this session
        const count = sessionConnectionCount.get(sessionId) || 0;
        sessionConnectionCount.set(sessionId, count + 1);

        // Check for existing room to reconnect (standard or bughouse)
        let existingRoom = rooms.getRoomForSession(sessionId);
        // Fallback: scan all rooms if sessionRooms mapping is missing
        if (!existingRoom) {
          existingRoom = rooms.findRoomBySession(sessionId);
        }
        let reconnected = false;
        let roomType = 'standard';
        if (existingRoom && (existingRoom.status === 'playing' || existingRoom.status === 'waiting' || existingRoom.status === 'lobby')) {
          const joinResult = rooms.joinRoom(ws, sessionId, null, existingRoom.id);
          reconnected = !!joinResult;
        }

        // Check bughouse rooms if not reconnected to a standard room
        if (!reconnected) {
          let existingBugRoom = bughouseRooms.getBughouseRoomForSession(sessionId);
          if (!existingBugRoom) {
            existingBugRoom = bughouseRooms.findBughouseRoomBySession(sessionId);
          }
          if (existingBugRoom && (existingBugRoom.status === 'playing' || existingBugRoom.status === 'waiting' || existingBugRoom.status === 'lobby')) {
            const joinResult = bughouseRooms.joinBughouseRoom(ws, sessionId, null, existingBugRoom.id);
            reconnected = !!joinResult;
            roomType = 'bughouse';
            existingRoom = existingBugRoom;
          }
        }

        send(ws, 'auth_ok', { inRoom: reconnected, roomId: reconnected ? existingRoom.id : null, roomType });

        // Auto-send rooms list on connect
        const userRooms = rooms.listRoomsForSession(sessionId);
        if (userRooms.length > 0) {
          send(ws, 'rooms_list', { rooms: userRooms });
        }
        return;
      }

      // Route messages
      switch (type) {
        case 'create_room':
          rooms.createRoom(ws, sessionId, payload?.name, payload?.timeControl, payload?.camMode ?? (payload?.videoEnabled ? 'board-face' : 'none'), payload?.chess960);
          break;

        case 'join_room':
          if (!payload?.roomId) {
            send(ws, 'error', { message: 'roomId required' });
            break;
          }
          rooms.joinRoom(ws, sessionId, payload?.name, payload.roomId);
          break;

        case 'quick_match':
          matchmaking.joinQueue(ws, sessionId, payload?.name, payload?.timeControl, payload?.camMode ?? (payload?.videoEnabled ? 'board-face' : 'none'), payload?.chess960);
          break;

        case 'cancel_queue':
          matchmaking.leaveQueue(sessionId);
          send(ws, 'queue_left', {});
          break;

        case 'move':
          if (!payload?.san) {
            send(ws, 'error', { message: 'san required' });
            break;
          }
          const result = rooms.makeMove(sessionId, payload.san);
          if (result.error) {
            send(ws, 'error', { message: result.error });
          }
          break;

        case 'resign':
          rooms.handleResign(sessionId);
          break;

        case 'draw_offer':
          rooms.handleDrawOffer(sessionId);
          break;

        case 'draw_respond':
          rooms.handleDrawResponse(sessionId, !!payload?.accept);
          break;

        case 'rematch_offer':
          rooms.handleRematchOffer(sessionId);
          break;

        case 'rematch_respond':
          rooms.handleRematchResponse(sessionId, !!payload?.accept);
          break;

        case 'list_rooms':
          send(ws, 'rooms_list', { rooms: rooms.listRoomsForSession(sessionId) });
          break;

        case 'cancel_room':
          if (rooms.cancelRoom(sessionId)) {
            send(ws, 'room_cancelled', {});
          } else {
            send(ws, 'error', { message: 'No waiting room to cancel' });
          }
          break;

        case 'set_public': {
          const result = rooms.setPublicRoom(sessionId, !!payload?.isPublic);
          if (result.error) {
            send(ws, 'error', { message: result.error });
          } else {
            send(ws, 'public_set', { isPublic: result.isPublic });
          }
          break;
        }

        case 'list_public_rooms':
          send(ws, 'public_rooms_list', { rooms: rooms.listPublicRooms(sessionId) });
          break;

        // WebRTC video signaling — relay to opponent
        case 'rtc_offer':
        case 'rtc_answer':
        case 'rtc_ice':
          rooms.relaySignaling(sessionId, type, payload);
          break;

        case 'video_ready':
          rooms.handleVideoReady(sessionId);
          break;

        case 'video_end':
          rooms.relaySignaling(sessionId, 'video_ended', {});
          break;

        // Player name change — update room data, relay to opponent, broadcast if public
        case 'name_change': {
          const nameResult = rooms.updatePlayerName(sessionId, payload?.name);
          rooms.relaySignaling(sessionId, 'name_change', { name: payload?.name });
          if (nameResult.isPublicWaiting) {
            for (const [clientWs, clientSessionId] of connections) {
              send(clientWs, 'public_rooms_list', { rooms: rooms.listPublicRooms(clientSessionId) });
            }
          }
          break;
        }

        // Shared post-game review
        case 'review_enter':
          rooms.handleReviewEnter(sessionId);
          break;

        case 'review_navigate':
          rooms.handleReviewNavigate(sessionId, payload?.ply);
          break;

        case 'review_arrow':
          rooms.handleReviewArrow(sessionId, payload?.action, payload?.from, payload?.to);
          break;

        case 'review_clear_arrows':
          rooms.handleReviewClearArrows(sessionId);
          break;

        case 'review_analysis_started':
          rooms.handleReviewAnalysisStarted(sessionId);
          break;

        case 'review_analysis':
          rooms.handleReviewAnalysis(sessionId, payload);
          break;

        case 'review_exit':
          rooms.handleReviewExit(sessionId);
          break;

        // Lobby — pre-game settings negotiation
        case 'setting_change':
          rooms.handleSettingChange(sessionId, payload?.field, payload?.value);
          break;

        case 'player_ready':
          rooms.handlePlayerReady(sessionId, payload?.ready !== false);
          break;

        // Application-level heartbeat
        case 'ping':
          send(ws, 'pong', { ts: payload?.ts });
          break;

        // --- Bughouse messages ---
        case 'bug_create_room':
          bughouseRooms.createBughouseRoom(ws, sessionId, payload?.name, payload?.timeControl);
          break;

        case 'bug_join_room':
          if (!payload?.roomId) {
            send(ws, 'error', { message: 'roomId required' });
            break;
          }
          bughouseRooms.joinBughouseRoom(ws, sessionId, payload?.name, payload.roomId);
          break;

        case 'bug_quick_match':
          bughouseMatchmaking.joinBughouseQueue(ws, sessionId, payload?.name, payload?.timeControl);
          break;

        case 'bug_cancel_queue':
          bughouseMatchmaking.leaveBughouseQueue(sessionId);
          send(ws, 'bug_queue_left', {});
          break;

        case 'bug_move': {
          if (!payload?.board || !payload?.san) {
            send(ws, 'error', { message: 'board and san required' });
            break;
          }
          const bugMoveResult = bughouseRooms.handleBughouseMove(sessionId, payload.board, payload.san);
          if (bugMoveResult.error) {
            send(ws, 'error', { message: bugMoveResult.error });
          }
          break;
        }

        case 'bug_drop': {
          if (!payload?.board || !payload?.piece || !payload?.square) {
            send(ws, 'error', { message: 'board, piece, and square required' });
            break;
          }
          const bugDropResult = bughouseRooms.handleBughouseDrop(sessionId, payload.board, payload.piece, payload.square);
          if (bugDropResult.error) {
            send(ws, 'error', { message: bugDropResult.error });
          }
          break;
        }

        case 'bug_resign':
          bughouseRooms.handleBughouseResign(sessionId);
          break;

        case 'bug_ready':
          bughouseRooms.handleBughouseReady(sessionId, payload?.ready !== false);
          break;

        case 'bug_setting_change':
          bughouseRooms.handleBughouseSettingChange(sessionId, payload?.field, payload?.value);
          break;

        case 'bug_team_swap':
          bughouseRooms.handleBughouseTeamSwap(sessionId, payload?.targetSessionId);
          break;

        case 'bug_cancel_room':
          if (bughouseRooms.cancelBughouseRoom(sessionId)) {
            send(ws, 'bug_room_cancelled', {});
          } else {
            send(ws, 'error', { message: 'No bughouse room to cancel' });
          }
          break;

        case 'bug_set_public': {
          const bugPubResult = bughouseRooms.setPublicBughouseRoom(sessionId, !!payload?.isPublic);
          if (bugPubResult.error) {
            send(ws, 'error', { message: bugPubResult.error });
          } else {
            send(ws, 'bug_public_set', { isPublic: bugPubResult.isPublic });
          }
          break;
        }

        case 'bug_list_public_rooms':
          send(ws, 'bug_public_rooms_list', { rooms: bughouseRooms.listPublicBughouseRooms(sessionId) });
          break;

        default:
          send(ws, 'error', { message: `Unknown message type: ${type}` });
      }
    });

    ws.on('close', () => {
      if (sessionId) {
        connections.delete(ws);

        // Decrement connection count — only disconnect room when no connections remain
        const count = (sessionConnectionCount.get(sessionId) || 1) - 1;
        if (count <= 0) {
          sessionConnectionCount.delete(sessionId);
          rooms.handleDisconnect(sessionId);
        } else {
          sessionConnectionCount.set(sessionId, count);
        }

        matchmaking.handleDisconnect(sessionId);
        bughouseRooms.handleBughouseDisconnect(sessionId);
        bughouseMatchmaking.handleBughouseDisconnect(sessionId);
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });

    // Keepalive ping every 30s
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  // Keepalive interval — terminate dead connections
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  console.log('WebSocket server attached');
  return wss;
}

function send(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type, payload }));
  } catch (e) {
    // Connection may have closed
  }
}

module.exports = { initWebSocket };
