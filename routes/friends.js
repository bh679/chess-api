const express = require('express');
const { getUserByUsername, getUserById, createFriendship, respondFriendship, getFriendships, getFriendship, removeFriendship } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/friends — list friends and pending requests
router.get('/friends', requireAuth, (req, res) => {
  const data = getFriendships(req.user.id);

  const formatFriend = (f) => ({
    friendshipId: f.id,
    username: f.username,
    displayName: f.display_name,
    avatarUrl: f.avatar_url,
    since: f.updated_at
  });

  res.json({
    friends: data.friends.map(formatFriend),
    pendingIncoming: data.pendingIncoming.map(formatFriend),
    pendingOutgoing: data.pendingOutgoing.map(formatFriend)
  });
});

// POST /api/friends/request — send friend request
router.post('/friends/request', requireAuth, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const target = getUserByUsername(username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot friend yourself' });

  const existing = getFriendship(req.user.id, target.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    if (existing.status === 'pending') return res.status(409).json({ error: 'Request already pending' });
    if (existing.status === 'blocked') return res.status(403).json({ error: 'Unable to send request' });
  }

  createFriendship(req.user.id, target.id);
  res.json({ ok: true });
});

// POST /api/friends/respond — accept or reject friend request
router.post('/friends/respond', requireAuth, (req, res) => {
  const { friendshipId, action } = req.body;
  if (!friendshipId || !action) {
    return res.status(400).json({ error: 'friendshipId and action are required' });
  }
  if (action !== 'accept' && action !== 'reject') {
    return res.status(400).json({ error: 'Action must be accept or reject' });
  }

  const friendship = require('../db').getDb().prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId);
  if (!friendship) return res.status(404).json({ error: 'Request not found' });
  if (friendship.friend_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your request to respond to' });
  }
  if (friendship.status !== 'pending') {
    return res.status(409).json({ error: 'Request already handled' });
  }

  if (action === 'accept') {
    respondFriendship(friendshipId, 'accepted');
  } else {
    // Reject by deleting
    removeFriendship(friendship.user_id, friendship.friend_id);
  }

  res.json({ ok: true });
});

// DELETE /api/friends/:userId — remove friend
router.delete('/friends/:userId', requireAuth, (req, res) => {
  const friendId = parseInt(req.params.userId);
  if (!friendId) return res.status(400).json({ error: 'Invalid user ID' });

  const target = getUserById(friendId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  removeFriendship(req.user.id, friendId);
  res.sendStatus(204);
});

module.exports = router;
