const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const multer = require('multer');
const socketIo = require('socket.io');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

const app = express();
const server = http.createServer(app);

// --- EMERGENCY DIAGNOSTICS ---
console.log('🚀 [STARTUP] Server process started');
console.log('🚀 [STARTUP] Node version:', process.version);
console.log('🚀 [STARTUP] Port:', process.env.PORT);

// Accept any origin and reflect it back to fully bypass strict CORS limitations
const io = socketIo(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key', 'x-scoring-token', 'session-token', 'Session-Token', 'x-slcrick-client']
  }
});

// ── CORS: Allow all origins (reflects request origin back) ───────────────────
const corsOptions = {
  origin: true, // Reflect ANY origin — simplest and most reliable cross-domain fix
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key', 'x-scoring-token', 'session-token', 'Session-Token', 'x-slcrick-client']
};
app.use(cors(corsOptions));

// Pre-flight: handled by cors middleware and manual fallback below
// app.options('*', cors(corsOptions));

// Hardcoded CORS safety net (catches any edge cases cors() misses)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // If origin header is present, reflect it; otherwise allow all with wildcard
  // Send credentials only when origin is explicitly present
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-api-key, x-scoring-token, session-token, Session-Token, x-slcrick-client');
  
  // Content Security Policy: Relaxed enough for the app's needs but providing basic protection
  res.setHeader('Content-Security-Policy', "default-src 'self' https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.socket.io https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: ws: wss:;");

  // Relax Permissions-Policy to allow unload events if needed
  res.setHeader('Permissions-Policy', 'unload=*'); 
  
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!req.headers['x-scoring-token'] && typeof auth === 'string' && auth.startsWith('Bearer ')) {
      req.headers['x-scoring-token'] = auth.slice(7).trim();
    }
    next();
});

app.use((req, res, next) => {
    console.log(`📡 [HTTP] ${req.method} ${req.url} (Origin: ${req.headers.origin || 'none'})`);
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health & ping — register BEFORE express.static so /api/version is not shadowed
app.get('/api/ping', (req, res) =>
  res.json({ status: 'alive', build: '1.0.7', time: new Date().toISOString() })
);
app.get('/api/version', (req, res) => {
  res.json({
    app: 'SLCRICKPRO',
    version: '1.0.7',
    features: { desktopUsers: true, desktopLogin: true },
    db: dbType || 'initializing',
  });
});
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    service: 'SLCRICKPRO_SERVER_UP',
    build: '1.0.7',
    features: { desktopUsers: true, desktopLogin: true },
    db: dbType || 'initializing',
  });
});
app.get('/health', async (req, res) => {
  try { await ensureDB(); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.use(express.static(path.join(__dirname, '..')));

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'..','index.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'..','pages','admin.html')));
app.get(['/admin_2003', '/admin-portal', '/admin/match-entry'], (req,res) => res.redirect('/admin'));

// Dedicated Master Overlay Route (Transparent OBS Source)
app.get('/overlay/live', (req,res) => res.sendFile(path.join(__dirname,'..','pages','overlay.html')));


// ─── Admin Login ─────────────────────────────────────────────────
// Simple PIN-based login. Username can be anything.
// Only the PIN matters. Change ADMIN_PIN to update your password.
const ADMIN_PIN = 'slcrickpro@2026';
const ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;
const ADMIN_SESSIONS = new Map();

const DESKTOP_USER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DESKTOP_USER_SESSIONS = new Map();

function createAdminSession() {
    const token = crypto.randomBytes(32).toString('hex');
    ADMIN_SESSIONS.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
    return token;
}

function validateAdminSession(token) {
    if (!token) return false;
    const expiry = ADMIN_SESSIONS.get(token);
    if (!expiry || expiry < Date.now()) {
        ADMIN_SESSIONS.delete(token);
        return false;
    }
    return true;
}

function getBearerToken(req) {
    const authHeader = req.headers.authorization || '';
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }
    return (
        req.headers['x-access-token'] ||
        req.headers['x-desktop-token'] ||
        req.headers['session-token'] ||
        ''
    );
}

function requireAdmin(req, res, next) {
    const token = getBearerToken(req);
    if (!validateAdminSession(token)) {
        return res.status(401).json({ success: false, message: 'Admin session expired. Log in again.' });
    }
    next();
}

function createDesktopUserSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    DESKTOP_USER_SESSIONS.set(token, { userId, exp: Date.now() + DESKTOP_USER_TOKEN_TTL_MS });
    return token;
}

function validateDesktopUserSession(token) {
    if (!token) return null;
    const row = DESKTOP_USER_SESSIONS.get(token);
    if (!row || row.exp < Date.now()) {
        DESKTOP_USER_SESSIONS.delete(token);
        return null;
    }
    return row.userId;
}

function requireDesktopUser(req, res, next) {
    const userId = validateDesktopUserSession(getBearerToken(req));
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Desktop login required.' });
    }
    req.desktopUserId = userId;
    next();
}

function newEntityId(prefix) {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

app.post('/api/admin/login', (req, res) => {
    // Ensure we get body regardless of content-type
    let body = req.body || {};
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
    }

    const { username, password, pin } = body;
    const submitted = (pin || password || '').trim();

    console.log(`[Admin Login] user="${username}" pin_length=${submitted.length}`);

    if (submitted === ADMIN_PIN) {
        console.log('[Admin Login] SUCCESS');
        const token = createAdminSession();
        res.json({ success: true, token, expiresInMs: ADMIN_TOKEN_TTL_MS });
    } else {
        console.warn(`[Admin Login] FAILED — submitted: "${submitted}"`);
        res.status(401).json({ success: false, message: 'Wrong PIN. Check your credentials.' });
    }
});

// Debug: verify server is live and see config
app.get('/api/admin/check', (req, res) => {
    const token = getBearerToken(req);
    const admin = validateAdminSession(token);
    res.json({ status: 'ok', pin_length: ADMIN_PIN.length, message: 'Server is running', admin });
});

// ─── Desktop app users (admin-managed) ───────────────────────────
app.get('/api/admin/desktop-users', requireAdmin, async (req, res) => {
    try {
        await ensureDB();
        const rows = await DesktopUser.findAll({ order: [['createdAt', 'DESC']] });
        res.json({
            users: rows.map((u) => ({
                id: u.id,
                username: u.username,
                displayName: u.displayName,
                active: u.active !== false,
                createdAt: u.createdAt,
                lastLoginAt: u.lastLoginAt,
            })),
        });
    } catch (e) {
        console.error('/api/admin/desktop-users GET', e);
        res.status(500).json({ error: e.message || 'Failed to list users' });
    }
});

app.post('/api/admin/desktop-users', requireAdmin, async (req, res) => {
    const body = parseBody(req) || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '').trim();
    const displayName = String(body.displayName || body.username || '').trim();

    if (!username || username.length < 2) {
        return res.status(400).json({ error: 'Username required (min 2 characters)' });
    }
    if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Password required (min 4 characters)' });
    }

    try {
        await ensureDB();
        const existing = await DesktopUser.findOne({ where: { username } });
        if (existing) return res.status(409).json({ error: 'Username already exists' });

        const passwordHash = await bcrypt.hash(password, 10);
        const now = Date.now();
        const user = await DesktopUser.create({
            id: newEntityId('DU'),
            username,
            passwordHash,
            displayName: displayName || username,
            active: true,
            createdAt: now,
            lastLoginAt: null,
        });

        res.json({
            ok: true,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                active: true,
                createdAt: user.createdAt,
            },
        });
    } catch (e) {
        console.error('/api/admin/desktop-users POST', e);
        res.status(500).json({ error: e.message || 'Failed to create user' });
    }
});

