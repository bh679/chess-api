# Chess API

## Project Overview

- **Repo:** [`bh679/chess-api`](https://github.com/bh679/chess-api)
- **Type:** Express.js REST API with SQLite database
- **Runtime:** Node.js >= 18
- **Hosted at:** `brennan.games` (behind Apache reverse proxy)
- **Client repo:** [`bh679/chess-client`](https://github.com/bh679/chess-client) — static HTML/CSS/JS chess game that syncs to this API
- **Wiki:** [chess-api wiki](https://github.com/bh679/chess-api/wiki) — feature documentation, schema details

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express app setup, health endpoint (`/api/health`), error handler, server startup |
| `db.js` | SQLite schema, WAL mode config, migration, all query helpers (`createGame`, `addMove`, `getGame`, etc.) |
| `routes/games.js` | All game CRUD endpoints (create, read, list, delete, moves, results, player names) |
| `package.json` | Dependencies and scripts — `npm start` runs `node index.js` |
| `data/chess.db` | SQLite database (auto-created on first run, gitignored) |

## Architecture

### Server
- Express 4.21 listening on `127.0.0.1:3002` (localhost only)
- Apache reverse proxy forwards `/api/*` from the public domain
- `express.json()` middleware for request body parsing
- Global error handler catches unhandled errors → 500 response

### Database
- **Engine:** `better-sqlite3` (synchronous SQLite bindings)
- **Location:** `data/chess.db` (auto-created)
- **Mode:** WAL (Write-Ahead Logging) for concurrent access
- **Foreign keys:** Enabled

### Tables

**`games`** — game metadata and player info:
- `id` (INTEGER PK), `start_time`, `end_time`, `game_type`, `time_control`, `starting_fen`
- `result` ('1-0', '0-1', '1/2-1/2'), `result_reason` (checkmate, timeout, etc.)
- `white_name`, `white_is_ai`, `white_elo`, `black_name`, `black_is_ai`, `black_elo`

**`moves`** — individual moves per game:
- `id` (INTEGER PK), `game_id` (FK → games, CASCADE DELETE), `ply`, `san`, `fen`, `timestamp`, `side`
- UNIQUE constraint on `(game_id, ply)` — enables idempotent `INSERT OR IGNORE`

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check — returns `{status, version}` |
| POST | `/api/games` | Create a new game |
| POST | `/api/games/:id/moves` | Add a move (idempotent: 204 new, 409 duplicate) |
| PATCH | `/api/games/:id/end` | Mark a game as finished (set result + end_time) |
| PATCH | `/api/games/:id/player` | Update a player's name |
| GET | `/api/games/:id` | Get full game with all moves |
| POST | `/api/games/list` | List games by IDs (body: `{ids, limit, offset}`) |
| DELETE | `/api/games/:id` | Delete a game and its moves |

### Key Patterns
- **Idempotent moves:** `INSERT OR IGNORE` with UNIQUE constraint on `(game_id, ply)` — safe for retry and partial sync
- **camelCase API responses:** Database columns (`start_time`) are mapped to camelCase (`startTime`) in API responses
- **Local-first client:** The client writes to localStorage first and syncs here asynchronously — the API must handle duplicate/partial data gracefully

## Branching

- Use `dev/<feature-slug>` branch naming convention
- Work in a git worktree (see the project-level CLAUDE.md for worktree setup)
- The Product Engineer agent creates PRs and merges after user approval
- Keep changes focused — one feature per branch

## Commit & Versioning Rules

- **Version format:** V.MM.PPPP (Version.Major.Patch)
  - V = user only. Never change this.
  - MM = bump on every feature merge to main. Resets PPPP.
  - PPPP = bump on every commit. Resets when MM bumps.
- Read current version from `package.json`, bump appropriately, write back, include in commit.
- **Commit messages:** `<type>: <short description>` — types: feat, fix, refactor, style, docs, test, chore, version
- First line under 72 chars, imperative mood, no generic messages.
- Reference the wiki page for feature work: `See: [[Feature Name]]`
- **On major bump (feature merge):** update README.md — add feature to Features section, update Project Structure and Dependencies if changed.

## Testing

- **Dev server:** `CLIENT_DIR=<client-path> PORT=<port> node index.js` — serves both API and client static files on one port
- **API tests:** Use curl to verify endpoints return expected responses
- **Playwright:** Headless browser tests with screenshot analysis for full-stack verification
- Verify: server starts without errors, endpoints return expected responses, database operations succeed
- For schema changes: verify migration runs cleanly on a fresh database AND on an existing one
- **Always test idempotency** — calling the same endpoint twice with the same data should not cause errors or duplicates

## Rules

- **Preserve idempotent sync** — move insertion must always use `INSERT OR IGNORE` with the UNIQUE constraint. The client retries failed syncs and must not create duplicates.
- **Keep the API surface minimal** — don't add endpoints without explicit approval in the issue
- **No authentication changes** — the API currently trusts all requests. Authentication will be added as a separate feature.
- **Database migrations must be backwards-compatible** — add columns with DEFAULT values, never drop columns, always handle existing data
- **Match existing code style** — CommonJS `require()`, not ES modules; callback-free `better-sqlite3` synchronous API
- **Health endpoint must return version** — always update the version in `package.json`, which the health endpoint reads
