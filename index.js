const express = require('express');
const path = require('path');
const { initDb } = require('./db');
const gamesRouter = require('./routes/games');
const { version } = require('./package.json');

// Initialize database
initDb();

const app = express();

// Enable SharedArrayBuffer for multi-threaded WASM engines (Fairy-Stockfish)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.json());

// Dev mode: serve chess-client static files when CLIENT_DIR is set
if (process.env.CLIENT_DIR) {
  app.use(express.static(path.resolve(process.env.CLIENT_DIR)));
}

// Health check — includes server version so clients can verify compatibility
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version });
});

// Game routes
app.use('/api', gamesRouter);

// SPA catch-all: serve index.html for non-API, non-static paths
// This allows path-based URLs (/replay, /games) to load the app,
// which then redirects to the hash equivalent (/#/replay, /#/games)
if (process.env.CLIENT_DIR) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.resolve(process.env.CLIENT_DIR, 'index.html'));
  });
}

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Chess API listening on 127.0.0.1:${PORT}`);
});
