const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

let pool;

function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith('postgres')) {
    throw new Error('DATABASE_URL not configured');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

async function ensureTables() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS desktop_users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(128) UNIQUE NOT NULL,
      "passwordHash" VARCHAR(255),
      "displayName" VARCHAR(255),
      active BOOLEAN DEFAULT true,
      "createdAt" BIGINT,
      "lastLoginAt" BIGINT,
      "updatedAt" TIMESTAMPTZ
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS desktop_user_activity (
      id VARCHAR(64) PRIMARY KEY,
      "userId" VARCHAR(64) NOT NULL,
      "tournamentId" VARCHAR(64),
      name VARCHAR(255),
      venue VARCHAR(255),
      "playedAt" VARCHAR(64),
      format VARCHAR(64),
      "matchCount" INTEGER DEFAULT 0,
      status VARCHAR(64),
      meta JSONB DEFAULT '{}',
      "createdAt" BIGINT,
      "updatedAt" TIMESTAMPTZ
    );
  `);
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function listUsers() {
  await ensureTables();
  const { rows } = await getPool().query(
    `SELECT id, username, "displayName", active, "createdAt", "lastLoginAt"
     FROM desktop_users ORDER BY "createdAt" DESC NULLS LAST`
  );
  return rows.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    active: u.active !== false,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  }));
}

async function createUser({ username, password, displayName }) {
  await ensureTables();
  const db = getPool();
  const uname = username.toLowerCase();
  const existing = await db.query('SELECT id FROM desktop_users WHERE LOWER(username) = $1', [uname]);
  if (existing.rows.length) {
    const err = new Error('Username already exists');
    err.status = 409;
    throw err;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();
  const id = newId('DU');
  await db.query(
    `INSERT INTO desktop_users (id, username, "passwordHash", "displayName", active, "createdAt", "lastLoginAt")
     VALUES ($1, $2, $3, $4, true, $5, NULL)`,
    [id, uname, passwordHash, displayName || username, now]
  );
  return {
    id,
    username: uname,
    displayName: displayName || username,
    active: true,
    createdAt: now,
  };
}

async function updateUser(id, { active, displayName, password }) {
  await ensureTables();
  const db = getPool();
  const cur = await db.query('SELECT id FROM desktop_users WHERE id = $1', [id]);
  if (!cur.rows.length) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  if (typeof active === 'boolean') {
    await db.query('UPDATE desktop_users SET active = $1, "updatedAt" = NOW() WHERE id = $2', [active, id]);
  }
  if (displayName != null) {
    await db.query('UPDATE desktop_users SET "displayName" = $1, "updatedAt" = NOW() WHERE id = $2', [
      String(displayName).trim(),
      id,
    ]);
  }
  if (password) {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query('UPDATE desktop_users SET "passwordHash" = $1, "updatedAt" = NOW() WHERE id = $2', [
      passwordHash,
      id,
    ]);
  }
}

async function deleteUser(id) {
  await ensureTables();
  const db = getPool();
  const cur = await db.query('SELECT id FROM desktop_users WHERE id = $1', [id]);
  if (!cur.rows.length) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  await db.query('DELETE FROM desktop_user_activity WHERE "userId" = $1', [id]);
  await db.query('DELETE FROM desktop_users WHERE id = $1', [id]);
}

async function getActivity(userId) {
  await ensureTables();
  const db = getPool();
  const userRes = await db.query(
    'SELECT id, username, "displayName" FROM desktop_users WHERE id = $1',
    [userId]
  );
  if (!userRes.rows.length) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  const actRes = await db.query(
    `SELECT id, "tournamentId", name, venue, "playedAt", format, "matchCount", status, "createdAt"
     FROM desktop_user_activity WHERE "userId" = $1 ORDER BY "createdAt" DESC NULLS LAST`,
    [userId]
  );
  return { user: userRes.rows[0], activity: actRes.rows };
}

module.exports = {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getActivity,
};
