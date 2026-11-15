#!/usr/bin/env node
/**
 * SLCRICKPRO – website API (Render) + static site (local dev).
 *
 * Matches and tournaments are pushed by the SLCRICKPRO desktop app (or the web
 * scorer) when the scorer picks "Online". The first push returns a write key;
 * only the holder of that key can update or delete the record later.
 *
 *  GET    /api/matches?view=ongoing|past|tournament&tournament=ID
 *  GET    /api/matches/:id
 *  POST   /api/matches               { match }            → { key } (first time)
 *  PUT    /api/matches/:id           { match }  x-write-key
 *  DELETE /api/matches/:id                      x-write-key
 *  POST   /api/tournaments           { tournament }       → { key } (first time)
 *  PUT    /api/tournaments/:id       { tournament } x-write-key
 *  GET    /api/tournaments/:id       public view (+ fixtures, roster status)
 *  POST   /api/tournaments/:id/invites               x-write-key → team links
 *  GET    /api/tournaments/:id/rosters               x-write-key → full rosters
 *  POST   /api/tournaments/:id/end                   x-write-key → clears photos
 *  GET    /api/roster/:token         team registration form data
 *  PUT    /api/roster/:token         { displayName, players[{no,name,photo}], logo }
 *
 * Ongoing = live/paused (updated in the last 24h) + finished in the last 24h.
 * Past    = finished more than 24h ago (grouped by tournament on the site).
 */
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, 'server', '.env') });
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const store = require('./server/store');

const BUILD = '2.0.0';
const DAY = 24 * 60 * 60 * 1000;
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: true }));
app.use(express.json({ limit: '6mb' }));

// ── helpers ─────────────────────────────────────────────────────
const newKey = () => crypto.randomBytes(24).toString('base64url');
const newToken = () => crypto.randomBytes(9).toString('base64url');
const hash = (k) => crypto.createHash('sha256').update(String(k || '')).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const keyOf = (req) => req.get('x-write-key') || (req.body && req.body.key) || '';
const cleanId = (id) => String(id || '').replace(/[^\w.-]/g, '').slice(0, 80);
const str = (v, n = 80) => String(v == null ? '' : v).trim().slice(0, n);

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

/** Very small per-IP limiter for writes. */
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || 'x';
    const now = Date.now();
    const h = hits.get(ip) || { n: 0, t: now };
    if (now - h.t > windowMs) {
      h.n = 0;
      h.t = now;
    }
    h.n++;
    hits.set(ip, h);
    if (h.n > max) return fail(res, 429, 'Too many requests — slow down');
    next();
  };
}
setInterval(() => {
  const cut = Date.now() - 10 * 60 * 1000;
  hits.forEach((h, ip) => h.t < cut && hits.delete(ip));
}, 60 * 1000).unref();

/** Public copy of a match: no photos, no undo history, no keys. */
function publicMatch(m) {
  if (!m || typeof m !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(m));
  ['history', 'redoStack', 'teamPhotos', 'broadcastLivePhotos', 'scoringPassword', 'password', 'key',
    '_scoringUi', '_pendingUiConsumer', 'obsOverlaySettings', 'rosters'].forEach((k) => delete copy[k]);
  (copy.innings || []).forEach((inn) => {
    if (!inn) return;
    (inn.batsmen || []).forEach((b) => delete b.photo);
    (inn.bowlers || []).forEach((b) => delete b.photo);
  });
  return copy;
}

function oversText(balls, bpo) {
  const b = balls || 0;
  const p = bpo || 6;
  return `${Math.floor(b / p)}.${b % p}`;
}

