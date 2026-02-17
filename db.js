const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'chess.db');

let db;

function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      start_time     INTEGER NOT NULL,
      end_time       INTEGER,
      game_type      TEXT NOT NULL DEFAULT 'standard',
      time_control   TEXT NOT NULL DEFAULT 'none',
      starting_fen   TEXT NOT NULL,
      result         TEXT,
      result_reason  TEXT DEFAULT '',
      white_name     TEXT NOT NULL,
      white_is_ai    INTEGER NOT NULL DEFAULT 0,
      white_elo      INTEGER,
      black_name     TEXT NOT NULL,
      black_is_ai    INTEGER NOT NULL DEFAULT 0,
      black_elo      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_games_start_time ON games(start_time);

    CREATE TABLE IF NOT EXISTS moves (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      ply       INTEGER NOT NULL,
      san       TEXT NOT NULL,
      fen       TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      side      TEXT NOT NULL,
      UNIQUE(game_id, ply)
    );

    CREATE INDEX IF NOT EXISTS idx_moves_game_id ON moves(game_id);
  `);

  // Migration: deduplicate existing moves and add unique constraint
  // The UNIQUE constraint in CREATE TABLE only applies if the table is new.
  // For existing tables, we need to create the index explicitly.
  try {
    // Remove duplicate moves keeping the one with the lowest rowid
    db.exec(`
      DELETE FROM moves WHERE id NOT IN (
        SELECT MIN(id) FROM moves GROUP BY game_id, ply
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_moves_game_ply ON moves(game_id, ply)`);
  } catch (e) {
    // Index may already exist; ignore
  }

  return db;
}

function getDb() {
  return db;
}

// --- Query helpers ---

function createGame(metadata) {
  const stmt = db.prepare(`
    INSERT INTO games (start_time, game_type, time_control, starting_fen,
      white_name, white_is_ai, white_elo, black_name, black_is_ai, black_elo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    Date.now(),
    metadata.gameType || 'standard',
    metadata.timeControl || 'none',
    metadata.startingFen,
    metadata.white.name,
    metadata.white.isAI ? 1 : 0,
    metadata.white.elo ?? null,
    metadata.black.name,
    metadata.black.isAI ? 1 : 0,
    metadata.black.elo ?? null
  );
  return info.lastInsertRowid;
}

function addMove(gameId, moveData) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO moves (game_id, ply, san, fen, timestamp, side)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(gameId, moveData.ply, moveData.san, moveData.fen, moveData.timestamp, moveData.side);
  return info.changes > 0; // false if duplicate (game_id, ply)
}

function endGame(gameId, result, resultReason) {
  const stmt = db.prepare(`
    UPDATE games SET result = ?, result_reason = ?, end_time = ? WHERE id = ?
  `);
  stmt.run(result, resultReason || '', Date.now(), gameId);
}

function updatePlayerName(gameId, side, name) {
  const column = side === 'white' ? 'white_name' : 'black_name';
  const stmt = db.prepare(`UPDATE games SET ${column} = ? WHERE id = ?`);
  stmt.run(name, gameId);
}

function getGame(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) return null;

  const moves = db.prepare('SELECT ply, san, fen, timestamp, side FROM moves WHERE game_id = ? ORDER BY ply').all(gameId);

  return {
    id: game.id,
    startTime: game.start_time,
    endTime: game.end_time,
    gameType: game.game_type,
    timeControl: game.time_control,
    startingFen: game.starting_fen,
    result: game.result,
    resultReason: game.result_reason,
    white: { name: game.white_name, isAI: !!game.white_is_ai, elo: game.white_elo },
    black: { name: game.black_name, isAI: !!game.black_is_ai, elo: game.black_elo },
    moves
  };
}

function listGames(ids, limit = 15, offset = 0) {
  if (!ids || ids.length === 0) return { games: [], total: 0 };

  // Build placeholders for IN clause
  const placeholders = ids.map(() => '?').join(',');

  // Get total count of games with moves
  const countStmt = db.prepare(`
    SELECT COUNT(*) as total FROM games g
    WHERE g.id IN (${placeholders})
    AND (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) >= 1
  `);
  const { total } = countStmt.get(...ids);

  // Get paginated games with move counts, most recent first
  const gamesStmt = db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) as move_count
    FROM games g
    WHERE g.id IN (${placeholders})
    ORDER BY g.start_time DESC
    LIMIT ? OFFSET ?
  `);
  const rows = gamesStmt.all(...ids, limit, offset);

  const games = rows.map(row => ({
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    gameType: row.game_type,
    timeControl: row.time_control,
    white: { name: row.white_name, isAI: !!row.white_is_ai, elo: row.white_elo },
    black: { name: row.black_name, isAI: !!row.black_is_ai, elo: row.black_elo },
    result: row.result,
    resultReason: row.result_reason,
    moveCount: row.move_count
  }));

  return { games, total };
}

function listAllGames(limit = 15, offset = 0) {
  const { total } = db.prepare(`
    SELECT COUNT(*) as total FROM games g
    WHERE (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) >= 1
  `).get();

  const rows = db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) as move_count
    FROM games g
    WHERE (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) >= 1
    ORDER BY g.start_time DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const games = rows.map(row => ({
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    gameType: row.game_type,
    timeControl: row.time_control,
    white: { name: row.white_name, isAI: !!row.white_is_ai, elo: row.white_elo },
    black: { name: row.black_name, isAI: !!row.black_is_ai, elo: row.black_elo },
    result: row.result,
    resultReason: row.result_reason,
    moveCount: row.move_count
  }));

  return { games, total };
}

function deleteGame(gameId) {
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
}

module.exports = {
  initDb,
  getDb,
  createGame,
  addMove,
  endGame,
  updatePlayerName,
  getGame,
  listGames,
  listAllGames,
  deleteGame
};