app.patch('/api/admin/desktop-users/:id', requireAdmin, async (req, res) => {
    const body = parseBody(req) || {};
    try {
        await ensureDB();
        const user = await DesktopUser.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const updates = {};
        if (typeof body.active === 'boolean') updates.active = body.active;
        if (body.displayName != null) updates.displayName = String(body.displayName).trim();
        if (body.password) {
            const pw = String(body.password).trim();
            if (pw.length < 4) return res.status(400).json({ error: 'Password min 4 characters' });
            updates.passwordHash = await bcrypt.hash(pw, 10);
        }
        await user.update(updates);
        res.json({ ok: true });
    } catch (e) {
        console.error('/api/admin/desktop-users PATCH', e);
        res.status(500).json({ error: e.message || 'Failed to update user' });
    }
});

app.delete('/api/admin/desktop-users/:id', requireAdmin, async (req, res) => {
    try {
        await ensureDB();
        const user = await DesktopUser.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await DesktopUserActivity.destroy({ where: { userId: user.id } });
        await user.destroy();
        res.json({ ok: true });
    } catch (e) {
        console.error('/api/admin/desktop-users DELETE', e);
        res.status(500).json({ error: e.message || 'Failed to delete user' });
    }
});

app.get('/api/admin/desktop-users/:id/activity', requireAdmin, async (req, res) => {
    try {
        await ensureDB();
        const user = await DesktopUser.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const rows = await DesktopUserActivity.findAll({
            where: { userId: user.id },
            order: [['createdAt', 'DESC']],
        });
        res.json({
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
            },
            activity: rows.map((a) => ({
                id: a.id,
                tournamentId: a.tournamentId,
                name: a.name,
                venue: a.venue,
                playedAt: a.playedAt,
                format: a.format,
                matchCount: a.matchCount,
                status: a.status,
                createdAt: a.createdAt,
            })),
        });
    } catch (e) {
        console.error('/api/admin/desktop-users/:id/activity', e);
        res.status(500).json({ error: e.message || 'Failed to load activity' });
    }
});

app.post('/api/desktop/login', async (req, res) => {
    const body = parseBody(req) || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '').trim();
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    try {
        await ensureDB();
        const user = await DesktopUser.findOne({ where: { username } });
        if (!user || user.active === false) {
            return res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
        const ok = await bcrypt.compare(password, user.passwordHash || '');
        if (!ok) return res.status(401).json({ success: false, message: 'Invalid username or password' });

        const token = createDesktopUserSession(user.id);
        await user.update({ lastLoginAt: Date.now() });
        res.json({
            success: true,
            token,
            expiresInMs: DESKTOP_USER_TOKEN_TTL_MS,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
            },
        });
    } catch (e) {
        console.error('/api/desktop/login', e);
        res.status(500).json({ success: false, message: e.message || 'Login failed' });
    }
});

app.get('/api/desktop/me', requireDesktopUser, async (req, res) => {
    try {
        await ensureDB();
        const user = await DesktopUser.findByPk(req.desktopUserId);
        if (!user || user.active === false) {
            return res.status(401).json({ success: false, message: 'Account inactive' });
        }
        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
            },
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message || 'Failed' });
    }
});

app.post('/api/desktop/activity', requireDesktopUser, async (req, res) => {
    const body = parseBody(req) || {};
    const tournamentId = body.tournamentId ? String(body.tournamentId) : null;
    const name = String(body.name || 'Tournament').trim();
    if (!name) return res.status(400).json({ error: 'Tournament name required' });

    try {
        await ensureDB();
        const now = Date.now();
        let row = null;
        if (tournamentId) {
            row = await DesktopUserActivity.findOne({
                where: { userId: req.desktopUserId, tournamentId },
            });
        }
        const payload = {
            userId: req.desktopUserId,
            tournamentId,
            name,
            venue: String(body.venue || '').trim() || null,
            playedAt: String(body.playedAt || body.date || '').trim() || null,
            format: String(body.format || '').trim() || null,
            matchCount: parseInt(body.matchCount, 10) || 0,
            status: String(body.status || 'scheduled').trim(),
            meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
            createdAt: now,
        };
        if (row) {
            await row.update(payload);
        } else {
            row = await DesktopUserActivity.create({ id: newEntityId('DUA'), ...payload });
        }
        res.json({ ok: true, id: row.id });
    } catch (e) {
        console.error('/api/desktop/activity', e);
        res.status(500).json({ error: e.message || 'Failed to save activity' });
    }
});

// --- DATABASE INITIALIZATION ---
const LOCAL_SQLITE_PATH = process.env.LOCAL_DB_PATH || path.join(__dirname, '..', 'slcrickpro.sqlite');
let DATABASE_URL = process.env.DATABASE_URL || '';
const FORCE_SQLITE = process.env.FORCE_SQLITE === 'true';

let dbType = 'sqlite';
let sequelize = new Sequelize({ dialect: 'sqlite', storage: LOCAL_SQLITE_PATH, logging: false });

let Player, Team, Match, Tournament, Product, Order, Post, Feedback, MatchReport, DesktopUser, DesktopUserActivity;

