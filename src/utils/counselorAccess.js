import bcrypt from 'bcrypt';
import pool from '../config/db.js';

export const COUNSELOR_MODULES = [
  'dashboard',
  'leads',
  'students',
  'applications',
  'visas',
  'finance',
  'master_data',
];

export function counselorPasswordFromName(name) {
  const first = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] || 'Counselor';
  return `${first}123@`;
}

export async function ensureCounselorUserLinkSchema() {
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'counselors' AND COLUMN_NAME = 'user_id'`
  );
  if (!cols.length) {
    await pool.query('ALTER TABLE counselors ADD COLUMN user_id INT NULL');
    console.log('✓ Added counselors.user_id');
  }
  await pool.query(
    'ALTER TABLE users MODIFY COLUMN role VARCHAR(50) NOT NULL'
  ).catch(() => {});
}

/**
 * Resolve counselors.id for a logged-in counselor user.
 */
export async function getCounselorProfileId(user) {
  if (!user || user.role !== 'counselor') return null;
  const userId = user.userId ?? user.id;
  const email = user.email;

  const [byUser] = await pool.query(
    'SELECT id FROM counselors WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (byUser.length) return byUser[0].id;

  if (email) {
    const [byEmail] = await pool.query(
      'SELECT id FROM counselors WHERE LOWER(email) = LOWER(?) LIMIT 1',
      [email]
    );
    if (byEmail.length) {
      await pool.query(
        'UPDATE counselors SET user_id = ? WHERE id = ? AND (user_id IS NULL OR user_id = 0)',
        [userId, byEmail[0].id]
      );
      return byEmail[0].id;
    }
  }
  return null;
}

export async function createOrUpdateCounselorUser({
  name,
  email,
  connection,
  resetPassword = false,
}) {
  const db = connection || pool;
  const trimmedEmail = String(email || '').trim().toLowerCase();
  const trimmedName = String(name || '').trim();
  if (!trimmedEmail || !trimmedName) {
    throw new Error('Counselor name and email are required for login account');
  }

  const plain = counselorPasswordFromName(trimmedName);
  const hashed = await bcrypt.hash(plain, 10);

  const [existing] = await db.query(
    'SELECT id, role FROM users WHERE LOWER(email) = ? LIMIT 1',
    [trimmedEmail]
  );

  let userId;
  if (existing.length) {
    userId = existing[0].id;
    if (existing[0].role === 'admin' || existing[0].role === 'client') {
      // Email already used by admin/student — cannot convert; skip login provisioning
      return { userId, plain, skippedRoleChange: true };
    }

    const shouldResetPassword = resetPassword || existing[0].role !== 'counselor';
    if (shouldResetPassword) {
      try {
        await db.query(
          `UPDATE users SET name = ?, password = ?, plain_password = ?, role = 'counselor', status = 'active'
           WHERE id = ?`,
          [trimmedName, hashed, plain, userId]
        );
      } catch (err) {
        if (err.code === 'ER_BAD_FIELD_ERROR') {
          await db.query(
            `UPDATE users SET name = ?, password = ?, role = 'counselor' WHERE id = ?`,
            [trimmedName, hashed, userId]
          );
        } else throw err;
      }
    } else {
      try {
        await db.query(
          `UPDATE users SET name = ?, role = 'counselor', status = 'active' WHERE id = ?`,
          [trimmedName, userId]
        );
      } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        await db.query(
          `UPDATE users SET name = ?, role = 'counselor' WHERE id = ?`,
          [trimmedName, userId]
        );
      }
    }
  } else {
    try {
      const [result] = await db.query(
        `INSERT INTO users (name, email, password, plain_password, role, status)
         VALUES (?, ?, ?, ?, 'counselor', 'active')`,
        [trimmedName, trimmedEmail, hashed, plain]
      );
      userId = result.insertId;
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        const [result] = await db.query(
          `INSERT INTO users (name, email, password, role)
           VALUES (?, ?, ?, 'counselor')`,
          [trimmedName, trimmedEmail, hashed]
        );
        userId = result.insertId;
      } else throw err;
    }
  }

  return { userId, plain, skippedRoleChange: false };
}

/**
 * Backfill login accounts for all counselors.
 * Password = first word of name + "123@"
 */
export async function backfillCounselorLoginAccounts() {
  await ensureCounselorUserLinkSchema();
  const [counselors] = await pool.query(
    'SELECT id, name, email, user_id FROM counselors ORDER BY id ASC'
  );

  let created = 0;
  let updated = 0;

  for (const c of counselors) {
    if (!c.email) continue;
    try {
      const { userId, skippedRoleChange } = await createOrUpdateCounselorUser({
        name: c.name,
        email: c.email,
      });
      if (userId && c.user_id !== userId) {
        await pool.query('UPDATE counselors SET user_id = ? WHERE id = ?', [userId, c.id]);
      }
      if (skippedRoleChange) {
        // still link user_id if empty for reference, but they log in as their existing role
        if (!c.user_id && userId) {
          await pool.query('UPDATE counselors SET user_id = ? WHERE id = ?', [userId, c.id]);
        }
      } else if (c.user_id) {
        updated += 1;
      } else {
        created += 1;
      }
    } catch (err) {
      console.warn(`Counselor login backfill failed for ${c.email}:`, err.message);
    }
  }

  console.log(`✓ Counselor login backfill: processed ${counselors.length} (new/linked ~${created}, updated ~${updated})`);
}
