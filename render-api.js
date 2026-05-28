#!/usr/bin/env node
/**
 * Render entry — desktop users + version API (Postgres). Lightweight vs full server/app.js.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'server', '.env') });
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('./api/lib/desktop-db');
const {
  ADMIN_PIN,
  ADMIN_TOKEN_TTL_MS,
  createAdminToken,
  requireAdmin,
} = require('./api/lib/admin-auth');

const BUILD = '1.0.9';
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/ping', (req, res) => {
  res.json({
    status: 'alive',
    build: BUILD,
    entry: 'render-api.js',
    features: { desktopUsers: true },
    time: new Date().toISOString(),
  });
});

app.get('/api/version', (req, res) => {
  res.json({
    app: 'SLCRICKPRO',
    version: BUILD,
    entry: 'render-api.js',
    features: { desktopUsers: true, desktopLogin: true },
    db: process.env.DATABASE_URL ? 'postgres' : 'missing',
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    service: 'SLCRICKPRO_SERVER_UP',
    build: BUILD,
    entry: 'render-api.js',
    features: { desktopUsers: true, desktopLogin: true },
  });
});

app.post('/api/admin/login', (req, res) => {
  const body = req.body || {};
  const submitted = String(body.pin || body.password || '').trim();
  if (submitted === ADMIN_PIN) {
    res.json({
      success: true,
      token: createAdminToken(),
      expiresInMs: ADMIN_TOKEN_TTL_MS,
      source: 'render-api',
    });
    return;
  }
  res.status(401).json({ success: false, message: 'Wrong PIN. Check your credentials.' });
});

app.get('/api/admin/desktop-users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.listUsers()
    .then((users) => res.json({ users, source: 'render-api' }))
    .catch((e) => res.status(500).json({ error: e.message }));
});

app.post('/api/admin/desktop-users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '').trim();
  const displayName = String(body.displayName || body.username || '').trim();
  if (!username || username.length < 2) {
    return res.status(400).json({ error: 'Username required (min 2 characters)' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Password required (min 4 characters)' });
  }
  try {
    const user = await db.createUser({ username, password, displayName });
    res.json({ ok: true, user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.patch('/api/admin/desktop-users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await db.updateUser(req.params.id, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/admin/desktop-users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await db.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/admin/desktop-users/:id/activity', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await db.getActivity(req.params.id);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function startServer() {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SLCRICKPRO] render-api.js ${BUILD} listening on :${PORT}`);
    console.log('[SLCRICKPRO] DATABASE_URL:', process.env.DATABASE_URL ? 'set' : 'MISSING');
  });
}

module.exports = { app, startServer };

if (require.main === module) {
  startServer();
}
