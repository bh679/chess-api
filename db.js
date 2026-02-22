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

  // Migration: add engine columns for AI engine selection
  try {
    db.exec(`ALTER TABLE games ADD COLUMN white_engine TEXT`);
  } catch (e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE games ADD COLUMN black_engine TEXT`);
  } catch (e) { /* column already exists */ }

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

  // --- User accounts tables ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wp_user_id      INTEGER UNIQUE NOT NULL,
      username        TEXT NOT NULL UNIQUE,
      display_name    TEXT NOT NULL,
      avatar_url      TEXT,
      bio             TEXT DEFAULT '',
      profile_public  INTEGER NOT NULL DEFAULT 1,
      games_public    INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_wp_id ON users(wp_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS ratings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category        TEXT NOT NULL,
      rating          REAL NOT NULL DEFAULT 1500.0,
      rd              REAL NOT NULL DEFAULT 350.0,
      volatility      REAL NOT NULL DEFAULT 0.06,
      games_played    INTEGER NOT NULL DEFAULT 0,
      wins            INTEGER NOT NULL DEFAULT 0,
      losses          INTEGER NOT NULL DEFAULT 0,
      draws           INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, category)
    );

    CREATE INDEX IF NOT EXISTS idx_ratings_user ON ratings(user_id);

    CREATE TABLE IF NOT EXISTS rating_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category        TEXT NOT NULL,
      game_id         INTEGER REFERENCES games(id) ON DELETE SET NULL,
      old_rating      REAL NOT NULL,
      new_rating      REAL NOT NULL,
      old_rd          REAL NOT NULL,
      new_rd          REAL NOT NULL,
      opponent_rating REAL,
      result          TEXT NOT NULL,
      timestamp       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rating_history_user ON rating_history(user_id, category);
    CREATE INDEX IF NOT EXISTS idx_rating_history_timestamp ON rating_history(timestamp);

    CREATE TABLE IF NOT EXISTS friendships (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE(user_id, friend_id)
    );

    CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings_json   TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // Migration: add user account columns to games table
  try {
    db.exec(`ALTER TABLE games ADD COLUMN white_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  } catch (e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE games ADD COLUMN black_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  } catch (e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE games ADD COLUMN white_rating_before REAL`);
  } catch (e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE games ADD COLUMN black_rating_before REAL`);
  } catch (e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE games ADD COLUMN white_rating_after REAL`);
  } catch (e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE games ADD COLUMN black_rating_after REAL`);
  } catch (e) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE games ADD COLUMN rated INTEGER NOT NULL DEFAULT 0`);
  } catch (e) { /* column already exists */ }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_games_white_user ON games(white_user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_games_black_user ON games(black_user_id)`);

  // Migration: add password_hash for local auth
  try {
    db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  } catch (e) { /* column already exists */ }

  return db;
}

function getDb() {
  return db;
}

// --- Query helpers ---

