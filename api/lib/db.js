const { Pool } = require('pg');
const { ensureDesktopSchema } = require('./schema');

let pool;
let schemaReady;

function getPool() {
  if (!process.env.DATABASE_URL) {
    const err = new Error(
      'DATABASE_URL is not set on Vercel. Add your Supabase Postgres URL in Project → Settings → Environment Variables, then redeploy.'
    );
    err.code = 'NO_DATABASE_URL';
    throw err;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function getDb() {
  const db = getPool();
  if (!schemaReady) {
    await ensureDesktopSchema(db);
    schemaReady = true;
  }
  return db;
}

module.exports = { getPool, getDb };
