const bcrypt = require('bcryptjs');
const { mapUserRow } = require('./schema');

async function listUsers(db) {
  if (db.from) {
    const { data, error } = await db.from('desktop_users').select('*');
    if (error) throw error;
    return (data || []).map(mapUserRow).filter(Boolean);
  }
  const { rows } = await db.query('SELECT * FROM desktop_users');
  const users = rows.map(mapUserRow).filter(Boolean);
  users.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return users;
}

async function createUser(db, { username, password, displayName, newEntityId }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();
  const id = newEntityId('DU');
  const row = {
    id,
    username,
    passwordHash,
    displayName: displayName || username,
    active: true,
    createdAt: now,
    lastLoginAt: null,
  };

  if (db.from) {
    const { error } = await db.from('desktop_users').insert(row);
    if (error) throw error;
    return { id, username, displayName: row.displayName, active: true, createdAt: now };
  }

  await db.query(
    `INSERT INTO desktop_users (id, username, "passwordHash", "displayName", active, "createdAt", "lastLoginAt")
     VALUES ($1, $2, $3, $4, true, $5, NULL)`,
    [id, username, passwordHash, row.displayName, now]
  );
  return { id, username, displayName: row.displayName, active: true, createdAt: now };
}

async function findUserById(db, id) {
  if (db.from) {
    const { data, error } = await db.from('desktop_users').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return mapUserRow(data);
  }
  const { rows } = await db.query('SELECT * FROM desktop_users WHERE id = $1', [id]);
  return mapUserRow(rows[0]);
}

async function updateUser(db, id, updates) {
  if (db.from) {
    const { error } = await db.from('desktop_users').update(updates).eq('id', id);
    if (error) throw error;
    return;
  }
  const sets = [];
  const vals = [];
  let i = 1;
  if (typeof updates.active === 'boolean') {
    sets.push(`active = $${i++}`);
    vals.push(updates.active);
  }
  if (updates.displayName != null) {
    sets.push(`"displayName" = $${i++}`);
    vals.push(updates.displayName);
  }
  if (updates.passwordHash) {
    sets.push(`"passwordHash" = $${i++}`);
    vals.push(updates.passwordHash);
  }
  if (!sets.length) return;
  vals.push(id);
  await db.query(`UPDATE desktop_users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

async function deleteUser(db, id) {
  if (db.from) {
    await db.from('desktop_user_activity').delete().eq('userId', id);
    const { error } = await db.from('desktop_users').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  await db.query('DELETE FROM desktop_user_activity WHERE "userId" = $1', [id]);
  await db.query('DELETE FROM desktop_users WHERE id = $1', [id]);
}

async function listActivity(db, userId) {
  if (db.from) {
    const { data, error } = await db
      .from('desktop_user_activity')
      .select('*')
      .eq('userId', userId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  const { rows } = await db.query(
    `SELECT * FROM desktop_user_activity WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
    [userId]
  );
  return rows;
}

module.exports = {
  listUsers,
  createUser,
  findUserById,
  updateUser,
  deleteUser,
  listActivity,
  bcrypt,
};