function createGame(metadata, userId) {
  const whiteUserId = (!metadata.white.isAI && userId) ? userId : null;
  const blackUserId = (!metadata.black.isAI && userId) ? userId : null;
  const stmt = db.prepare(`
    INSERT INTO games (start_time, game_type, time_control, starting_fen,
      white_name, white_is_ai, white_elo, white_engine,
      black_name, black_is_ai, black_elo, black_engine,
      white_user_id, black_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    Date.now(),
    metadata.gameType || 'standard',
    metadata.timeControl || 'none',
    metadata.startingFen,
    metadata.white.name,
    metadata.white.isAI ? 1 : 0,
    metadata.white.elo ?? null,
    metadata.white.engineId ?? null,
    metadata.black.name,
    metadata.black.isAI ? 1 : 0,
    metadata.black.elo ?? null,
    metadata.black.engineId ?? null,
    whiteUserId,
    blackUserId
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
    white: { name: game.white_name, isAI: !!game.white_is_ai, elo: game.white_elo, engineId: game.white_engine },
    black: { name: game.black_name, isAI: !!game.black_is_ai, elo: game.black_elo, engineId: game.black_engine },
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
    white: { name: row.white_name, isAI: !!row.white_is_ai, elo: row.white_elo, engineId: row.white_engine },
    black: { name: row.black_name, isAI: !!row.black_is_ai, elo: row.black_elo, engineId: row.black_engine },
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
    white: { name: row.white_name, isAI: !!row.white_is_ai, elo: row.white_elo, engineId: row.white_engine },
    black: { name: row.black_name, isAI: !!row.black_is_ai, elo: row.black_elo, engineId: row.black_engine },
    result: row.result,
    resultReason: row.result_reason,
    moveCount: row.move_count
  }));

  return { games, total };
}

function deleteGame(gameId) {
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
}

// --- User helpers ---

function upsertUser(wpUserId, username, displayName, avatarUrl) {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM users WHERE wp_user_id = ?').get(wpUserId);
  if (existing) {
    db.prepare(`
      UPDATE users SET username = ?, display_name = ?, avatar_url = ?, last_seen_at = ?
      WHERE wp_user_id = ?
    `).run(username, displayName, avatarUrl, now, wpUserId);
    return db.prepare('SELECT * FROM users WHERE wp_user_id = ?').get(wpUserId);
  }
  db.prepare(`
    INSERT INTO users (wp_user_id, username, display_name, avatar_url, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wpUserId, username, displayName, avatarUrl, now, now);
  return db.prepare('SELECT * FROM users WHERE wp_user_id = ?').get(wpUserId);
}

function getUserByWpId(wpUserId) {
  return db.prepare('SELECT * FROM users WHERE wp_user_id = ?').get(wpUserId);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function updateUser(userId, fields) {
  const allowed = ['display_name', 'bio', 'avatar_url', 'profile_public', 'games_public'];
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (sets.length === 0) return;
  values.push(userId);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function formatUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    wpUserId: row.wp_user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    profilePublic: !!row.profile_public,
    gamesPublic: !!row.games_public,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

// --- Rating helpers ---

function getRatings(userId) {
  const rows = db.prepare('SELECT * FROM ratings WHERE user_id = ?').all(userId);
  const result = {};
  for (const row of rows) {
    result[row.category] = {
      rating: row.rating,
      rd: row.rd,
      volatility: row.volatility,
      gamesPlayed: row.games_played,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws
    };
  }
  return result;
}

function ensureRating(userId, category) {
  db.prepare(`
    INSERT OR IGNORE INTO ratings (user_id, category, rating, rd, volatility, games_played, wins, losses, draws)
    VALUES (?, ?, 1500.0, 350.0, 0.06, 0, 0, 0, 0)
  `).run(userId, category);
  return db.prepare('SELECT * FROM ratings WHERE user_id = ? AND category = ?').get(userId, category);
}

function updateRatingRecord(userId, category, rating, rd, volatility, resultType) {
  const winInc = resultType === 'win' ? 1 : 0;
  const lossInc = resultType === 'loss' ? 1 : 0;
  const drawInc = resultType === 'draw' ? 1 : 0;
  db.prepare(`
    UPDATE ratings SET rating = ?, rd = ?, volatility = ?,
      games_played = games_played + 1,
      wins = wins + ?, losses = losses + ?, draws = draws + ?
    WHERE user_id = ? AND category = ?
  `).run(rating, rd, volatility, winInc, lossInc, drawInc, userId, category);
}

function addRatingHistory(userId, category, gameId, oldRating, newRating, oldRd, newRd, opponentRating, result) {
  db.prepare(`
    INSERT INTO rating_history (user_id, category, game_id, old_rating, new_rating, old_rd, new_rd, opponent_rating, result, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, category, gameId, oldRating, newRating, oldRd, newRd, opponentRating, result, Date.now());
}

function getRatingHistory(userId, category, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT * FROM rating_history
    WHERE user_id = ? AND category = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(userId, category, limit, offset);
}

// --- Friendship helpers ---

function createFriendship(userId, friendId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO friendships (user_id, friend_id, status, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(userId, friendId, now, now);
}

function respondFriendship(friendshipId, status) {
  db.prepare(`
    UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?
  `).run(status, Date.now(), friendshipId);
}

function getFriendships(userId) {
  const friends = db.prepare(`
    SELECT f.*, u.username, u.display_name, u.avatar_url
    FROM friendships f
    JOIN users u ON (CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END) = u.id
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
  `).all(userId, userId, userId);

  const pendingIncoming = db.prepare(`
    SELECT f.*, u.username, u.display_name, u.avatar_url
    FROM friendships f
    JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `).all(userId);

  const pendingOutgoing = db.prepare(`
    SELECT f.*, u.username, u.display_name, u.avatar_url
    FROM friendships f
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id = ? AND f.status = 'pending'
  `).all(userId);

  return { friends, pendingIncoming, pendingOutgoing };
}

function getFriendship(userId, friendId) {
  return db.prepare(`
    SELECT * FROM friendships
    WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
  `).get(userId, friendId, friendId, userId);
}

function removeFriendship(userId, friendId) {
  db.prepare(`
    DELETE FROM friendships
    WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
  `).run(userId, friendId, friendId, userId);
}

// --- Settings helpers ---

function getSettings(userId) {
  const row = db.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(userId);
  if (!row) return {};
  try {
    return JSON.parse(row.settings_json);
  } catch (e) {
    return {};
  }
}

function updateSettings(userId, settings) {
  const current = getSettings(userId);
  const merged = { ...current, ...settings };
  const json = JSON.stringify(merged);
  db.prepare(`
    INSERT INTO user_settings (user_id, settings_json) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET settings_json = ?
  `).run(userId, json, json);
}

// --- Game queries by user ---

function listGamesByUser(userId, { limit = 15, offset = 0, category, result, opponent, gameType, playerType, timeControl, eloMin, eloMax } = {}) {
  let where = '(g.white_user_id = ? OR g.black_user_id = ?)';
  const params = [userId, userId];

  if (result === 'win') {
    where += ` AND ((g.white_user_id = ? AND g.result = 'white') OR (g.black_user_id = ? AND g.result = 'black'))`;
    params.push(userId, userId);
  } else if (result === 'loss') {
    where += ` AND ((g.white_user_id = ? AND g.result = 'black') OR (g.black_user_id = ? AND g.result = 'white'))`;
    params.push(userId, userId);
  } else if (result === 'draw') {
    where += ` AND g.result = 'draw'`;
  } else if (result === 'abandoned') {
    where += ` AND g.result = 'abandoned'`;
  }

  if (gameType && gameType !== 'all') {
    where += ' AND g.game_type = ?';
    params.push(gameType);
  }

  if (playerType === 'hvai') {
    where += ' AND (g.white_is_ai + g.black_is_ai) = 1';
  } else if (playerType === 'hvh') {
    where += ' AND g.white_is_ai = 0 AND g.black_is_ai = 0';
  } else if (playerType === 'avai') {
    where += ' AND g.white_is_ai = 1 AND g.black_is_ai = 1';
  }

  if (timeControl && timeControl !== 'all') {
    where += ' AND g.time_control = ?';
    params.push(timeControl);
  }

  if (eloMin) {
    const min = parseInt(eloMin, 10);
    if (!isNaN(min)) {
      where += ' AND (COALESCE(g.white_elo, 0) >= ? OR COALESCE(g.black_elo, 0) >= ?)';
      params.push(min, min);
    }
  }
  if (eloMax) {
    const max = parseInt(eloMax, 10);
    if (!isNaN(max)) {
      where += ' AND (g.white_elo IS NOT NULL AND g.white_elo <= ? OR g.black_elo IS NOT NULL AND g.black_elo <= ?)';
      params.push(max, max);
    }
  }

  if (opponent) {
    const oppUser = getUserByUsername(opponent);
    if (oppUser) {
      where += ' AND (g.white_user_id = ? OR g.black_user_id = ?)';
      params.push(oppUser.id, oppUser.id);
    }
  }

  const countParams = [...params];
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM games g WHERE ${where}`).get(...countParams);

  const rows = db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) as move_count
    FROM games g WHERE ${where}
    ORDER BY g.start_time DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const games = rows.map(row => ({
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    gameType: row.game_type,
    timeControl: row.time_control,
    white: { name: row.white_name, isAI: !!row.white_is_ai, elo: row.white_elo, engineId: row.white_engine, userId: row.white_user_id },
    black: { name: row.black_name, isAI: !!row.black_is_ai, elo: row.black_elo, engineId: row.black_engine, userId: row.black_user_id },
    result: row.result,
    resultReason: row.result_reason,
    rated: !!row.rated,
    moveCount: row.move_count
  }));

  return { games, total };
}

function claimGame(gameId, side, userId) {
  const column = side === 'white' ? 'white_user_id' : 'black_user_id';
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) return false;
  if (game[column] !== null) return false;
  db.prepare(`UPDATE games SET ${column} = ? WHERE id = ?`).run(userId, gameId);
  return true;
}

/** Create a local user (no WP). Uses negative wp_user_id as placeholder. */
function createLocalUser(username, displayName, passwordHash) {
  const now = Date.now();
  // Use a unique negative number for wp_user_id (local-only users)
  const minRow = db.prepare('SELECT MIN(wp_user_id) AS m FROM users').get();
  const wpId = Math.min((minRow.m || 0) - 1, -1);
  db.prepare(`
    INSERT INTO users (wp_user_id, username, display_name, password_hash, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wpId, username, displayName, passwordHash, now, now);
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

/** Get user by username including password_hash (for local auth). */
function getUserWithPassword(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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
  deleteGame,
  // User helpers
  upsertUser,
  getUserByWpId,
  getUserByUsername,
  getUserById,
  updateUser,
  formatUser,
  createLocalUser,
  getUserWithPassword,
  // Rating helpers
  getRatings,
  ensureRating,
  updateRatingRecord,
  addRatingHistory,
  getRatingHistory,
  // Friendship helpers
  createFriendship,
  respondFriendship,
  getFriendships,
  getFriendship,
  removeFriendship,
  // Settings helpers
  getSettings,
  updateSettings,
  // Game by user helpers
  listGamesByUser,
  claimGame
};
