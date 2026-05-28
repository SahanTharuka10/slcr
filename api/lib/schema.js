async function ensureDesktopSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS desktop_users (
      id VARCHAR(255) PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      "passwordHash" VARCHAR(255),
      "displayName" VARCHAR(255),
      active BOOLEAN DEFAULT true,
      "createdAt" BIGINT,
      "lastLoginAt" BIGINT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS desktop_user_activity (
      id VARCHAR(255) PRIMARY KEY,
      "userId" VARCHAR(255) NOT NULL,
      "tournamentId" VARCHAR(255),
      name VARCHAR(255),
      venue VARCHAR(255),
      "playedAt" VARCHAR(255),
      format VARCHAR(255),
      "matchCount" INTEGER,
      status VARCHAR(255),
      meta JSONB DEFAULT '{}',
      "createdAt" BIGINT
    );
  `);
}

function mapUserRow(row) {
  if (!row) return null;
  const pick = (...keys) => {
    for (const k of keys) {
      if (row[k] != null) return row[k];
    }
    return null;
  };
  return {
    id: pick('id'),
    username: pick('username'),
    displayName: pick('displayName', 'display_name'),
    active: pick('active') !== false,
    createdAt: pick('createdAt', 'created_at'),
    lastLoginAt: pick('lastLoginAt', 'last_login_at'),
  };
}

module.exports = { ensureDesktopSchema, mapUserRow };
