# Chess API

REST API server for persistent chess game storage. Stores games and moves in a SQLite database. The client uses a local-first architecture where localStorage is the source of truth, with this server as the sync target. Move insertion is idempotent (`INSERT OR IGNORE` with a UNIQUE constraint on `game_id, ply`) to support safe retry and partial sync recovery.

**Client repository:** [bh679/Chess](https://github.com/bh679/Chess) (also mirrored at [bh679/Narrative-Chess](https://github.com/bh679/Narrative-Chess))

## Version

**Current:** `1.0.0`

The `/api/health` endpoint returns the server version. The client checks this on startup to verify compatibility.

## Dependencies

- **Node.js** >= 18
- **npm** packages (installed via `npm install`):
  - `express` ^4.21 — HTTP server and routing
  - `better-sqlite3` ^11.0 — SQLite3 database driver (native addon)

## Setup

```bash
cd /home/bitnami/server/chess-api
npm install
```

### Run directly

```bash
node index.js
```

### Run with pm2 (recommended for production)

```bash
pm2 start index.js --name chess-api
pm2 save
pm2 startup  # follow printed instructions to enable on boot
```

### Apache proxy

The API listens on `127.0.0.1:3002` (not publicly exposed). Apache proxies `/api/*` requests to it. Add to your Apache SSL config:

```apache
ProxyRequests Off
ProxyPreserveHost On
ProxyPass /api http://127.0.0.1:3002/api
ProxyPassReverse /api http://127.0.0.1:3002/api
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
| DELETE | `/api/games/:id` | Delete a game and its moves |

## Database

SQLite database stored at `data/chess.db` (auto-created on first run). Uses WAL mode for concurrent read/write performance.

**Tables:**
- `games` — game metadata (players, result, time control, timestamps)
- `moves` — individual moves (FEN, SAN, timestamps), foreign key to games with CASCADE delete, UNIQUE constraint on `(game_id, ply)` for idempotent sync

## Project Structure

```
index.js            Express app, health endpoint, server startup
db.js               SQLite schema, query helpers
routes/games.js     All game CRUD endpoints
data/chess.db       SQLite database (auto-created, gitignored)
package.json        Dependencies and metadata
```
