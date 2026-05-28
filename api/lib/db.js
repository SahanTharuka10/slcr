const { Client } = require('pg');
const { ensureDesktopSchema } = require('./schema');

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.SUPABASE_DB_URL ||
    ''
  ).trim();
}

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ''
  ).trim();
  if (!url || !key) return null;
  return { url, key };
}

function missingDbError() {
  const err = new Error(
    'Database not configured on Vercel. Add DATABASE_URL (Supabase postgres://… from Render) ' +
      'or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, then redeploy.'
  );
  err.code = 'NO_DATABASE';
  return err;
}

async function withPgClient(fn) {
  const connectionString = getDatabaseUrl();
  if (!connectionString) return null;

  const client = new Client({
    connectionString,
    ssl: connectionString.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await ensureDesktopSchema(client);
    return await fn(client);
  } finally {
    await client.end();
  }
}

let supabaseClient;

function getSupabase() {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;
  if (!supabaseClient) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(cfg.url, cfg.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

async function withSupabase(fn) {
  const sb = getSupabase();
  if (!sb) return null;
  return fn(sb);
}

/**
 * Run DB work using Postgres (preferred) or Supabase JS fallback.
 */
async function withDb(fn) {
  const pgResult = await withPgClient(fn);
  if (pgResult !== null) return pgResult;

  const sbResult = await withSupabase(fn);
  if (sbResult !== null) return sbResult;

  throw missingDbError();
}

module.exports = {
  withDb,
  withPgClient,
  withSupabase,
  getDatabaseUrl,
  getSupabaseConfig,
  missingDbError,
};
