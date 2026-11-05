import pool from '../config/db.js';
import { webpush } from '../config/vapid.js';

let schemaReady = false;

export async function ensureNotificationSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'new_lead',
      title VARCHAR(255) NOT NULL,
      body TEXT NULL,
      link VARCHAR(500) NULL,
      data JSON NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notifications_user_read (user_id, is_read),
      INDEX idx_notifications_created (created_at)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh VARCHAR(255) NOT NULL,
      auth VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_push_user (user_id)
    )
  `);
  schemaReady = true;
}

export async function getAdminUserIds() {
  const [rows] = await pool.query(
    `SELECT id FROM users WHERE role = 'admin'`
  );
  return rows.map((r) => r.id);
}

function frontendOrigin() {
  return (
    process.env.FRONTEND_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'https://unilinkweb.cyb360.com'
      : 'http://localhost:3000')
  ).replace(/\/$/, '');
}

/** Resolve login user id linked to a counselors.id profile. */
export async function getLoginUserIdForCounselorProfile(counselorProfileId) {
  if (!counselorProfileId) return null;
  const [rows] = await pool.query(
    `SELECT COALESCE(c.user_id, u.id) AS user_id
     FROM counselors c
     LEFT JOIN users u
       ON u.role = 'counselor' AND LOWER(u.email) = LOWER(c.email)
     WHERE c.id = ?
     LIMIT 1`,
    [counselorProfileId]
  );
  const userId = rows[0]?.user_id;
  return userId ? Number(userId) : null;
}

/**
 * Create in-app + push notifications for a list of user ids.
 */
export async function notifyUsers({
  userIds,
  type,
  title,
  body,
  link,
  data = {},
  tag,
  actions = [
    { action: 'view', title: 'View' },
    { action: 'dismiss', title: 'Dismiss' },
  ],
}) {
  await ensureNotificationSchema();
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return;

  const iconUrl = `${frontendOrigin()}/images/logo.webp`;
  const payloadData = { ...data, type, url: link };

  for (const userId of ids) {
    const [result] = await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link, data, is_read)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [userId, type, title, body, link || null, JSON.stringify(payloadData)]
    );
    await sendPushToUser(userId, {
      title,
      body,
      icon: iconUrl,
      badge: iconUrl,
      tag: tag || `${type}-${userId}-${Date.now()}`,
      data: {
        ...payloadData,
        notificationId: result.insertId,
      },
      actions,
    });
  }
}

/**
 * Create in-app notifications for all admins and send web push.
 */
export async function notifyAdminsOfNewLead({ leadId, fullName, email }) {
  const adminIds = await getAdminUserIds();
  if (!adminIds.length) {
    console.warn('notifyAdminsOfNewLead: no admin users found');
    return;
  }

  await notifyUsers({
    userIds: adminIds,
    type: 'new_lead',
    title: 'New Lead Submitted',
    body: `${fullName || 'A student'} submitted a new lead form${email ? ` (${email})` : ''}`,
    link: `/edit-lead/${leadId}`,
    data: { leadId, fullName, email },
    tag: `new-lead-${leadId}`,
    actions: [
      { action: 'view', title: 'View Lead' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
}

export async function notifyCounselorLeadAssigned({
  counselorProfileId,
  leadId,
  leadName,
  leadEmail,
}) {
  const userId = await getLoginUserIdForCounselorProfile(counselorProfileId);
  if (!userId) {
    console.warn('notifyCounselorLeadAssigned: no login user for counselor', counselorProfileId);
    return;
  }
  await notifyUsers({
    userIds: [userId],
    type: 'lead_assigned',
    title: 'New Lead Assigned',
    body: `${leadName || 'A lead'} was assigned to you${leadEmail ? ` (${leadEmail})` : ''}`,
    link: `/edit-lead/${leadId}`,
    data: { leadId, counselorProfileId, leadName, leadEmail },
    tag: `lead-assigned-${leadId}-${counselorProfileId}`,
    actions: [
      { action: 'view', title: 'View Lead' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
}

export async function notifyCounselorStudentAssigned({
  counselorProfileId,
  studentId,
  studentName,
  studentEmail,
}) {
  const userId = await getLoginUserIdForCounselorProfile(counselorProfileId);
  if (!userId) {
    console.warn('notifyCounselorStudentAssigned: no login user for counselor', counselorProfileId);
    return;
  }
  await notifyUsers({
    userIds: [userId],
    type: 'student_assigned',
    title: 'New Student Assigned',
    body: `${studentName || 'A student'} was assigned to you${studentEmail ? ` (${studentEmail})` : ''}`,
    link: `/edit-student/${studentId}`,
    data: { studentId, counselorProfileId, studentName, studentEmail },
    tag: `student-assigned-${studentId}-${counselorProfileId}`,
    actions: [
      { action: 'view', title: 'View Student' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
}

export async function notifyCounselorsLeadRegistered({
  counselorProfileIds,
  leadId,
  studentId,
  studentName,
  studentEmail,
}) {
  const userIds = [];
  for (const counselorProfileId of counselorProfileIds || []) {
    const userId = await getLoginUserIdForCounselorProfile(counselorProfileId);
    if (userId) userIds.push(userId);
  }
  if (!userIds.length) return;

  await notifyUsers({
    userIds,
    type: 'lead_registered',
    title: 'Lead Registered as Student',
    body: `${studentName || 'Your assigned lead'} has been registered as a student${studentEmail ? ` (${studentEmail})` : ''}`,
    link: studentId ? `/edit-student/${studentId}` : `/edit-lead/${leadId}`,
    data: { leadId, studentId, studentName, studentEmail },
    tag: `lead-registered-${leadId}`,
    actions: [
      { action: 'view', title: 'View Student' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
}

export async function sendPushToUser(userId, payload) {
  await ensureNotificationSchema();
  const [subs] = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`,
    [userId]
  );
  if (!subs.length) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body
        );
      } catch (err) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = ?`, [sub.id]);
        } else {
          console.warn('Push send failed:', status || err.message);
        }
      }
    })
  );
}

export async function savePushSubscription(userId, subscription) {
  await ensureNotificationSchema();
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error('Invalid push subscription');
  }

  const [existing] = await pool.query(
    `SELECT id FROM push_subscriptions WHERE endpoint = ? LIMIT 1`,
    [endpoint]
  );
  if (existing.length) {
    await pool.query(
      `UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE id = ?`,
      [userId, p256dh, auth, existing[0].id]
    );
    return existing[0].id;
  }

  const [result] = await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?)`,
    [userId, endpoint, p256dh, auth]
  );
  return result.insertId;
}