/** Small list row computed at write time. */
function summaryOf(m) {
  const innings = (m.innings || []).filter(Boolean).map((i) => ({
    team: str(i.battingTeam, 60),
    runs: i.runs || 0,
    wickets: i.wickets || 0,
    overs: oversText(i.balls, m.ballsPerOver),
  }));
  return {
    id: m.id,
    team1: str(m.team1, 60),
    team2: str(m.team2, 60),
    status: m.status || 'live',
    result: str(m.result || m.resultText, 140),
    winner: str(m.winner, 60),
    overs: m.overs || null,
    venue: str(m.venue, 60),
    tournamentId: m.tournamentId || null,
    tournamentName: str(m.tournamentName, 80),
    stage: str((m.knockout && m.knockout.roundName) || m.groupName, 40),
    innings,
    currentInnings: m.currentInnings || 0,
    toss: m.tossWinner ? `${str(m.tossWinner, 60)} won the toss and chose to ${m.tossDecision === 'bowl' ? 'bowl' : 'bat'}` : '',
  };
}

function viewOf(row, now = Date.now()) {
  const s = row.status;
  const upd = row.updated_at || 0;
  const done = row.completed_at || 0;
  if (s === 'completed') return now - done < DAY ? 'ongoing' : 'past';
  if (s === 'live' || s === 'paused') return now - upd < DAY ? 'ongoing' : 'past';
  return 'scheduled';
}

function listRow(row) {
  return { ...row.summary, updatedAt: row.updated_at, completedAt: row.completed_at || null, view: viewOf(row) };
}

async function authMatch(req, res) {
  const id = cleanId(req.params.id);
  const row = await store.getMatch(id);
  if (!row) {
    fail(res, 404, 'Match not found');
    return null;
  }
  if (!safeEq(row.key_hash, hash(keyOf(req)))) {
    fail(res, 403, 'Wrong write key');
    return null;
  }
  return row;
}

async function authTournament(req, res) {
  const id = cleanId(req.params.id);
  const row = await store.getTournament(id);
  if (!row) {
    fail(res, 404, 'Tournament not found');
    return null;
  }
  if (!safeEq(row.key_hash, hash(keyOf(req)))) {
    fail(res, 403, 'Wrong write key');
    return null;
  }
  return row;
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[api]', req.method, req.path, e);
  fail(res, 500, e.message || 'Server error');
});

// ── status ──────────────────────────────────────────────────────
app.get(['/api/ping', '/api/status'], (req, res) =>
  res.json({ ok: true, status: 'alive', build: BUILD, db: store.kind, time: new Date().toISOString() })
);
app.get('/api/version', (req, res) => res.json({ app: 'SLCRICKPRO', version: BUILD, db: store.kind }));

// ── matches ─────────────────────────────────────────────────────
app.get('/api/matches', wrap(async (req, res) => {
  const view = String(req.query.view || 'ongoing');
  const tid = cleanId(req.query.tournament);
  const rows = await store.listMatches(tid ? { tournamentId: tid } : { since: view === 'past' ? 0 : Date.now() - 3 * DAY });
  const now = Date.now();
  let out = rows;
  if (!tid) out = rows.filter((r) => viewOf(r, now) === view);
  out.sort((a, b) => (b.completed_at || b.updated_at) - (a.completed_at || a.updated_at));
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, matches: out.slice(0, 300).map(listRow) });
}));

app.get('/api/matches/:id', wrap(async (req, res) => {
  const row = await store.getMatch(cleanId(req.params.id));
  if (!row) return fail(res, 404, 'Match not found');
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, match: row.data, view: viewOf(row), updatedAt: row.updated_at });
}));

async function saveMatch(req, res, existing) {
  const m = publicMatch(req.body && req.body.match);
  if (!m || !m.id) return fail(res, 400, 'match.id required');
  const id = cleanId(m.id);
  m.id = id;
  const now = Date.now();
  const status = ['live', 'paused', 'completed', 'scheduled'].includes(m.status) ? m.status : 'live';
  const completedAt = status === 'completed' ? (existing && existing.completed_at) || now : null;
  let key = null;
  let keyHash = existing && existing.key_hash;
  if (!existing) {
    key = newKey();
    keyHash = hash(key);
  }
  await store.putMatch({
    id,
    key_hash: keyHash,
    tournament_id: cleanId(m.tournamentId) || null,
    status,
    summary: summaryOf(m),
    data: m,
    created_at: (existing && existing.created_at) || now,
    updated_at: now,
    completed_at: completedAt,
  });
  res.json({ ok: true, id, key, view: viewOf({ status, updated_at: now, completed_at: completedAt }) });
}

