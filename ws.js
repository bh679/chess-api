const { WebSocketServer } = require('ws');
const rooms = require('./rooms');
const matchmaking = require('./matchmaking');

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

        // Check for existing room to reconnect
        const existingRoom = rooms.getRoomForSession(sessionId);
        let reconnected = false;
        if (existingRoom && (existingRoom.status === 'playing' || existingRoom.status === 'waiting')) {
          const joinResult = rooms.joinRoom(ws, sessionId, null, existingRoom.id);
          reconnected = !!joinResult;
        }

        send(ws, 'auth_ok', { inRoom: reconnected, roomId: reconnected ? existingRoom.id : null });

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
          rooms.createRoom(ws, sessionId, payload?.name, payload?.timeControl, payload?.videoEnabled, payload?.chess960);
          break;

        case 'join_room':
          if (!payload?.roomId) {
            send(ws, 'error', { message: 'roomId required' });
            break;
          }
          rooms.joinRoom(ws, sessionId, payload?.name, payload.roomId);
          break;

        case 'quick_match':
          matchmaking.joinQueue(ws, sessionId, payload?.name, payload?.timeControl, payload?.videoEnabled, payload?.chess960);
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

        // Player name change — relay to opponent
        case 'name_change':
          rooms.relaySignaling(sessionId, 'name_change', { name: payload?.name });
          break;

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

        // Application-level heartbeat
        case 'ping':
          send(ws, 'pong', { ts: payload?.ts });
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
