const express = require('express');
const { initDb } = require('./db');
const gamesRouter = require('./routes/games');
const { version } = require('./package.json');

// Initialize database
initDb();

const app = express();
app.use(express.json());

// Health check — includes server version so clients can verify compatibility
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version });
});

// Game routes
app.use('/api', gamesRouter);

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Chess API listening on 127.0.0.1:${PORT}`);
});