app.post('/api/matches', limit(240, 60 * 1000), wrap(async (req, res) => {
  const id = cleanId(req.body && req.body.match && req.body.match.id);
  if (!id) return fail(res, 400, 'match.id required');
  const existing = await store.getMatch(id);
  if (existing) {
    if (!safeEq(existing.key_hash, hash(keyOf(req)))) return fail(res, 409, 'Match already exists — write key required');
    return saveMatch(req, res, existing);
  }
  return saveMatch(req, res, null);
}));

app.put('/api/matches/:id', limit(240, 60 * 1000), wrap(async (req, res) => {
  const row = await authMatch(req, res);
  if (!row) return;
  req.body.match = { ...(req.body.match || {}), id: row.id };
  return saveMatch(req, res, row);
}));

app.delete('/api/matches/:id', wrap(async (req, res) => {
  const row = await authMatch(req, res);
  if (!row) return;
  await store.deleteMatch(row.id);
  res.json({ ok: true });
}));

// ── tournaments ─────────────────────────────────────────────────
function publicTournament(t) {
  const copy = JSON.parse(JSON.stringify(t || {}));
  ['rosters', 'scoringPassword', 'standings', 'key', 'teamPhotos'].forEach((k) => delete copy[k]);
  return copy;
}

app.post('/api/tournaments', limit(60, 60 * 1000), wrap(async (req, res) => {
  const t = publicTournament(req.body && req.body.tournament);
  const id = cleanId(t.id);
  if (!id || !t.name) return fail(res, 400, 'tournament.id and name required');
  const existing = await store.getTournament(id);
  let key = null;
  if (existing && !safeEq(existing.key_hash, hash(keyOf(req)))) return fail(res, 409, 'Tournament exists — write key required');
  if (!existing) key = newKey();
  const now = Date.now();
  await store.putTournament({
    id,
    key_hash: existing ? existing.key_hash : hash(key),
    name: str(t.name, 80),
    status: (existing && existing.status) || 'active',
    data: t,
    created_at: (existing && existing.created_at) || now,
    updated_at: now,
    ended_at: (existing && existing.ended_at) || null,
  });
  res.json({ ok: true, id, key });
}));

app.put('/api/tournaments/:id', wrap(async (req, res) => {
  const row = await authTournament(req, res);
  if (!row) return;
  const t = publicTournament(req.body && req.body.tournament);
  await store.putTournament({ ...row, name: str(t.name || row.name, 80), data: { ...t, id: row.id }, updated_at: Date.now() });
  res.json({ ok: true });
}));

app.get('/api/tournaments/:id', wrap(async (req, res) => {
  const row = await store.getTournament(cleanId(req.params.id));
  if (!row) return fail(res, 404, 'Tournament not found');
  const matches = await store.listMatches({ tournamentId: row.id });
  const rosters = await store.listRosters(row.id);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    tournament: { ...row.data, id: row.id, name: row.name, status: row.status, endedAt: row.ended_at },
    matches: matches.map(listRow),
    teams: rosters.map((r) => ({ team: r.team, displayName: r.display_name, players: (r.players || []).length, updatedAt: r.updated_at })),
  });
}));

app.post('/api/tournaments/:id/invites', wrap(async (req, res) => {
  const row = await authTournament(req, res);
  if (!row) return;
  if (row.status === 'ended') return fail(res, 410, 'Tournament has ended');
  const teams = [...new Set(((req.body && req.body.teams) || row.data.teams || []).map((t) => str(t, 60)).filter(Boolean))].slice(0, 64);
  const existing = await store.listRosters(row.id);
  const out = [];
  for (const team of teams) {
    let r = existing.find((x) => x.team === team);
    if (!r) {
      r = { token: newToken(), tournament_id: row.id, team, display_name: team, players: [], logo: '', updated_at: 0 };
      await store.putRoster(r);
    }
    out.push({ team, token: r.token, players: (r.players || []).length });
  }
  res.json({ ok: true, invites: out });
}));

