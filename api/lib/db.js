const { Pool } = require('pg');

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (add it in Vercel → Settings → Environment Variables)');
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

module.exports = { getPool };