export async function removePushSubscription(userId, endpoint) {
  await ensureNotificationSchema();
  if (endpoint) {
    await pool.query(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`,
      [userId, endpoint]
    );
  } else {
    await pool.query(`DELETE FROM push_subscriptions WHERE user_id = ?`, [userId]);
  }
}

export async function listNotifications(userId, { filter = 'all', limit = 50 } = {}) {
  await ensureNotificationSchema();
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  let where = 'user_id = ?';
  const params = [userId];

  if (filter === 'unread') {
    where += ' AND is_read = 0';
  } else if (filter === 'read') {
    where += ' AND is_read = 1';
  }

  const [rows] = await pool.query(
    `SELECT id, type, title, body, link, data, is_read, created_at
     FROM notifications
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ${lim}`,
    params
  );

  return rows.map((row) => ({
    ...row,
    is_read: !!row.is_read,
    data: typeof row.data === 'string' ? safeParse(row.data) : row.data,
  }));
}

export async function getUnreadCount(userId) {
  await ensureNotificationSchema();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0`,
    [userId]
  );
  return Number(rows[0]?.count || 0);
}

export async function markNotificationRead(userId, notificationId) {
  await ensureNotificationSchema();
  const [result] = await pool.query(
    `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
    [notificationId, userId]
  );
  return result.affectedRows > 0;
}

export async function markAllNotificationsRead(userId) {
  await ensureNotificationSchema();
  const [result] = await pool.query(
    `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
    [userId]
  );
  return result.affectedRows;
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