app.get('/api/tournaments/:id/rosters', wrap(async (req, res) => {
  const row = await authTournament(req, res);
  if (!row) return;
  const rosters = await store.listRosters(row.id);
  res.json({
    ok: true,
    rosters: rosters.map((r) => ({ team: r.team, displayName: r.display_name, players: r.players || [], logo: r.logo || '', updatedAt: r.updated_at })),
  });
}));

/** End: delete every roster (names, numbers, photos, logos) and strip photos from matches. */
app.post('/api/tournaments/:id/end', wrap(async (req, res) => {
  const row = await authTournament(req, res);
  if (!row) return;
  await store.deleteRosters(row.id);
  const matches = await store.listMatches({ tournamentId: row.id });
  for (const m of matches) {
    const data = publicMatch(m.data);
    await store.putMatch({ ...m, data });
  }
  const now = Date.now();
  await store.putTournament({ ...row, status: 'ended', ended_at: now, updated_at: now, data: { ...row.data, champion: (req.body && req.body.champion) || row.data.champion || '' } });
  res.json({ ok: true });
}));

// ── team registration (link sent to each team) ──────────────────
app.get('/api/roster/:token', wrap(async (req, res) => {
  const r = await store.getRoster(cleanId(req.params.token));
  if (!r) return fail(res, 404, 'This link is not valid any more');
  const t = await store.getTournament(r.tournament_id);
  if (!t || t.status === 'ended') return fail(res, 410, 'This tournament has ended');
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, tournament: { id: t.id, name: t.name, overs: t.data.overs, playersPerSide: t.data.playersPerSide || 11 }, team: r.team, displayName: r.display_name, players: r.players || [], logo: r.logo || '' });
}));

app.put('/api/roster/:token', limit(30, 60 * 1000), wrap(async (req, res) => {
  const r = await store.getRoster(cleanId(req.params.token));
  if (!r) return fail(res, 404, 'This link is not valid any more');
  const t = await store.getTournament(r.tournament_id);
  if (!t || t.status === 'ended') return fail(res, 410, 'This tournament has ended');
  const body = req.body || {};
  const okImg = (s) => (typeof s === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(s) && s.length < 450 * 1024 ? s : '');
  const players = (Array.isArray(body.players) ? body.players : [])
    .slice(0, 25)
    .map((p) => ({ no: str(p.no, 4), name: str(p.name, 40), role: str(p.role, 20), photo: okImg(p.photo) }))
    .filter((p) => p.name);
  await store.putRoster({ ...r, display_name: str(body.displayName || r.team, 60), players, logo: okImg(body.logo), updated_at: Date.now() });
  res.json({ ok: true, players: players.length });
}));

// ── static site (Render / local; Vercel serves the same files) ───
// Only the public site — never server source, scripts or config files.
app.use((req, res, next) => {
  const p = req.path;
  const blocked =
    /^\/(server|scripts|node_modules|api)(\/|$)/.test(p) ||
    (/^\/[^/]+\.(js|json|md|ya?ml|sql|lock|env)$/i.test(p) && !/^\/(manifest\.json|sw\.js)$/.test(p));
  if (blocked) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, {
  dotfiles: 'ignore',
  extensions: ['html'],
  index: 'index.html',
  setHeaders: (res, p) => {
    if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use('/api', (req, res) => fail(res, 404, 'Unknown API route'));

function startServer() {
  const PORT = process.env.PORT || 3000;
  store.init().then(() => {
    app.listen(PORT, () => console.log(`[SLCRICKPRO] site API ${BUILD} on :${PORT} (db: ${store.kind})`));
  });
}

module.exports = { app, startServer };
if (require.main === module) startServer();
