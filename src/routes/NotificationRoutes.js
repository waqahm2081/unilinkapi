import express from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { vapidPublicKey } from '../config/vapid.js';
import {
  ensureNotificationSchema,
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  savePushSubscription,
  removePushSubscription,
} from '../services/notificationService.js';

const router = express.Router();

const adminOnly = [authenticateToken, authorizeRoles('admin')];

/** Prefer userId from JWT; fall back to id if present. */
function currentUserId(req) {
  return Number(req.user?.userId ?? req.user?.id);
}

// Use /admin-alerts (not /notifications) — many ad blockers silently block "notifications" URLs.

router.get('/admin-alerts/vapid-public-key', ...adminOnly, async (req, res) => {
  try {
    await ensureNotificationSchema();
    res.json({ success: true, publicKey: vapidPublicKey });
  } catch (error) {
    console.error('vapid key error:', error);
    res.status(500).json({ success: false, message: 'Failed to get VAPID key' });
  }
});

router.get('/admin-alerts/unread-count', ...adminOnly, async (req, res) => {
  try {
    const unreadCount = await getUnreadCount(currentUserId(req));
    res.json({ success: true, unreadCount });
  } catch (error) {
    console.error('unread count error:', error);
    res.status(500).json({ success: false, message: 'Failed to get unread count' });
  }
});

/** SSE stream for live unread updates (no page refresh). */
router.get('/admin-alerts/stream', ...adminOnly, async (req, res) => {
  try {
    await ensureNotificationSchema();
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to init alerts' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const userId = currentUserId(req);
  let lastCount = -1;
  let closed = false;

  const send = async () => {
    if (closed) return;
    try {
      const unreadCount = await getUnreadCount(userId);
      if (unreadCount !== lastCount) {
        lastCount = unreadCount;
        res.write(`event: unread\ndata: ${JSON.stringify({ unreadCount })}\n\n`);
      } else {
        res.write(`: ping\n\n`);
      }
    } catch (err) {
      console.warn('alert stream error:', err.message);
    }
  };

  await send();
  const interval = setInterval(send, 4000);

  req.on('close', () => {
    closed = true;
    clearInterval(interval);
  });
});

router.get('/admin-alerts', ...adminOnly, async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all').toLowerCase();
    const limit = req.query.limit;
    const userId = currentUserId(req);
    const notifications = await listNotifications(userId, { filter, limit });
    const unreadCount = await getUnreadCount(userId);
    res.json({ success: true, notifications, unreadCount });
  } catch (error) {
    console.error('list alerts error:', error);
    res.status(500).json({ success: false, message: 'Failed to load alerts' });
  }
});

router.post('/admin-alerts/read-all', ...adminOnly, async (req, res) => {
  try {
    const updated = await markAllNotificationsRead(currentUserId(req));
    res.json({ success: true, updated, unreadCount: 0 });
  } catch (error) {
    console.error('mark all read error:', error);
    res.status(500).json({ success: false, message: 'Failed to mark all as read' });
  }
});

router.post('/admin-alerts/:id/read', ...adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: 'Invalid alert id' });
    }
    const userId = currentUserId(req);
    const ok = await markNotificationRead(userId, id);
    const unreadCount = await getUnreadCount(userId);
    res.json({ success: true, updated: ok, unreadCount });
  } catch (error) {
    console.error('mark read error:', error);
    res.status(500).json({ success: false, message: 'Failed to mark as read' });
  }
});

router.post('/admin-alerts/push-subscribe', ...adminOnly, async (req, res) => {
  try {
    const subscription = req.body?.subscription || req.body;
    await savePushSubscription(currentUserId(req), subscription);
    res.json({ success: true, message: 'Subscribed to push alerts' });
  } catch (error) {
    console.error('subscribe error:', error);
    res.status(400).json({ success: false, message: error.message || 'Failed to subscribe' });
  }
});

router.post('/admin-alerts/push-unsubscribe', ...adminOnly, async (req, res) => {
  try {
    const endpoint = req.body?.endpoint || req.body?.subscription?.endpoint;
    await removePushSubscription(currentUserId(req), endpoint);
    res.json({ success: true, message: 'Unsubscribed' });
  } catch (error) {
    console.error('unsubscribe error:', error);
    res.status(500).json({ success: false, message: 'Failed to unsubscribe' });
  }
});

export default router;
