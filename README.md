# Chess API

REST API server for persistent chess game storage. Stores games and moves in a SQLite database. The client uses a local-first architecture where localStorage is the source of truth, with this server as the sync target. Move insertion is idempotent (`INSERT OR IGNORE` with a UNIQUE constraint on `game_id, ply`) to support safe retry and partial sync recovery.

**Client repository:** [bh679/Chess](https://github.com/bh679/Chess) (also mirrored at [bh679/Narrative-Chess](https://github.com/bh679/Narrative-Chess))

## Version

**Current:** `1.03.0001`

The `/api/health` endpoint returns the server version. The client checks this on startup to verify compatibility.

## Dependencies

- **Node.js** >= 18
- **npm** packages (installed via `npm install`):
  - `express` ^4.21 — HTTP server and routing
  - `better-sqlite3` ^11.0 — SQLite3 database driver (native addon)
  - `ws` ^8.18 — WebSocket server for live multiplayer
  - `chess.js` ^1.0 — Server-side move validation for multiplayer games

## Setup

```bash
cd /home/bitnami/server/chess-api
npm install
```

### Run directly

```bash
node index.js
```

### Run as dev server (serves client static files)

When the `CLIENT_DIR` environment variable is set, the server also serves static files from that directory. This lets you run both the API and client on a single port during development:

```bash
CLIENT_DIR=../chess-client PORT=3001 node index.js
```

- `http://localhost:3001/` — serves the chess-client UI
- `http://localhost:3001/api/*` — serves the API endpoints

### Run with pm2 (recommended for production)

```bash
pm2 start index.js --name chess-api
pm2 save
pm2 startup  # follow printed instructions to enable on boot
```

### Apache proxy

The API listens on `127.0.0.1:3002` by default (not publicly exposed). Override the port with the `PORT` environment variable. Apache proxies `/api/*` and `/ws` requests to it. Add to your Apache SSL config:

```apache
ProxyRequests Off
ProxyPreserveHost On

# REST API proxy
ProxyPass /api http://127.0.0.1:3002/api
ProxyPassReverse /api http://127.0.0.1:3002/api

# WebSocket proxy (for live multiplayer)
RewriteEngine On
RewriteCond %{HTTP:Upgrade} websocket [NC]
RewriteCond %{HTTP:Connection} upgrade [NC]
RewriteRule ^/ws$ ws://127.0.0.1:3002/ws [P,L]
ProxyPass /ws ws://127.0.0.1:3002/ws
ProxyPassReverse /ws ws://127.0.0.1:3002/ws
```

Ensure the following Apache modules are enabled: `proxy`, `proxy_http`, `proxy_wstunnel`, `rewrite`:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
```

Then restart Apache:

```bash
sudo /opt/bitnami/ctlscript.sh restart apache
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check — returns `{status, version}` |
| POST | `/api/games` | Create a new game |
| POST | `/api/games/:id/moves` | Add a move (idempotent — returns 204 new, 409 duplicate) |
| PATCH | `/api/games/:id/end` | Mark a game as finished |
| PATCH | `/api/games/:id/player` | Update a player's name |
| GET | `/api/games/:id` | Get full game with all moves |
| POST | `/api/games/list` | List games by IDs (body: `{ids, limit, offset}`) |
| POST | `/api/games/list-all` | List all games with at least 1 move (body: `{limit, offset}`) |
| DELETE | `/api/games/:id` | Delete a game and its moves |

## WebSocket (Live Multiplayer)

The WebSocket server listens on `/ws` path (same port as HTTP). It handles real-time multiplayer chess with server-authoritative moves and clocks.

**Connection flow:**
1. Client connects to `wss://host/ws`
2. Client sends `auth` message with `{ sessionId }` (UUID from `sessionStorage`)
3. Server responds with `auth_ok`
4. Client can then create rooms, join rooms, or enter the matchmaking queue

**Message format:** JSON `{ type, payload }`

| Client → Server | Payload | Description |
|----------------|---------|-------------|
| `auth` | `{ sessionId }` | Authenticate (required first message) |
| `create_room` | `{ timeControl, name }` | Create a private room |
| `join_room` | `{ roomId, name }` | Join an existing room by code |
| `quick_match` | `{ timeControl, name }` | Enter matchmaking queue |
| `cancel_queue` | `{}` | Leave matchmaking queue |
| `move` | `{ san }` | Make a move (SAN notation) |
| `resign` | `{}` | Resign the game |
| `draw_offer` | `{}` | Offer a draw |
| `draw_respond` | `{ accept }` | Accept or decline a draw |
| `rematch_offer` | `{}` | Offer a rematch |
| `rematch_respond` | `{ accept }` | Accept or decline a rematch |

| Server → Client | Payload | Description |
|----------------|---------|-------------|
| `auth_ok` | `{ sessionId }` | Authentication successful |
| `room_created` | `{ roomId, color }` | Room created, waiting for opponent |
| `game_start` | `{ roomId, color, fen, opponentName, timeControl }` | Game has started |
| `move` | `{ san, fen, clocks }` | Opponent made a move |
| `move_ack` | `{ clocks }` | Your move was validated and applied |
| `game_end` | `{ result, reason }` | Game ended (checkmate, resign, timeout, draw) |
| `draw_offered` | `{}` | Opponent offered a draw |
| `draw_declined` | `{}` | Opponent declined your draw offer |
| `queue_joined` | `{ timeControl, position }` | Entered matchmaking queue |
| `opponent_disconnected` | `{}` | Opponent lost connection (60s grace) |
| `opponent_reconnected` | `{}` | Opponent reconnected |
| `error` | `{ message }` | Error message |

**Time controls:** `"1+0"`, `"3+2"`, `"5+0"`, `"10+0"`, `"15+10"`, `"30+0"`, `"none"` (no timer), `"any"` (match with any TC).

**Rooms** are stored in-memory only (not persisted to database). A 60-second disconnect grace period allows reconnection without forfeiting.

## Database

SQLite database stored at `data/chess.db` (auto-created on first run). Uses WAL mode for concurrent read/write performance.

**Tables:**
- `games` — game metadata (players, result, time control, timestamps)
- `moves` — individual moves (FEN, SAN, timestamps), foreign key to games with CASCADE delete, UNIQUE constraint on `(game_id, ply)` for idempotent sync

## Project Structure

```
index.js            Express app, health endpoint, HTTP+WebSocket server startup
ws.js               WebSocket server — message routing, auth, keepalive
rooms.js            Room manager — create/join/move/resign/draw/rematch/reconnect
matchmaking.js      FIFO matchmaking queue per time control
db.js               SQLite schema, query helpers
routes/games.js     All game CRUD endpoints
data/chess.db       SQLite database (auto-created, gitignored)
package.json        Dependencies and metadata
```
