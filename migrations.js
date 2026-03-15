'use strict';

/**
 * All schema migrations for chess-api.
 *
 * runMigrations(db) is idempotent — safe to call on every startup.
 * Add new migrations at the end of the array; never reorder existing ones.
 */

const MIGRATIONS = [
  {
    name: 'add_engine_columns_to_games',
    run(db) {
      try {
        db.exec(`ALTER TABLE games ADD COLUMN white_engine TEXT`);
      } catch (e) { /* column already exists */ }
      try {
        db.exec(`ALTER TABLE games ADD COLUMN black_engine TEXT`);
      } catch (e) { /* column already exists */ }
    },
  },
  {
    name: 'deduplicate_moves_and_add_unique_index',
    run(db) {
      try {
        db.exec(`
          DELETE FROM moves WHERE id NOT IN (
            SELECT MIN(id) FROM moves GROUP BY game_id, ply
          )
        `);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_moves_game_ply ON moves(game_id, ply)`);
      } catch (e) {
        // Index may already exist or table may be empty; ignore
      }
    },
  },
  {
    name: 'normalize_game_results',
    run(db) {
      db.exec(`
        UPDATE games SET result = '1-0' WHERE result = 'white';
        UPDATE games SET result = '0-1' WHERE result = 'black';
        UPDATE games SET result = '1/2-1/2' WHERE result = 'draw';
      `);
    },
  },
  {
    name: 'add_user_columns_to_games',
    run(db) {
      const cols = [
        `ALTER TABLE games ADD COLUMN white_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
        `ALTER TABLE games ADD COLUMN black_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
        `ALTER TABLE games ADD COLUMN white_rating_before REAL`,
        `ALTER TABLE games ADD COLUMN black_rating_before REAL`,
        `ALTER TABLE games ADD COLUMN white_rating_after REAL`,
        `ALTER TABLE games ADD COLUMN black_rating_after REAL`,
        `ALTER TABLE games ADD COLUMN rated INTEGER NOT NULL DEFAULT 0`,
      ];
      for (const sql of cols) {
        try { db.exec(sql); } catch (e) { /* column already exists */ }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_games_white_user ON games(white_user_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_games_black_user ON games(black_user_id)`);
    },
  },
  {
    name: 'add_password_hash_to_users',
    run(db) {
      try {
        db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
      } catch (e) { /* column already exists */ }
    },
  },
  {
    name: 'add_room_code_to_issue_reports',
    run(db) {
      const cols = db.prepare('PRAGMA table_info(issue_reports)').all().map(c => c.name);
      if (!cols.includes('room_code')) {
        db.exec(`ALTER TABLE issue_reports ADD COLUMN room_code TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_issue_reports_room_code ON issue_reports(room_code)`);
      }
    },
  },
];

function runMigrations(db) {
  const migrate = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      migration.run(db);
      console.log(`[migrations] ran: ${migration.name}`);
    }
  });
  migrate();
}

module.exports = { runMigrations };
