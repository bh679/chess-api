const jwt = require('jsonwebtoken');
const { getUserByWpId } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Required authentication — returns 401 if no valid token
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const wpUserId = decoded.data && decoded.data.user ? decoded.data.user.id : decoded.sub;
    const user = getUserByWpId(wpUserId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional authentication — attaches user if token present, continues either way
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const wpUserId = decoded.data && decoded.data.user ? decoded.data.user.id : decoded.sub;
    req.user = getUserByWpId(wpUserId);
  } catch (e) {
    req.user = null;
  }
  next();
}

module.exports = { requireAuth, optionalAuth, JWT_SECRET };
