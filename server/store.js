/**
 * SLCRICKPRO – storage for the website API.
 * Postgres (DATABASE_URL, e.g. Supabase) in production; in-memory for local dev.
 * Tables are prefixed slc_ so older tables in the same database are untouched.
 */
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const usePg = /^postgres/.test(url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slc_matches (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  tournament_id TEXT,
  status TEXT NOT NULL,
  summary JSONB NOT NULL,
  data JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS slc_matches_tourn ON slc_matches (tournament_id);
CREATE INDEX IF NOT EXISTS slc_matches_upd ON slc_matches (updated_at DESC);
CREATE TABLE IF NOT EXISTS slc_tournaments (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  ended_at BIGINT
);
CREATE TABLE IF NOT EXISTS slc_rosters (
  token TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  team TEXT NOT NULL,
  display_name TEXT,
  players JSONB NOT NULL DEFAULT '[]',
  logo TEXT,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS slc_rosters_tourn ON slc_rosters (tournament_id);
`;

const num = (v) => (v == null ? null : Number(v));

function pgStore() {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
  const q = (text, params) => pool.query(text, params).then((r) => r.rows);
  const matchRow = (r) => r && { ...r, created_at: num(r.created_at), updated_at: num(r.updated_at), completed_at: num(r.completed_at) };
  const tournRow = (r) => r && { ...r, created_at: num(r.created_at), updated_at: num(r.updated_at), ended_at: num(r.ended_at) };
  return {
    kind: 'postgres',
    async init() {
      await q(SCHEMA);
    },
    async getMatch(id) {
      return matchRow((await q('SELECT * FROM slc_matches WHERE id=$1', [id]))[0]);
    },
    async putMatch(m) {
      await q(
        `INSERT INTO slc_matches (id,key_hash,tournament_id,status,summary,data,created_at,updated_at,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET key_hash=$2,tournament_id=$3,status=$4,summary=$5,data=$6,updated_at=$8,completed_at=$9`,
        [m.id, m.key_hash, m.tournament_id, m.status, m.summary, m.data, m.created_at, m.updated_at, m.completed_at]
      );
    },
    async deleteMatch(id) {
      await q('DELETE FROM slc_matches WHERE id=$1', [id]);
    },
    async listMatches({ tournamentId, since } = {}) {
      const rows = tournamentId
        ? await q('SELECT id,key_hash,tournament_id,status,summary,data,created_at,updated_at,completed_at FROM slc_matches WHERE tournament_id=$1', [tournamentId])
        : await q('SELECT id,key_hash,tournament_id,status,summary,created_at,updated_at,completed_at FROM slc_matches WHERE updated_at >= $1 OR completed_at >= $1 ORDER BY updated_at DESC LIMIT 600', [since || 0]);
      return rows.map(matchRow);
    },
    async getTournament(id) {
      return tournRow((await q('SELECT * FROM slc_tournaments WHERE id=$1', [id]))[0]);
    },
    async putTournament(t) {
      await q(
        `INSERT INTO slc_tournaments (id,key_hash,name,status,data,created_at,updated_at,ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET name=$3,status=$4,data=$5,updated_at=$7,ended_at=$8`,
        [t.id, t.key_hash, t.name, t.status, t.data, t.created_at, t.updated_at, t.ended_at]
      );
    },
    async getRoster(token) {
      return (await q('SELECT * FROM slc_rosters WHERE token=$1', [token]))[0] || null;
    },
    async putRoster(r) {
      await q(
        `INSERT INTO slc_rosters (token,tournament_id,team,display_name,players,logo,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (token) DO UPDATE SET display_name=$4,players=$5,logo=$6,updated_at=$7`,
        [r.token, r.tournament_id, r.team, r.display_name, JSON.stringify(r.players || []), r.logo || '', r.updated_at || 0]
      );
    },
    async listRosters(tournamentId) {
      return (await q('SELECT * FROM slc_rosters WHERE tournament_id=$1 ORDER BY team', [tournamentId])).map((r) => ({ ...r, updated_at: num(r.updated_at) }));
    },
    async deleteRosters(tournamentId) {
      await q('DELETE FROM slc_rosters WHERE tournament_id=$1', [tournamentId]);
    },
  };
}

function memoryStore() {
  const matches = new Map();
  const tourns = new Map();
  const rosters = new Map();
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    kind: 'memory',
    async init() {
      console.warn('[SLCRICKPRO] DATABASE_URL not set — using in-memory store (data is lost on restart)');
    },
    async getMatch(id) {
      return clone(matches.get(id)) || null;
    },
    async putMatch(m) {
      matches.set(m.id, clone(m));
    },
    async deleteMatch(id) {
      matches.delete(id);
    },
    async listMatches({ tournamentId, since } = {}) {
      return [...matches.values()]
        .filter((m) => (tournamentId ? m.tournament_id === tournamentId : m.updated_at >= (since || 0) || (m.completed_at || 0) >= (since || 0)))
        .map(clone);
    },
    async getTournament(id) {
      return clone(tourns.get(id)) || null;
    },
    async putTournament(t) {
      tourns.set(t.id, clone(t));
    },
    async getRoster(token) {
      return clone(rosters.get(token)) || null;
    },
    async putRoster(r) {
      rosters.set(r.token, clone(r));
    },
    async listRosters(tid) {
      return [...rosters.values()].filter((r) => r.tournament_id === tid).map(clone);
    },
    async deleteRosters(tid) {
      [...rosters.values()].filter((r) => r.tournament_id === tid).forEach((r) => rosters.delete(r.token));
    },
  };
}

module.exports = usePg ? pgStore() : memoryStore();