function defineModels(seq) {
  Player = seq.define('Player', {
    id: { type: DataTypes.STRING, primaryKey: true },
    name: DataTypes.STRING,
    dob: DataTypes.STRING,
    phone: DataTypes.STRING,
    address: DataTypes.STRING,
    team: DataTypes.STRING,
    role: DataTypes.STRING,
    batStyle: DataTypes.STRING,
    bowlStyle: DataTypes.STRING,
    jersey: DataTypes.JSON,
    photo: DataTypes.TEXT,
    createdAt: DataTypes.BIGINT,
    stats: { type: DataTypes.JSON, defaultValue: {} },
  }, { timestamps: true, tableName: 'players' });

  Team = seq.define('Team', {
    id: { type: DataTypes.STRING, primaryKey: true },
    name: DataTypes.STRING,
    ground: DataTypes.STRING,
    captain: DataTypes.STRING,
    manager: DataTypes.STRING,
    contact: DataTypes.STRING,
    year: DataTypes.STRING,
    createdAt: DataTypes.BIGINT,
    stats: { type: DataTypes.JSON, defaultValue: {} },
  }, { timestamps: true, tableName: 'teams' });

  Match = seq.define('Match', {
    id: { type: DataTypes.STRING, primaryKey: true },
    scoring_password: DataTypes.STRING,
    data: DataTypes.JSON,
  }, { timestamps: true, tableName: 'matches' });

  Tournament = seq.define('Tournament', {
    id: { type: DataTypes.STRING, primaryKey: true },
    scoring_password: DataTypes.STRING,
    data: DataTypes.JSON,
  }, { timestamps: true, tableName: 'tournaments' });

  Product = seq.define('Product', {
    id: { type: DataTypes.STRING, primaryKey: true },
    name: DataTypes.STRING,
    price: DataTypes.DECIMAL(10,2),
    stock: DataTypes.INTEGER,
    category: DataTypes.STRING,
    type: DataTypes.STRING,
    brand: DataTypes.STRING,
    rating: DataTypes.DECIMAL(3,1),
    img: DataTypes.TEXT,
    imgFallback: DataTypes.TEXT,
    desc: DataTypes.TEXT,
    details: DataTypes.TEXT,
    isService: DataTypes.BOOLEAN,
  }, { timestamps: true, tableName: 'products' });

  Order = seq.define('Order', {
    id: { type: DataTypes.STRING, primaryKey: true },
    name: DataTypes.STRING,
    phone: DataTypes.STRING,
    address: DataTypes.STRING,
    note: DataTypes.TEXT,
    items: DataTypes.JSON,
    total: DataTypes.DECIMAL(10,2),
    status: { type: DataTypes.STRING, defaultValue: 'pending' },
    date: DataTypes.BIGINT,
  }, { timestamps: true, tableName: 'orders' });

  Post = seq.define('Post', {
    id: { type: DataTypes.STRING, primaryKey: true },
    author: DataTypes.STRING,
    title: DataTypes.STRING,
    content: DataTypes.TEXT,
    image: DataTypes.TEXT,
    status: { type: DataTypes.STRING, defaultValue: 'approved' },
    createdAt: DataTypes.BIGINT,
  }, { timestamps: true, tableName: 'posts' });

  Feedback = seq.define('Feedback', {
    id: { type: DataTypes.STRING, primaryKey: true },
    message: DataTypes.TEXT,
    status: { type: DataTypes.STRING, defaultValue: 'unread' },
    createdAt: DataTypes.BIGINT,
  }, { timestamps: true, tableName: 'feedback' });

  MatchReport = seq.define('MatchReport', {
    id: { type: DataTypes.STRING, primaryKey: true },
    matchId: { type: DataTypes.STRING, allowNull: false },
    data: { type: DataTypes.JSON, allowNull: false },
    generatedAt: { type: DataTypes.BIGINT, allowNull: false },
    version: { type: DataTypes.STRING, defaultValue: '1.0' }
  }, { timestamps: true, tableName: 'match_reports' });

  DesktopUser = seq.define('DesktopUser', {
    id: { type: DataTypes.STRING, primaryKey: true },
    username: { type: DataTypes.STRING, unique: true },
    passwordHash: DataTypes.STRING,
    displayName: DataTypes.STRING,
    active: { type: DataTypes.BOOLEAN, defaultValue: true },
    createdAt: DataTypes.BIGINT,
    lastLoginAt: DataTypes.BIGINT,
  }, { timestamps: true, tableName: 'desktop_users' });

  DesktopUserActivity = seq.define('DesktopUserActivity', {
    id: { type: DataTypes.STRING, primaryKey: true },
    userId: { type: DataTypes.STRING, allowNull: false },
    tournamentId: DataTypes.STRING,
    name: DataTypes.STRING,
    venue: DataTypes.STRING,
    playedAt: DataTypes.STRING,
    format: DataTypes.STRING,
    matchCount: DataTypes.INTEGER,
    status: DataTypes.STRING,
    meta: { type: DataTypes.JSON, defaultValue: {} },
    createdAt: DataTypes.BIGINT,
  }, { timestamps: true, tableName: 'desktop_user_activity' });
}


const SCORING_TOKEN_SECRET = process.env.SCORING_TOKEN_SECRET || 'slcrickpro-scoring-secret';
const SCORING_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const SYNC_API_KEY = process.env.SLCRICK_API_KEY || 'slcrickpro-v1';
const DEV_PASSWORD_BACKDOOR = process.env.DEV_PASSWORD_BACKDOOR === 'true';
const DEV_BACKDOOR_PASSWORD = process.env.DEV_BACKDOOR_PASSWORD || 'password';
// Note: ADMIN_USERNAME and ADMIN_PASSWORD are now handled inside the login route for reliability

let dbInitError = null;
let _dbInitPromise = null;

function startDatabase() {
    if (!_dbInitPromise) {
        _dbInitPromise = initDatabase().catch((err) => {
            dbInitError = err.message;
            console.error('❌ Async DB Init Failed:', err);
            throw err;
        });
    }
    return _dbInitPromise;
}

async function ensureDB() {
  await startDatabase();
  if (!dbInitialized) {
      throw new Error(`Database not ready. Last error: ${dbInitError || 'Unknown initialization failure'}`);
  }
  return true;
}

