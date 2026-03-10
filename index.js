const http = require('http');
const express = require('express');
const path = require('path');
const { initDb } = require('./db');
const gamesRouter = require('./routes/games');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const friendsRouter = require('./routes/friends');
const settingsRouter = require('./routes/settings');
const gameHistoryRouter = require('./routes/game-history');
const roomsRouter = require('./routes/rooms');
const iceServersRouter = require('./routes/ice-servers');
const diagnosticsRouter = require('./routes/diagnostics');
const { initWebSocket } = require('./ws');
const { version } = require('./package.json');
const { cleanupOldDiagnostics } = require('./db');

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
app.get('/api/chess/health', (req, res) => {
  res.json({ status: 'ok', version });
});

// Game routes
app.use('/api/chess', gamesRouter);

// User account routes
app.use('/api/chess/auth', authRouter);
app.use('/api/chess', usersRouter);
app.use('/api/chess', friendsRouter);
app.use('/api/chess', settingsRouter);
app.use('/api/chess', gameHistoryRouter);
app.use('/api/chess', roomsRouter);
app.use('/api/chess', iceServersRouter);
app.use('/api/chess', diagnosticsRouter);

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

// Clean up old diagnostic events (30 days) on startup and daily
cleanupOldDiagnostics();
setInterval(() => cleanupOldDiagnostics(), 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3002;
const server = http.createServer(app);
initWebSocket(server);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Chess API listening on 127.0.0.1:${PORT}`);
});