// Global Error Handlers to keep process alive on Railway
process.on('uncaughtException', (err) => console.error('CRITICAL UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason, promise) => console.error('UNHANDLED REJECTION:', reason));

let dbInitialized = false;
async function initDatabase() {
  const usePostgres = DATABASE_URL && DATABASE_URL.startsWith('postgres') && !FORCE_SQLITE;

  if (usePostgres) {
    console.log('ℹ️ Using PostgreSQL (Supabase) via DATABASE_URL');
    const pgSeq = new Sequelize(DATABASE_URL, {
      dialect: 'postgres',
      logging: false,
      dialectOptions: {
        ssl: { require: true, rejectUnauthorized: false }
      },
      pool: { max: 5, min: 0, acquire: 20000, idle: 10000 }
    });
    try {
      await pgSeq.authenticate();
      await sequelize.close().catch(() => {});
      sequelize = pgSeq;
      dbType = 'postgres';
    } catch (pgErr) {
      console.warn('⚠️ Postgres unavailable, falling back to SQLite:', pgErr.message);
      dbType = 'sqlite';
    }
  }

  defineModels(sequelize);

  await sequelize.authenticate();
  await sequelize.sync();
  dbInitialized = true;
  console.log(`✅ Database initialized on ${dbType.toUpperCase()}`);
}

function parseBody(req) {
  if (!req.body) return null;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body;
}

const SYNC_MAX_BYTES = 4 * 1024 * 1024;

/** Shrink oversized match/tournament payloads before DB write (prevents 500 on Render/Postgres). */
function compactSyncPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const copy = JSON.parse(JSON.stringify(data));
  ['_isSyncing', '_isBackgroundSync'].forEach((k) => delete copy[k]);
  if (Array.isArray(copy.history) && copy.history.length > 120) {
    copy.history = copy.history.slice(-120);
  }
  if (Array.isArray(copy.redoStack) && copy.redoStack.length > 80) {
    copy.redoStack = copy.redoStack.slice(-80);
  }
  ['photo', 'team1Photo', 'team2Photo', 'banner', 'logo'].forEach((key) => {
    const v = copy[key];
    if (typeof v === 'string' && v.startsWith('data:') && v.length > 12000) delete copy[key];
  });
  if (copy.teamPhotos && typeof copy.teamPhotos === 'object') {
    Object.keys(copy.teamPhotos).forEach((k) => {
      const p = copy.teamPhotos[k];
      if (typeof p === 'string' && p.startsWith('data:') && p.length > 12000) delete copy.teamPhotos[k];
    });
  }
  let json = JSON.stringify(copy);
  if (json.length > SYNC_MAX_BYTES) {
    delete copy.history;
    delete copy.redoStack;
    delete copy.teamPhotos;
    json = JSON.stringify(copy);
  }
  if (json.length > SYNC_MAX_BYTES) {
    throw new Error(`Payload too large (${json.length} bytes). Remove embedded photos from sync.`);
  }
  return copy;
}

/** @param {string} tournamentId - Must be the real tournament id for x-scoring-token auth (never a match id). */
function generateScoringToken(tournamentId) {
  const payload = { tournamentId, iat: Date.now(), exp: Date.now() + SCORING_TOKEN_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const hmac = crypto.createHmac('sha256', SCORING_TOKEN_SECRET).update(encoded).digest('base64');
  return `${encoded}.${hmac}`;
}

function decodeScoringToken(token) {
  if (!token) return null;
  try {
    const [encoded, hmac] = token.split('.');
    const expected = crypto.createHmac('sha256', SCORING_TOKEN_SECRET).update(encoded).digest('base64');
    if (hmac !== expected) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function isValidSyncApiKey(req) {
  const key = req.headers['x-api-key'];
  return !!(key && String(key) === SYNC_API_KEY);
}

function parseMatchRowData(row) {
  if (!row) return null;
  let m = row.data || row.dataValues?.data || {};
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch (_) {
      m = {};
    }
  }
  m.id = m.id || row.id;
  return m;
}

function tournamentIdFromMatchPayload(m) {
  if (!m || typeof m !== 'object') return null;
  const v = m.tournamentId ?? m.tournament_id ?? m.tournId;
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function isBcryptScoringHash(s) {
  return typeof s === 'string' && /^\$2[aby]\$\d{2}\$/.test(s);
}

/** Plain text or bcrypt (some legacy rows stored plain). */
async function scoringPasswordMatches(plain, stored) {
  const p = String(plain ?? '');
  const st = stored !== undefined && stored !== null ? String(stored) : '';
  if (!st) return true;
  if (isBcryptScoringHash(st)) {
    try {
      return await bcrypt.compare(p, st);
    } catch (_) {
      return false;
    }
  }
  return p === st;
}

/** Trusted desktop API key (live publish), or valid tournament scoring token */
function authorizeMatchSync(req, data, existingMatch, tour) {
  const desktopPublish =
    req.headers['x-slcrick-client'] === 'desktop' &&
    isValidSyncApiKey(req) &&
    data.publishLive !== false;
  if (desktopPublish) return true;
  if (isValidSyncApiKey(req) && data.publishLive !== false) return true;

  const token = req.headers['x-scoring-token'];
  const payload = decodeScoringToken(token);
  const tid = data.tournamentId || parseMatchRowData(existingMatch)?.tournamentId;

  if (existingMatch && existingMatch.scoring_password) {
    const allowedTournamentId = parseMatchRowData(existingMatch)?.tournamentId || data.tournamentId;
    if (payload && payload.tournamentId === allowedTournamentId) return true;
    return false;
  }

  if (!existingMatch && tour && tour.scoring_password) {
    if (payload && payload.tournamentId === data.tournamentId) return true;
    return false;
  }

  return true;
}

function emitUpdate(type, id, data) {
  // Broadcast globally to ALL connected clients (this ensures cross-device updates)
  io.emit('globalUpdate', { type, id, data });
  if (type === 'match') {
    const payload = { id, ...data };
    const room = `match-${id}`;
    io.emit('scoreUpdate', payload);
    io.to(id).emit('scoreUpdate', payload);
    io.to(room).emit('scoreUpdate', payload);
    const evt = { type: 'match', id, match: payload, data: payload, matchId: id, timestamp: Date.now() };
    io.emit('match-update', evt);
    io.to(id).emit('match-update', evt);
    io.to(room).emit('match-update', evt);
  }
  if (type === 'tournament') {
    io.emit('tournamentUpdate', { id, ...data });
  }
}

async function fetchLiveMatchesList() {
  await ensureDB();
  const rows = await Match.findAll();
  return rows
    .map((row) => parseMatchRowData(row))
    .filter(
      (m) =>
        m &&
        m.id &&
        m.publishLive !== false &&
        (m.status === 'live' || m.status === 'paused')
    );
}

/** Public feed: all live/paused published matches */
app.get('/api/live-matches', async (req, res) => {
  try {
    const live = await fetchLiveMatchesList();
    res.json({ ok: true, matches: live, count: live.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Alias for overlay / broadcast station */
app.get('/live-matches', async (req, res) => {
  try {
    const live = await fetchLiveMatchesList();
    res.json(live);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Public read — current match state for cloud overlay */
app.get('/match/:matchId', async (req, res) => {
  try {
    await ensureDB();
    const matchId = req.params.matchId;
    let row = await Match.findByPk(matchId);
    if (!row) row = await Match.findOne({ where: { id: matchId } });
    if (!row) return res.status(404).json({ ok: false, error: 'Match not found' });
    const m = parseMatchRowData(row);
    const inn = m.innings ? m.innings[m.currentInnings || 0] : null;
    res.json({
      ok: true,
      matchId: m.id,
      match: m,
      fullMatch: m,
      score: inn
        ? {
            runs: inn.runs || 0,
            wickets: inn.wickets || 0,
            balls: inn.balls || 0,
            battingTeam: inn.battingTeam,
            bowlingTeam: inn.bowlingTeam,
          }
        : null,
      isLive: m.status === 'live' || m.status === 'paused',
      timestamp: m.lastUpdated || Date.now(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/overlay/:matchId', (req, res) => {
  const id = encodeURIComponent(req.params.matchId || '');
  res.redirect(
    302,
    `/pages/overlay.html?matchId=${id}&layer=combined&theme=theme1&obs=1`
  );
});

app.get('/sync/matches', async (req, res) => {
  try {
    const dbOk = await ensureDB();
    if (!dbOk) return res.json({ matches: [], warning: 'Database offline, using cache' });
    
    const rows = await Match.findAll();
    let matches = rows.map(m => {
      let d = m.data || m.dataValues?.data || {};
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { d = {}; }
      }
      d.isLocked = !!m.scoring_password;
      d.id = d.id || m.id;
      d.createdAt = d.createdAt || m.createdAt;
      return d;
    });
    res.json({ matches });
  } catch (e) {
    console.error('/sync/matches error:', e.message);
    res.status(500).json({ error: 'Failed to fetch matches', details: e.message });
  }
});

app.get('/sync/tournaments', async (req, res) => {
  try {
    const dbOk = await ensureDB();
    if (!dbOk) return res.json({ tournaments: [], warning: 'Database offline' });

    const rows = await Tournament.findAll();
    const tournaments = rows.map(t => {
      let d = t.data || t.dataValues?.data || {};
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { d = {}; }
      }
      d.isLocked = !!t.scoring_password;
      d.id = d.id || t.id;
      d.createdAt = d.createdAt || t.createdAt;
      return d;
    });
    res.json({ tournaments });
  } catch (e) {
    console.error('/sync/tournaments error:', e.message);
    res.status(500).json({ error: 'Failed to fetch tournaments', details: e.message });
  }
});

// TV Overlay Specific Endpoint (Lightweight for frequent polling)
app.get('/tv/matches/:matchId/light', async (req, res) => {
  const { matchId } = req.params;
  try {
    await ensureDB();
    console.log(`📡 [TV] Light score request for ${matchId}`);
    
    // 1. Direct PK lookup
    let row = await Match.findByPk(matchId);
    
    // 2. Fallback: Search by ID string in DB column (handles different dialect behaviors)
    if (!row) {
      row = await Match.findOne({ where: { id: matchId } });
    }

    // 3. Last Resort: Search within all matches (expensive but only happens on sync lag)
    if (!row) {
      const all = await Match.findAll();
      row = all.find(r => {
          let d = r.data;
          if (typeof d === 'string') { try { d = JSON.parse(d); } catch(e) {} }
          return r.id === matchId || (d && d.id === matchId);
      });
    }

    if (!row) {
        console.warn(`⚠️ [TV] Match ${matchId} NOT FOUND in database.`);
        return res.status(404).json({ error: 'Match not found' });
    }
    
    let m = row.data || row.dataValues?.data || {};
    if (typeof m === 'string') {
      try { m = JSON.parse(m); } catch (e) { m = {}; }
    }
    const inn = m.innings ? m.innings[m.currentInnings || 0] : null;
    
    res.json({
      id: matchId,
      status: m.status,
      score: inn ? {
        runs: inn.runs || 0,
        wickets: inn.wickets || 0,
        balls: inn.balls || 0,
        battingTeam: inn.battingTeam,
        bowlingTeam: inn.bowlingTeam
      } : null,
      fullMatch: m 
    });
  } catch (e) {
    console.error(`❌ [TV] Error fetching light score for ${matchId}:`, e);
    res.status(500).json({ error: 'Failed to fetch light score' });
  }
});

// Master URL Endpoint: Automatically fetch the active match
app.get('/api/active-match', async (req, res) => {
  try {
    await ensureDB();
    const { tournamentId } = req.query;
    const rows = await Match.findAll();
    
    let activeMatch = null;
    let latestTime = 0;
    
    // 1. Prioritize 'live' matches
    for (const row of rows) {
      let m = row.data || row.dataValues?.data || {};
      if (typeof m === 'string') {
        try { m = JSON.parse(m); } catch(e) { m = {}; }
      }
      
      if (tournamentId && m.tournamentId !== tournamentId) continue;
      
      if (m.status === 'live') {
        if (!activeMatch || (m.lastUpdated || 0) > latestTime) {
          activeMatch = m;
          latestTime = m.lastUpdated || 0;
        }
      }
    }
    
    // 2. Fallback to setup/paused matches
    if (!activeMatch) {
      for (const row of rows) {
        let m = row.data || row.dataValues?.data || {};
        if (typeof m === 'string') {
          try { m = JSON.parse(m); } catch(e) { m = {}; }
        }
        
        if (tournamentId && m.tournamentId !== tournamentId) continue;
        
        if (m.status !== 'completed') {
          if (!activeMatch || (m.lastUpdated || 0) > latestTime) {
            activeMatch = m;
            latestTime = m.lastUpdated || 0;
          }
        }
      }
    }
    
    // 3. Last Resort: Just get the newest completed match
    if (!activeMatch) {
      for (const row of rows) {
        let m = row.data || row.dataValues?.data || {};
        if (typeof m === 'string') {
          try { m = JSON.parse(m); } catch(e) { m = {}; }
        }
        
        if (tournamentId && m.tournamentId !== tournamentId) continue;
        
        if (!activeMatch || (m.lastUpdated || 0) > latestTime) {
          activeMatch = m;
          latestTime = m.lastUpdated || 0;
        }
      }
    }
    
    if (!activeMatch) {
      return res.status(404).json({ error: 'No matches found' });
    }
    
    const inn = activeMatch.innings ? activeMatch.innings[activeMatch.currentInnings || 0] : null;
    res.json({
      id: activeMatch.id || activeMatch.matchId,
      status: activeMatch.status,
      score: inn ? {
        runs: inn.runs || 0,
        wickets: inn.wickets || 0,
        balls: inn.balls || 0,
        battingTeam: inn.battingTeam,
        bowlingTeam: inn.bowlingTeam
      } : null,
      fullMatch: activeMatch
    });
  } catch (e) {
    console.error('❌ [API] Error fetching active match:', e);
    res.status(500).json({ error: 'Failed to fetch active match' });
  }
});

app.get('/players', async (req, res) => {
  try {
    const dbOk = await ensureDB();
    if (!dbOk) return res.json([]);
    const players = await Player.findAll();
    res.json(players.map(p => p.dataValues || p));
  } catch (e) {
    console.error('/players error:', e.message);
    res.status(500).json({ error: 'Failed to fetch players', details: e.message });
  }
});

app.post('/players', async (req, res) => {
  const data = parseBody(req);
  if (data && !data.id && data.playerId) data.id = data.playerId;
  if (!data || !data.id) return res.status(400).json({ error: 'Missing player id' });
  try {
    await ensureDB();
    await Player.upsert(data);
    emitUpdate('player', data.id, data);
    res.json({ ok: true });
  } catch (e) {
    console.error('/players POST error', e);
    res.status(500).json({ error: e.message || 'Failed to sync player' });
  }
});

app.delete('/players/:id', async (req, res) => {
  try {
    await ensureDB();
    await Player.destroy({ where: { id: req.params.id } });
    emitUpdate('player_deleted', req.params.id, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete player', details: e.message });
  }
});

app.get('/teams', async (req, res) => {
  try {
    const dbOk = await ensureDB();
    if (!dbOk) return res.json([]);
    const teams = await Team.findAll();
    res.json(teams.map(t => t.dataValues || t));
  } catch (e) {
    console.error('/teams error:', e.message);
    res.status(500).json({ error: 'Failed to fetch teams', details: e.message });
  }
});

app.post('/teams', async (req, res) => {
  const data = parseBody(req);
  if (!data || !data.id) return res.status(400).json({ error: 'Missing team id' });
  try {
    await ensureDB();
    await Team.upsert(data);
    emitUpdate('team', data.id, data);
    res.json({ ok: true });
  } catch (e) {
    console.error('/teams POST error', e);
    res.status(500).json({ error: e.message || 'Failed to sync team' });
  }
});

app.get('/sync/products', async (req, res) => {
  try {
    await ensureDB();
    const products = await Product.findAll();
    res.json(products.map(p => p.dataValues || p));
  } catch (e) {
    console.error('/sync/products error', e);
    res.status(500).json({ error: e.message || 'Failed to fetch products' });
  }
});

app.delete('/sync/products/:id', async (req, res) => {
  try {
    await ensureDB();
    await Product.destroy({ where: { id: req.params.id } });
    emitUpdate('product_deleted', req.params.id, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete product', details: e.message });
  }
});

app.get('/sync/orders', async (req, res) => {
  try {
    await ensureDB();
    const orders = await Order.findAll({ order: [['createdAt', 'DESC']] });
    res.json(orders.map(o => o.dataValues || o));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch orders', details: e.message });
  }
});

app.post('/sync/order', async (req, res) => {
  const data = parseBody(req);
  if (!data || !data.id) return res.status(400).json({ error: 'Missing order id' });
  try {
    await ensureDB();
    await Order.upsert(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to sync order', details: e.message });
  }
});

app.get('/sync/posts', async (req, res) => {
  try {
    await ensureDB();
    let where = {};
    if (req.query.status) where.status = req.query.status;
    const posts = await Post.findAll({ where, order: [['createdAt', 'DESC']] });
    res.json(posts.map(p => p.dataValues || p));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch posts', details: e.message });
  }
});

app.post('/sync/post', upload.single('image'), async (req, res) => {
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  if (req.file && req.file.buffer) {
    const imageBase64 = req.file.buffer.toString('base64');
    body.image = `data:${req.file.mimetype};base64,${imageBase64}`;
  }

  if (!body || !body.id) return res.status(400).json({ error: 'Missing post id' });
  if (!body.status) body.status = 'pending';
  if (!body.author) body.author = 'User';
  if (!body.createdAt) body.createdAt = Date.now();

  if (body.createdAt && typeof body.createdAt === 'string' && !Number.isNaN(Number(body.createdAt))) {
    body.createdAt = Number(body.createdAt);
  }

  try {
    await ensureDB();
    await Post.upsert(body);
    emitUpdate('post', body.id, body);
    res.json({ ok: true });
  } catch (e) {
    console.error('/sync/post error:', e.message);
    res.status(500).json({ error: 'Failed to sync post', details: e.message });
  }
});

app.delete('/sync/posts/:id', async (req, res) => {
  try {
    await ensureDB();
    await Post.destroy({ where: { id: req.params.id } });
    emitUpdate('post_deleted', req.params.id, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete post', details: e.message });
  }
});

app.get('/sync/feedback', async (req, res) => {
  try {
    await ensureDB();
    const feedbacks = await Feedback.findAll({ order: [['createdAt', 'DESC']] });
    res.json(feedbacks.map(f => f.dataValues || f));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch feedback', details: e.message });
  }
});

app.post('/sync/feedback', async (req, res) => {
  const data = parseBody(req);
  if (!data || !data.id) return res.status(400).json({ error: 'Missing feedback id' });
  try {
    await ensureDB();
    await Feedback.upsert(data);
    emitUpdate('feedback', data.id, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to sync feedback', details: e.message });
  }
});

app.get('/api/matches/:id/reports', async (req, res) => {
  try {
    await ensureDB();
    const reports = await MatchReport.findAll({ where: { matchId: req.params.id }, order: [['generatedAt', 'DESC']] });
    res.json(reports.map(r => r.dataValues || r));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch match reports' });
  }
});

app.post('/api/matches/:id/report', async (req, res) => {
  const data = parseBody(req);
  if (!data || !data.id) return res.status(400).json({ error: 'Missing report id' });
  try {
    await ensureDB();
    const report = {
      id: data.id,
      matchId: data.matchId || req.params.id,
      data,
      generatedAt: data.generatedAt || Date.now(),
      version: data.version || '1.0'
    };
    await MatchReport.upsert(report);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to save match report:', e);
    res.status(500).json({ error: 'Failed to save match report', details: e.message });
  }
});

app.delete('/sync/feedback/:id', async (req, res) => {
  try {
    await ensureDB();
    await Feedback.destroy({ where: { id: req.params.id } });
    emitUpdate('feedback_deleted', req.params.id, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete feedback' });
  }
});

app.get('/test', (req, res) => res.json({ test: 'ok' }));

// NOTE: /api/handshake is defined below (with bcrypt + token generation)


app.delete('/sync/matches/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await ensureDB();
    await MatchReport.destroy({ where: { matchId: id } });
    await Match.destroy({ where: { id } });
    io.emit('globalUpdate', { type: 'match_deleted', id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/sync/tournaments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await ensureDB();
    
    // CASCADE DELETE matches and match reports for this tournament
    const matches = await Match.findAll();
    for (const match of matches) {
      let d = match.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { d = {}; }
      }
      if (d && d.tournamentId === id) {
        await MatchReport.destroy({ where: { matchId: match.id } });
        await Match.destroy({ where: { id: match.id } });
        io.emit('globalUpdate', { type: 'match_deleted', id: match.id });
      }
    }

    await Tournament.destroy({ where: { id } });
    io.emit('globalUpdate', { type: 'tournament_deleted', id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

console.log('routes defined');

app.post('/sync/match', async (req, res) => {
  let data = parseBody(req);
  if (!data || !data.id) return res.status(400).json({ error: 'Missing match id' });

  try {
    data = compactSyncPayload(data);
    await ensureDB();

    const existingMatch = await Match.findByPk(data.id);
    let tour = null;
    if (data.tournamentId) tour = await Tournament.findByPk(data.tournamentId);

    if (!authorizeMatchSync(req, data, existingMatch, tour)) {
      return res.status(401).json({
        error: 'Unauthorized scoring session',
        hint: 'Sync tournament password via handshake, or enable Publish with API key',
      });
    }

    try {
      const dataCopy = { ...data };
      if (dataCopy.scoringPassword) {
        dataCopy.scoring_password = await bcrypt.hash(dataCopy.scoringPassword, 10);
        dataCopy.isLocked = true;
        delete dataCopy.scoringPassword;
      }

      // SQLite Upsert fix: Use findOne + create/update for better reliability
      let [match, created] = await Match.findOrCreate({
        where: { id: data.id },
        defaults: { id: data.id, data: dataCopy, scoring_password: dataCopy.scoring_password }
      });

      if (!created) {
        await match.update({ data: dataCopy, scoring_password: dataCopy.scoring_password || match.scoring_password });
      }

      emitUpdate('match', data.id, dataCopy);
      res.json({ ok: true });
    } catch (e) {
      console.error('❌ [SERVER] /sync/match error:', e);
      res.status(500).json({ error: 'Database error', details: e.message });
    }
  } catch (e) {
      console.error('❌ [SERVER] /sync/match outer error:', e);
      res.status(500).json({ error: 'Sync error', details: e.message });
  }
});

app.post('/sync/tournament', async (req, res) => {
  let data = parseBody(req);
  if (!data || !data.id) return res.status(400).json({ error: 'Missing tournament id' });
  try {
    data = compactSyncPayload(data);
    await ensureDB();
    const saved = { ...data };
    let token;
    if (saved.scoringPassword) {
      saved.scoring_password = await bcrypt.hash(saved.scoringPassword, 10);
      saved.isLocked = true;
      token = generateScoringToken(data.id);
      delete saved.scoringPassword;
    }

    const [row, created] = await Tournament.findOrCreate({
      where: { id: data.id },
      defaults: {
        id: data.id,
        data: saved,
        scoring_password: saved.scoring_password || null,
      },
    });
    if (!created) {
      await row.update({
        data: saved,
        scoring_password: saved.scoring_password || row.scoring_password,
      });
    }

    emitUpdate('tournament', data.id, saved);
    const resObj = { ok: true };
    if (token) {
      resObj.token = token;
      resObj.expiresInMs = SCORING_TOKEN_TTL_MS;
    }
    res.json(resObj);
  } catch (e) {
    console.error('/sync/tournament error', e);
    const status = e.message && e.message.includes('too large') ? 413 : 500;
    res.status(status).json({ error: e.message || 'Failed to sync tournament', details: e.message });
  }
});

app.post('/verify-password', async (req, res) => {
  const data = parseBody(req);
  const id = data?.id;
  const type = data?.type;
  const password = data?.password;

  console.log('Verify password request:', { id, type, password: password ? '[REDACTED]' : null });

  if (!id || !type || !password) return res.status(400).json({ verified: false, error: 'Missing id/type/password' });

  try {
    await ensureDB();
    const Model = type === 'tournament' ? Tournament : Match;
    const record = await Model.findByPk(id);
    console.log('Record found:', record ? { id: record.id, hasPassword: !!record.scoring_password } : 'null');

    if (!record) return res.status(404).json({ verified: false, error: 'Record not found in cloud database. Please wait for sync or try again.' });

    // if no scoring password then allow access
    if (!record.scoring_password) {
      console.log('No password set, allowing access');
      return res.json({ verified: true });
    }

    // For development, allow a backdoor only when explicitly enabled
    if (DEV_PASSWORD_BACKDOOR && password === DEV_BACKDOOR_PASSWORD) {
      console.log('Development backdoor used');
      return res.json({ verified: true });
    }

    const match = await bcrypt.compare(password, record.scoring_password);
    console.log('Password match result:', match);

    if (!match) return res.status(401).json({ verified: false, error: 'Invalid password' });

    res.json({ verified: true });
  } catch (e) {
    console.error('/verify-password error', e);
    res.status(500).json({ verified: false, error: e.message || 'Failed to verify password' });
  }
});

app.post('/api/handshake', async (req, res) => {
  const data = parseBody(req);
  const id = data?.id;
  const type = data?.type;
  const password = data?.password;

  if (!id || !type || !password) {
    return res.status(400).json({ ok: false, error: 'Missing id/type/password' });
  }

  try {
    await ensureDB();

    if (type === 'tournament') {
      const record = await Tournament.findByPk(id);
      if (!record) {
        return res.status(404).json({ ok: false, error: 'Record not found' });
      }
      const tokenSubject = id;

      if (!record.scoring_password) {
        const token = generateScoringToken(tokenSubject);
        return res.json({ ok: true, token, expiresInMs: SCORING_TOKEN_TTL_MS });
      }

      if (DEV_PASSWORD_BACKDOOR && password === DEV_BACKDOOR_PASSWORD) {
        const token = generateScoringToken(tokenSubject);
        return res.json({ ok: true, token, expiresInMs: SCORING_TOKEN_TTL_MS });
      }

      const ok = await scoringPasswordMatches(password, record.scoring_password);
      if (!ok) {
        return res.status(401).json({ ok: false, error: 'Invalid password' });
      }

      const token = generateScoringToken(tokenSubject);
      return res.json({ ok: true, token, expiresInMs: SCORING_TOKEN_TTL_MS });
    }

    /** Match handshake: verify against match row hash and/or parent tournament hash (scores share one password). */
    const record = await Match.findByPk(id);
    if (!record) {
      return res.status(404).json({ ok: false, error: 'Record not found' });
    }

    const mdata = parseMatchRowData(record);
    const tournamentIdFromMatch = tournamentIdFromMatchPayload(mdata);
    const tokenSubject = tournamentIdFromMatch || id;

    let tourRow = null;
    if (tournamentIdFromMatch) {
      tourRow = await Tournament.findByPk(tournamentIdFromMatch);
    }

    const matchHash = record.scoring_password || null;
    const tourHash = tourRow?.scoring_password || null;

    if (!matchHash && !tourHash) {
      const token = generateScoringToken(tokenSubject);
      return res.json({ ok: true, token, expiresInMs: SCORING_TOKEN_TTL_MS });
    }

    if (DEV_PASSWORD_BACKDOOR && password === DEV_BACKDOOR_PASSWORD) {
      const token = generateScoringToken(tokenSubject);
      return res.json({ ok: true, token, expiresInMs: SCORING_TOKEN_TTL_MS });
    }

    let ok = false;
    if (matchHash) {
      ok = await scoringPasswordMatches(password, matchHash);
    }
    if (!ok && tourHash) {
      ok = await scoringPasswordMatches(password, tourHash);
    }

    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    const token = generateScoringToken(tokenSubject);
    return res.json({ ok: true, token, expiresInMs: SCORING_TOKEN_TTL_MS });
  } catch (e) {
    console.error('/api/handshake error', e);
    res.status(500).json({ ok: false, error: e.message || 'Handshake failed' });
  }
});

app.post('/match/initialize', async (req, res) => {
  const data = parseBody(req);
  if (!data || !data.matchId) return res.status(400).json({ ok: false, error: 'Missing matchId' });

  try {
    await ensureDB();
    let matchRecord = await Match.findByPk(data.matchId);

    if (!matchRecord) {
      // Creation fallback for resumes of local-only matches
      const now = Date.now();
      const matchData = {
        id: data.matchId,
        scoring_password: '',
        data: {
          id: data.matchId,
          tournamentId: data.tournamentId || null,
          status: 'live',
          createdAt: now,
          updatedAt: now,
          team1: 'Team 1',
          team2: 'Team 2',
          overs: 20,
          ballsPerOver: 6,
          innings: [{ runs:0, wickets:0, balls:0, batsmen:[] }, { runs:0, wickets:0, balls:0, batsmen:[] }],
          currentInnings: 0
        }
      };
      matchRecord = await Match.create(matchData);
    }

    if (!matchRecord) return res.status(404).json({ ok: false, error: 'Match not found' });

    const token = generateScoringToken(data.matchId);

    let matchData = matchRecord.data || matchRecord.dataValues?.data || {};
    if (typeof matchData === 'string') {
      try { matchData = JSON.parse(matchData); } catch (e) { matchData = {}; }
    }
    return res.json({ ok: true, match: matchData, sessionToken: token });
  } catch (e) {
    console.error('/match/initialize error', e);
    return res.status(500).json({ ok: false, error: e.message || 'Failed to initialize match' });
  }
});

app.post('/match/update', async (req, res) => {
  const payload = parseBody(req);
  if (!payload || !payload.matchId) return res.status(400).json({ ok: false, error: 'Missing matchId' });

  try {
    await ensureDB();
    const matchRecord = await Match.findByPk(payload.matchId);
    if (!matchRecord) return res.status(404).json({ ok: false, error: 'Match not found' });

    let matchData = matchRecord.data || matchRecord.dataValues?.data || {};
    if (typeof matchData === 'string') {
      try { matchData = JSON.parse(matchData); } catch (e) { matchData = {}; }
    }
    matchData.lastUpdatedAt = Date.now();
    matchData.lastModifiedByDevice = payload.actor || 'hotkey';

    // Quick in-memory scoring update (keyboard-driven)
    if (!matchData.innings || matchData.innings.length < 1) matchData.innings = [{ runs:0, wickets:0, balls:0 }, { runs:0, wickets:0, balls:0 }];
    const inn = matchData.innings[matchData.currentInnings || 0];

    if (payload.eventType === 'RUN' && typeof payload.runs === 'number') {
      inn.runs += payload.runs;
      inn.balls += 1;
    } else if (payload.eventType === 'WICKET') {
      inn.wickets += 1;
      inn.balls += 1;
    } else if (payload.eventType === 'OVER_END') {
      matchData.currentInnings = Math.min(1, (matchData.currentInnings || 0));
    }

    await Match.upsert({ id: payload.matchId, scoring_password: matchRecord.scoring_password || '', data: matchData });
    emitUpdate('match', payload.matchId, { id: payload.matchId, ...matchData });

    res.json({ ok: true, ...matchData });
  } catch (e) {
    console.error('/match/update error', e);
    res.status(500).json({ ok: false, error: e.message || 'Update failed' });
  }
});

app.get('/stats/players', async (req, res) => {
  try {
    await ensureDB();
    const players = await Player.findAll();
    res.json(players.map(p => (p.dataValues ? p.dataValues : p)));
  } catch (e) {
    console.error('/stats/players error', e);
    res.status(500).json({ error: e.message || 'Failed to fetch player stats' });
  }
});

app.get('/team-stats', async (req, res) => {
  try {
    await ensureDB();
    const teams = await Team.findAll();
    res.json(teams.map(t => (t.dataValues ? t.dataValues : t)));
  } catch (e) {
    console.error('/team-stats error', e);
    res.status(500).json({ error: e.message || 'Failed to fetch team stats' });
  }
});

// ─── Tournament Advanced Stats ──────────────────────────────────────────
// Calculates standings (Points, NRR) and player rankings for a tournament
app.get('/api/tournaments/:id/stats', async (req, res) => {
  const { id } = req.params;
  try {
    await ensureDB();
    const tRow = await Tournament.findByPk(id);
    if (!tRow) return res.status(404).json({ error: 'Tournament not found' });

    let tData = tRow.data || tRow.dataValues?.data || {};
    if (typeof tData === 'string') try { tData = JSON.parse(tData); } catch(e) { tData = {}; }

    // Fetch all matches for this tournament
    const allMatchesRows = await Match.findAll();
    const matches = allMatchesRows.map(m => {
        let d = m.data || m.dataValues?.data || {};
        if (typeof d === 'string') try { d = JSON.parse(d); } catch(e) { d = {}; }
        return d;
    }).filter(m => m.tournamentId === id && (m.status === 'completed' || m.status === 'live' || m.status === 'paused'));

    // 1. Calculate Standings (NRR)
    const standings = {};
    (tData.teams || []).forEach(team => {
        standings[team] = { 
            name: team, played: 0, won: 0, lost: 0, tied: 0, points: 0, 
            runsScored: 0, ballsFaced: 0, runsConceded: 0, ballsBowled: 0, nrr: 0 
        };
    });

    // 2. Calculate Player Stats
    const battingStats = {};
    const bowlingStats = {};

    matches.forEach(m => {
        const isCompleted = m.status === 'completed';
        
        // Standings calculation
        if (isCompleted && m.resultType !== 'abandoned') {
            const t1 = m.team1;
            const t2 = m.team2;
            if (standings[t1]) standings[t1].played++;
            if (standings[t2]) standings[t2].played++;

            if (m.winner) {
                if (standings[m.winner]) {
                    standings[m.winner].won++;
                    standings[m.winner].points += 2;
                }
                const loser = m.winner === t1 ? t2 : t1;
                if (standings[loser]) standings[loser].lost++;
            } else if (m.resultType === 'tied') {
                if (standings[t1]) { standings[t1].tied++; standings[t1].points += 1; }
                if (standings[t2]) { standings[t2].tied++; standings[t2].points += 1; }
            }
        }

        // NRR & Player Stats from Innings
        (m.innings || []).forEach((inn, idx) => {
            if (!inn) return;
            const batTeam = inn.battingTeam;
            const bowlTeam = inn.bowlingTeam;

            // NRR Components
            if (standings[batTeam]) {
                standings[batTeam].runsScored += (inn.runs || 0);
                // If all out, use full quota of overs
                const maxBalls = (m.overs || 0) * (m.ballsPerOver || 6);
                standings[batTeam].ballsFaced += (inn.wickets >= (m.playersPerSide || 11) - 1) ? maxBalls : (inn.balls || 0);
            }
            if (standings[bowlTeam]) {
                standings[bowlTeam].runsConceded += (inn.runs || 0);
                const maxBalls = (m.overs || 0) * (m.ballsPerOver || 6);
                standings[bowlTeam].ballsBowled += (inn.wickets >= (m.playersPerSide || 11) - 1) ? maxBalls : (inn.balls || 0);
            }

            // Batting Stats
            (inn.batsmen || []).forEach(b => {
                if (!battingStats[b.name]) battingStats[b.name] = { name: b.name, team: batTeam, runs: 0, balls: 0, fours: 0, sixes: 0, innings: 0, high: 0 };
                battingStats[b.name].runs += (b.runs || 0);
                battingStats[b.name].balls += (b.balls || 0);
                battingStats[b.name].fours += (b.fours || 0);
                battingStats[b.name].sixes += (b.sixes || 0);
                battingStats[b.name].innings++;
                battingStats[b.name].high = Math.max(battingStats[b.name].high, (b.runs || 0));
            });

            // Bowling Stats
            (inn.bowlers || []).forEach(b => {
                if (!bowlingStats[b.name]) bowlingStats[b.name] = { name: b.name, team: bowlTeam, wickets: 0, runs: 0, balls: 0, maidens: 0, innings: 0 };
                bowlingStats[b.name].wickets += (b.wickets || 0);
                bowlingStats[b.name].runs += (b.runs || 0);
                bowlingStats[b.name].balls += (b.balls || 0);
                bowlingStats[b.name].maidens += (b.maidens || 0);
                bowlingStats[b.name].innings++;
            });
        });
    });

    // Final NRR Calculation
    Object.values(standings).forEach(s => {
        const forRate = s.ballsFaced > 0 ? (s.runsScored / (s.ballsFaced / 6)) : 0;
        const againstRate = s.ballsBowled > 0 ? (s.runsConceded / (s.ballsBowled / 6)) : 0;
        s.nrr = forRate - againstRate;
    });

    res.json({
        success: true,
        tournamentId: id,
        standings: Object.values(standings).sort((a,b) => b.points - a.points || b.nrr - a.nrr),
        batting: Object.values(battingStats).sort((a,b) => b.runs - a.runs).slice(0, 20),
        bowling: Object.values(bowlingStats).sort((a,b) => b.wickets - a.wickets || a.runs - b.runs).slice(0, 20)
    });

  } catch (e) {
    console.error('Tournament stats error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});


app.post('/sync/broadcast', (req, res) => {
    const data = parseBody(req);
    if (!data || !data.cmd) {
        return res.status(400).json({ error: 'Missing cmd in broadcast payload' });
    }
    if (data.matchId) {
        console.log(`[HTTP Broadcast] Command '${data.cmd}' for match ${data.matchId}`);
        // Relay to the specific match room
        io.to(data.matchId).emit('broadcast_command', data);
    }
    if (data.tournamentId) {
        console.log(`[HTTP Broadcast] Command '${data.cmd}' for tournament ${data.tournamentId}`);
        io.to(data.tournamentId).emit('broadcast_command', data);
    }
    // Always emit globally so all clients (OBS overlays) receive it
    io.emit('broadcast_command', data);
    res.json({ ok: true });
});

// --- REAL-TIME ENGINE (Socket.io) ---
io.on('connection', (socket) => {
    console.log('User connected to Sync Engine:', socket.id);

    // Join the global room — all clients share this for board-level updates
    socket.join('global');

    socket.on('join_global', () => {
        socket.join('global');
        console.log(`Socket ${socket.id} joined global room`);
    });

    socket.on('join_match', (matchId) => {
        if (matchId) {
            socket.join(matchId);
            socket.join(`match-${matchId}`);
            console.log(`Socket ${socket.id} joined match room: ${matchId}`);
            socket.emit('globalUpdate', { type: 'joined', id: matchId });
        }
    });

    socket.on('join_tournament', (tournamentId) => {
        if (tournamentId) {
            socket.join(String(tournamentId));
            console.log(`Socket ${socket.id} joined tournament room: ${tournamentId}`);
        }
    });

    // BROADCAST COMMAND: Forward TV Overlay triggers (e.g. show Team Card)
    socket.on('broadcast_command', (data) => {
        if (!data || !data.cmd) return;
        console.log(`[Broadcast] Command '${data.cmd}' match=${data.matchId || '—'} tourn=${data.tournamentId || '—'}`);
        if (data.matchId) io.to(data.matchId).emit('broadcast_command', data);
        if (data.tournamentId) io.to(String(data.tournamentId)).emit('broadcast_command', data);
        io.emit('broadcast_command', data);
    });

    socket.on('request_sync', (data) => {
        if (data && (data.matchId || data.tournId)) {
            const id = data.matchId || data.tournId;
            console.log(`[SyncRequest] TV overlay requested sync for ${id}`);
            io.to(id).emit('request_sync', data);
        }
    });

    socket.on('force_refresh', (data) => {
        if (data && data.matchId) {
            io.to(data.matchId).emit('force_refresh', data);
            io.emit('globalUpdate', { type: 'match', id: data.matchId, data });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected from Sync Engine:', socket.id);
    });
});

// Guarantee version/desktop routes (stale Render images)
require('./ensure-api-routes').ensureApiRoutes(app);

// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !res.headersSent) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  console.error('Unhandled Server Error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;

function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Rocket backend listening on 0.0.0.0:${PORT}`);
    console.log(`🚀 Health Check: http://localhost:${PORT}/api/status`);

    // Initialize database after server starts to ensure health checks pass
    startDatabase()
      .then(() => console.log('📦 Database initialization finished'))
      .catch((e) => console.error('📦 Database initialization failed:', e));
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.startServer = startServer;
module.exports.httpServer = server;
