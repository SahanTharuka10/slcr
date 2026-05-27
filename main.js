const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  session,
  clipboard,
  screen,
  globalShortcut,
  net,
} = require('electron');
const path = require('path');
const os = require('os');

// Disable GPU to avoid cache permission errors on Windows
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('enable-transparent-visuals');

const fs = require('fs');
const { startLocalServer } = require('./local-server');
const fileStore = require('./file-store');
const tournamentEngine = require('./tournament-engine');
const broadcastRelay = require('./broadcast-relay');

const ROOT = __dirname;

/** Stable data folder: %APPDATA%/SLCRICKPRO (not Electron cache/userData) */
function getAppStorageRoot() {
  const roaming =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), 'AppData', 'Roaming'));
  return path.join(roaming, 'SLCRICKPRO');
}

const DATA_FILE = () => path.join(getAppStorageRoot(), 'slcrickpro-data.json');
const FILE_DATA_ROOT = () => fileStore.getDataRoot(getAppStorageRoot());

function listLegacyDataRoots() {
  const roots = new Set();
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    path.join(roaming, 'slcrickpro', 'SLCRICKPRO-data'),
    path.join(roaming, 'slcrickpro', 'Cache', 'slcrickpro', 'SLCRICKPRO-data'),
    path.join(roaming, 'slcrickpro', 'Cache', 'SLCRICKPRO', 'SLCRICKPRO-data'),
    path.join(roaming, 'SLCRICKPRO', 'SLCRICKPRO-data'),
  ];
  try {
    candidates.push(fileStore.getDataRoot(app.getPath('userData')));
    const ud = app.getPath('userData');
    candidates.push(path.join(ud, 'SLCRICKPRO-data'));
    candidates.push(path.join(ud, 'Cache', 'slcrickpro', 'SLCRICKPRO-data'));
    candidates.push(path.join(ud, 'Cache', 'SLCRICKPRO', 'SLCRICKPRO-data'));
  } catch (_) {}
  candidates.forEach((r) => roots.add(r));
  roots.delete(FILE_DATA_ROOT());
  return [...roots].filter((r) => r && fs.existsSync(r));
}

function migrateFromLegacyRoots(targetRoot) {
  fs.mkdirSync(path.join(targetRoot, 'matches'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'tournaments'), { recursive: true });
  for (const legacyRoot of listLegacyDataRoots()) {
    try {
      const { matches, tournaments } = fileStore.loadAll(legacyRoot);
      if (!matches.length && !tournaments.length) continue;
      console.log(
        `[SLCRICKPRO] Migrating ${matches.length} matches, ${tournaments.length} tournaments from`,
        legacyRoot
      );
      matches.forEach((m) => fileStore.saveEntity(targetRoot, 'match', m));
      tournaments.forEach((t) => fileStore.saveEntity(targetRoot, 'tournament', t));
    } catch (e) {
      console.warn('[SLCRICKPRO] Legacy migrate skip', legacyRoot, e.message);
    }
  }
  const legacyJson = path.join(app.getPath('userData'), 'slcrickpro-data.json');
  if (fs.existsSync(legacyJson)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyJson, 'utf8'));
      fileStore.migrateLegacyBundle(targetRoot, legacy);
    } catch (_) {}
  }
  const newJson = DATA_FILE();
  if (fs.existsSync(newJson)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(newJson, 'utf8'));
      fileStore.migrateLegacyBundle(targetRoot, legacy);
    } catch (_) {}
  }
}
const PARTITION = 'persist:slcrickpro';
const WEB_PREFS = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  devTools: true,
  partition: PARTITION,
};

const DB_KEYS = [
  'cricpro_players',
  'cricpro_teams',
  'cricpro_matches',
  'cricpro_tournaments',
  'cricpro_products',
  'cricpro_orders',
  'cricpro_settings',
  'cricpro_posts',
  'cricpro_reports',
  'cricpro_last_pid',
  'theme',
  'cricpro_auto_anim',
  'cricpro_local_feedback',
  'cricpro_sync_settings',
  'cricpro_sync_enabled',
  'cricpro_backend_url',
];

let mainWindow = null;
let overlayWindow = null;
let scorecardPopupWindow = null;
let obsPopupWindow = null;
let persistTimer = null;
let localServer = null;
let appBaseUrl = '';
/** Cached from disk + IPC so network policy matches Publish / Cloud sync toggle immediately */
let cloudSyncAllowed = true;

function appUrl(relativePath, query = '') {
  const p = relativePath.replace(/^\//, '');
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return `${appBaseUrl}/${p}${q}`;
}

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
}

function readDataFile() {
  try {
    const p = DATA_FILE();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[SLCRICKPRO] Failed to read data file:', e);
    return null;
  }
}

function writeDataFile(snapshot) {
  try {
    const p = DATA_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (e) {
    console.error('[SLCRICKPRO] Failed to write data file:', e);
  }
}

async function collectLocalStorage(win) {
  if (!win || win.isDestroyed()) return null;
  const script = `
    (function() {
      const keys = ${JSON.stringify(DB_KEYS)};
      const out = { keys: {}, photos: {} };
      keys.forEach(k => {
        const v = localStorage.getItem(k);
        if (v != null) out.keys[k] = v;
      });
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('cricpro_photo_') || k.startsWith('cricpro_team_photo_'))) {
          out.photos[k] = localStorage.getItem(k);
        }
      }
      return out;
    })();
  `;
  return win.webContents.executeJavaScript(script, true);
}

async function restoreLocalStorage(win, saved) {
  if (!win || win.isDestroyed() || !saved) return;
  const script = `
    (function(data) {
      if (!data) return;
      if (data.keys) {
        Object.entries(data.keys).forEach(([k, v]) => {
          if (v != null) localStorage.setItem(k, v);
        });
      }
      if (data.photos) {
        Object.entries(data.photos).forEach(([k, v]) => {
          if (v != null) localStorage.setItem(k, v);
        });
      }
      localStorage.setItem('cricpro_force_update', Date.now().toString());
    })(${JSON.stringify(saved)});
  `;
  await win.webContents.executeJavaScript(script, true);
}

async function restoreAllWindows(saved) {
  for (const win of BrowserWindow.getAllWindows()) {
    await restoreLocalStorage(win, saved);
  }
  broadcast('desktop:storage-restored', saved);
}

/** Load matches/tournaments from disk JSON files into browser localStorage */
async function hydrateFromFileStore(win) {
  if (!win || win.isDestroyed()) return null;
  const root = FILE_DATA_ROOT();
  fs.mkdirSync(getAppStorageRoot(), { recursive: true });
  migrateFromLegacyRoots(root);
  const legacy = readDataFile();
  if (legacy) fileStore.migrateLegacyBundle(root, legacy);

  const { matches, tournaments } = fileStore.loadAll(root);
  const payload = fileStore.buildLocalStoragePayload(matches, tournaments);

  if (legacy?.keys) {
    payload.keys = { ...legacy.keys, ...payload.keys };
    if (legacy.photos) payload.photos = legacy.photos;
  }

  await restoreLocalStorage(win, payload);
  console.log(
    `[SLCRICKPRO] Loaded ${matches.length} matches, ${tournaments.length} tournaments from`,
    root
  );
  return { root, matches, tournaments };
}

/** Write current localStorage matches/tournaments to per-entity JSON files */
function syncSnapshotToFileStore(snapshot) {
  if (!snapshot?.keys) return;
  const root = FILE_DATA_ROOT();
  try {
    const matches = JSON.parse(snapshot.keys.cricpro_matches || '[]');
    const tournaments = JSON.parse(snapshot.keys.cricpro_tournaments || '[]');
    if (!Array.isArray(matches) || !Array.isArray(tournaments)) return;
    matches.forEach((m) => {
      if (m?.id) fileStore.saveEntity(root, 'match', m);
    });
    tournaments.forEach((t) => {
      if (t?.id) fileStore.saveEntity(root, 'tournament', t);
    });
  } catch (e) {
    console.error('[SLCRICKPRO] syncSnapshotToFileStore failed', e);
  }
}

async function persistNow() {
  const win =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return;
  const snapshot = await collectLocalStorage(win);
  if (snapshot) {
    syncSnapshotToFileStore(snapshot);
    writeDataFile(snapshot);
    cloudSyncAllowed = isCloudSyncEnabledInSnapshot(snapshot);
  }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistNow().catch(console.error), 2500);
}

async function injectDesktopScripts(win) {
  if (!win || win.isDestroyed()) return;
  await win.webContents.executeJavaScript(
    `(function() {
      function loadScript(src, attrs) {
        return new Promise(function(resolve, reject) {
          if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
          var s = document.createElement('script');
          s.src = src;
          if (attrs) Object.keys(attrs).forEach(function(k) { s.setAttribute(k, attrs[k]); });
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      var base = ${JSON.stringify(appBaseUrl)};
      loadScript(base + '/js/cloud-config.js')
        .then(function() { return loadScript(base + '/js/socket-loader.js', { 'data-slcrick-socket-io': '1' }); })
        .then(function() { return loadScript(base + '/js/sync-client.js', { 'data-slcrick-sync': '1' }); })
        .then(function() { return loadScript(base + '/js/realtime-manager.js'); })
        .then(function() { return loadScript(base + '/js/live-sync.js'); })
        .then(function() {
          if (window.SLCRICK_SYNC && window.DB && !window._slcrickInjectInstalled) {
            window._slcrickInjectInstalled = true;
            window.SLCRICK_SYNC.install();
          }
        })
        .catch(function(e) { console.warn('[SLCRICKPRO] cloud scripts', e); });
      if (!document.getElementById('slcrick-desktop-bridge')) {
        var bridge = document.createElement('script');
        bridge.id = 'slcrick-desktop-bridge';
        bridge.src = ${JSON.stringify(appUrl('js/desktop-bridge.js'))};
        document.head.appendChild(bridge);
      }
    })();`,
    true
  );
}

function isCloudSyncEnabledInSnapshot(snapshot) {
  if (!snapshot) return true;
  const keys = snapshot.keys || {};
  const enabledFlag = snapshot.cricpro_sync_enabled ?? keys.cricpro_sync_enabled;
  try {
    const raw = snapshot.cricpro_sync_settings ?? keys.cricpro_sync_settings;
    if (raw) {
      const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (cfg.userDisabled === true) return false;
      if (cfg.userDisabled === false) return true;
      return cfg.enabled !== false;
    }
  } catch (_) {}
  if (enabledFlag === 'false') return false;
  return true;
}

function refreshCloudSyncAllowedFromDisk() {
  cloudSyncAllowed = isCloudSyncEnabledInSnapshot(readDataFile());
}

async function refreshCloudSyncAllowedFromWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const allowed = await win.webContents.executeJavaScript(
      `(() => {
        try {
          if (window.SLCRICK_SYNC?.isEnabled) return !!window.SLCRICK_SYNC.isEnabled();
        } catch (_) {}
        try {
          const s = localStorage.getItem('cricpro_sync_settings');
          if (s) {
            const cfg = JSON.parse(s);
            if (cfg.userDisabled === true) return false;
            return navigator.onLine !== false;
          }
        } catch (_) {}
        return navigator.onLine !== false;
      })()`,
      true
    );
    if (typeof allowed === 'boolean') cloudSyncAllowed = allowed;
  } catch (_) {}
}

const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.socket.io",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* https://slcrickpro.onrender.com https://slcrickpro.live https://cdn.socket.io wss://slcrickpro.onrender.com wss: ws:",
  "frame-src 'self' http://127.0.0.1:* http://localhost:* https://slcrickpro.live https://www.slcrickpro.live",
  "object-src 'none'",
].join('; ');

function setupContentSecurityPolicy() {
  const ses = session.fromPartition(PARTITION);
  ses.webRequest.onHeadersReceived({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders['Content-Security-Policy'] = [DESKTOP_CSP];
    callback({ responseHeaders });
  });
}

function setupNetworkPolicy() {
  const ses = session.fromPartition(PARTITION);
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      if (!cloudSyncAllowed) {
        const url = details.url;
        const rt = details.resourceType || '';
        const isApiCall = rt === 'xhr' || rt === 'fetch' || rt === 'websocket';
        if (
          isApiCall &&
          (url.includes('slcrickpro.onrender.com') || url.includes('slcrickpro.live'))
        ) {
          callback({ cancel: true });
          return;
        }
      }
    } catch (_) {}
    callback({ cancel: false });
  });
}

let appLanBaseUrl = '';

function buildObsOverlayUrlAt(base, matchId, tournamentId, layer, theme) {
  const root = String(base || appBaseUrl || '').replace(/\/$/, '');
  const q = ['obs=1'];
  if (tournamentId) {
    q.push(`tournament=${encodeURIComponent(tournamentId)}`);
  } else if (matchId) {
    q.push(`match=${encodeURIComponent(matchId)}`);
  }
  if (layer === 'scorebar') {
    q.push('layer=scorebar', 'strip=1');
    q.push(`theme=${encodeURIComponent(theme || 'theme1')}`);
  } else if (layer === 'hotkeys') {
    q.push('layer=hotkeys');
  } else if (layer === 'combined' || !layer) {
    q.push('layer=combined');
    q.push(`theme=${encodeURIComponent(theme || 'theme1')}`);
    if (matchId) q.push(`matchId=${encodeURIComponent(matchId)}`);
  }
  return `${root}/pages/overlay.html?${q.filter(Boolean).join('&')}`;
}

function buildObsOverlayUrl(matchId, tournamentId, layer, theme) {
  return buildObsOverlayUrlAt(appBaseUrl, matchId, tournamentId, layer, theme);
}

function showObsGuide(matchId, tournamentId) {
  const overlayUrl = buildObsOverlayUrl(matchId, tournamentId);

  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'OBS Setup — SLCRICKPRO (Laptop)',
    message: 'Overlay OBS එකට දාන්න — හොඳම ක්‍රමය',
    detail:
      '★ Method 1 — Window Capture (recommended on laptop)\n' +
      '  1. In SLCRICKPRO: Hotkeys tab → "Quick OBS Setup" (or menu OBS → Open overlay window)\n' +
      '  2. Keep the "SLCRICKPRO OBS Overlay" window open while scoring\n' +
      '  3. In OBS: Sources → + → Window Capture\n' +
      '  4. Window: "SLCRICKPRO OBS Overlay"\n' +
      '  5. ✓ Capture cursor OFF · Resize to 1920×1080 in OBS if needed\n\n' +
      'Method 2 — Browser Source (one layer — recommended)\n' +
      '  One URL: scorebar + all hotkey graphics (1920×1080)\n' +
      '  Copy from Hotkeys tab → OBS → Sources → + → Browser → paste LAN URL\n' +
      '  1. Keep SLCRICKPRO app running (same PC / same Wi‑Fi)\n' +
      '  2. Paste URL (layer=combined):\n' +
      (appLanBaseUrl ? buildObsOverlayUrlAt(appLanBaseUrl, matchId, tournamentId, 'combined') : overlayUrl) +
      '\n  3. Width 1920 · Height 1080 · FPS 30\n' +
      '  4. ✓ Custom CSS: body { background-color: rgba(0,0,0,0) !important; }\n' +
      '  5. ✓ Shutdown source when not visible (recommended)\n\n' +
      'Score updates every ball — overlay reads live data from this PC.',
    buttons: ['Open Overlay Window', 'Copy Browser URL', 'OK'],
    defaultId: 2,
  }).then((res) => {
    if (res.response === 0) createOverlayWindow({ matchId, tournamentId });
    if (res.response === 1) {
      clipboard.writeText(overlayUrl);
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Copied',
        message: 'Paste this URL into OBS Browser Source.',
        detail: overlayUrl,
      });
    }
  });
}

function showWelcomeIfNeeded() {
  const flagPath = path.join(getAppStorageRoot(), '.welcome-shown');
  if (fs.existsSync(flagPath)) return;
  try {
    fs.writeFileSync(flagPath, '1', 'utf8');
  } catch (_) {
    return;
  }
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'SLCRICKPRO Desktop',
      message: 'සාදරයෙන් පිළිගනිමු! Welcome to SLCRICKPRO Desktop',
      detail:
        '• Score offline — no internet required\n' +
        '• Home → Score New Match → schedule tournaments\n' +
        '• File → Save data now (Ctrl+S)\n' +
        '• OBS → Menu → OBS → Copy Browser Source URL\n' +
        '• Wi‑Fi connect → scores auto-publish to slcrickpro.live\n' +
        '• Pause site sync → Settings → Cloud Sync\n' +
        '• Admin PIN: 1234\n\n' +
        `Data folder:\n${FILE_DATA_ROOT()}`,
      buttons: ['Open Home', 'Score a Match', 'Cloud Sync Settings', 'OK'],
      cancelId: 3,
      defaultId: 0,
    }).then((res) => {
      if (res.response === 0) mainWindow?.loadURL(appUrl('index.html'));
      else if (res.response === 1) mainWindow?.loadURL(appUrl('pages/score-match.html'));
      else if (res.response === 2) mainWindow?.loadURL(appUrl('pages/settings.html'));
    });
  }, 800);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'SLCRICKPRO',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0f' : '#f5f5f5',
    webPreferences: WEB_PREFS,
    show: false,
  });
  attachDevToolsKeyHandler(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    showWelcomeIfNeeded();
  });
  const startPage = process.env.SLCRICK_START_PAGE || 'index.html';
  mainWindow.loadURL(appUrl(startPage));

  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      await hydrateFromFileStore(mainWindow);
      await refreshCloudSyncAllowedFromWindow(mainWindow);
      await injectDesktopScripts(mainWindow);
      await mainWindow.webContents.executeJavaScript(
        `(function() {
          try {
            if (typeof renderResumeMatches === 'function') renderResumeMatches();
            if (typeof renderOngoing === 'function') renderOngoing();
            window.dispatchEvent(new Event('slcrick-db-ready'));
          } catch (e) { console.error('[SLCRICKPRO] UI refresh', e); }
        })();`,
        true
      );
    } catch (e) {
      console.error('[SLCRICKPRO] did-finish-load hydrate failed', e);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    if (scorecardPopupWindow && !scorecardPopupWindow.isDestroyed()) scorecardPopupWindow.close();
    if (obsPopupWindow && !obsPopupWindow.isDestroyed()) obsPopupWindow.close();
  });
}

function createOverlayWindow({ matchId, tournamentId, layer = 'combined' } = {}) {
  const overlayUrl = buildObsOverlayUrl(matchId, tournamentId, layer);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.loadURL(overlayUrl);
    overlayWindow.show();
    overlayWindow.focus();
    return overlayWindow;
  }

  const work = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1920, Math.max(960, work.width - 48));
  const winH = Math.min(1080, Math.round(winW * (1080 / 1920)));

  overlayWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 640,
    minHeight: 360,
    title: 'SLCRICKPRO OBS Overlay',
    transparent: true,
    frame: true,
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: WEB_PREFS,
  });
  attachDevToolsKeyHandler(overlayWindow);

  overlayWindow.setMenu(null);
  overlayWindow.setAlwaysOnTop(true, 'floating');
  overlayWindow.center();
  overlayWindow.loadURL(overlayUrl);

  overlayWindow.once('ready-to-show', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.show();
    overlayWindow.focus();
  });

  overlayWindow.webContents.on('did-finish-load', async () => {
    await hydrateFromFileStore(overlayWindow);
    await refreshCloudSyncAllowedFromWindow(overlayWindow);
    await injectDesktopScripts(overlayWindow);
    try {
      const loadedUrl = overlayWindow.webContents.getURL();
      const params = new URL(loadedUrl).searchParams;
      const mid = params.get('match');
      if (mid) {
        const match = fileStore.loadEntity(FILE_DATA_ROOT(), 'match', mid);
        if (match) {
          broadcast('desktop:match-update', match);
          await overlayWindow.webContents.executeJavaScript(
            `(function() {
              window.dispatchEvent(new Event('slcrick-db-ready'));
              if (typeof renderOverlay === 'function') renderOverlay();
            })();`,
            true
          );
        }
      }
    } catch (e) {
      console.warn('[SLCRICKPRO] overlay push match', e.message);
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

function isPopupScorerWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (scorecardPopupWindow && !scorecardPopupWindow.isDestroyed() && win.id === scorecardPopupWindow.id) {
    return true;
  }
  if (obsPopupWindow && !obsPopupWindow.isDestroyed() && win.id === obsPopupWindow.id) {
    return true;
  }
  try {
    const u = win.webContents.getURL();
    return u.includes('popupScore=1') || u.includes('obsPopup=1');
  } catch (_) {
    return false;
  }
}

function isMainScorerUrl(url) {
  return (
    url &&
    url.includes('score-match') &&
    !url.includes('popupScore=1') &&
    !url.includes('obsPopup=1')
  );
}

function findMainScorerWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && !isPopupScorerWindow(mainWindow)) {
    try {
      if (isMainScorerUrl(mainWindow.webContents.getURL())) return mainWindow;
    } catch (_) {}
  }
  return (
    BrowserWindow.getAllWindows().find((w) => {
      if (w.isDestroyed() || isPopupScorerWindow(w)) return false;
      try {
        return isMainScorerUrl(w.webContents.getURL());
      } catch (_) {
        return false;
      }
    }) || null
  );
}

async function resolveLiveMatchId(preferred) {
  if (preferred) return preferred;
  const win =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : findMainScorerWindow();
  if (win) {
    try {
      const id = await win.webContents.executeJavaScript(
        `(() => {
          const m = window.currentMatch;
          if (m && (m.status === 'live' || m.status === 'paused')) return m.id;
          return '';
        })()`,
        true
      );
      if (id) return id;
    } catch (_) {}
  }
  try {
    const { matches } = fileStore.loadAll(FILE_DATA_ROOT());
    const live = matches
      .filter((m) => m && (m.status === 'live' || m.status === 'paused'))
      .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
    return live[0]?.id || '';
  } catch (_) {
    return '';
  }
}

async function waitForScorerApi(win, matchId, maxMs = 15000) {
  const mid = JSON.stringify(matchId);
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!win || win.isDestroyed()) return false;
    try {
      const ready = await win.webContents.executeJavaScript(
        `(() => !!(window.DB && typeof window.loadMatch === 'function' && window.DB.getMatch(${mid})))()`,
        true
      );
      if (ready) {
        await win.webContents.executeJavaScript(
          `(() => {
            const m = window.DB.getMatch(${mid});
            if (m) window.loadMatch(m);
            return !!window.currentMatch;
          })()`,
          true
        );
        return true;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function ensureMainScorerForMatch(matchId) {
  if (!matchId) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const url = appUrl(`pages/score-match.html?matchId=${encodeURIComponent(matchId)}`);
  let needsLoad = true;
  try {
    needsLoad = !isMainScorerUrl(mainWindow.webContents.getURL());
  } catch (_) {
    needsLoad = true;
  }
  if (needsLoad) {
    mainWindow.loadURL(url);
    await new Promise((resolve) => {
      const done = () => resolve();
      mainWindow.webContents.once('did-finish-load', done);
      setTimeout(done, 12000);
    });
    await hydrateFromFileStore(mainWindow);
    await refreshCloudSyncAllowedFromWindow(mainWindow);
    await injectDesktopScripts(mainWindow);
  }
  await waitForScorerApi(mainWindow, matchId);
  return mainWindow;
}

async function pushMatchSnapshotToMainWindow(match) {
  if (!match?.id || !mainWindow || mainWindow.isDestroyed() || isPopupScorerWindow(mainWindow)) {
    return;
  }
  try {
    const payload = JSON.stringify(match);
    await mainWindow.webContents.executeJavaScript(
      `(function() {
        const m = ${payload};
        if (typeof applyDesktopMatchSnapshot === 'function') {
          applyDesktopMatchSnapshot(m);
          return true;
        }
        if (typeof loadMatch === 'function') {
          loadMatch(m);
          return true;
        }
        return false;
      })()`,
      true
    );
  } catch (e) {
    console.warn('[SLCRICKPRO] pushMatchSnapshotToMainWindow', e.message);
  }
}

async function openPopupScorecardFromMenu() {
  const matchId = await resolveLiveMatchId();
  if (!matchId) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Popup Scorecard',
      message: 'No live match found',
      detail: 'Start or resume scoring on the main window first.',
    });
    return;
  }
  await ensureMainScorerForMatch(matchId);
  createScorecardPopupWindow({ matchId });
}

async function openObsPopupFromMenu() {
  const matchId = await resolveLiveMatchId();
  let tournamentId = null;
  if (matchId) {
    try {
      const m = fileStore.loadEntity(FILE_DATA_ROOT(), 'match', matchId);
      tournamentId = m?.tournamentId || null;
    } catch (_) {}
    await ensureMainScorerForMatch(matchId);
  }
  createObsPopupWindow({ matchId: matchId || undefined, tournamentId: tournamentId || undefined });
}

function buildPopupScoreUrl(matchId) {
  const q = new URLSearchParams({ popupScore: '1' });
  if (matchId) q.set('matchId', matchId);
  return appUrl(`pages/score-match.html?${q.toString()}`);
}

function relinkPopupsToMatch(match) {
  const mid = match?.id;
  if (!mid) return;
  if (scorecardPopupWindow && !scorecardPopupWindow.isDestroyed()) {
    try {
      const cur = scorecardPopupWindow.webContents.getURL();
      if (!cur.includes(`matchId=${encodeURIComponent(mid)}`)) {
        scorecardPopupWindow.loadURL(buildPopupScoreUrl(mid));
      }
    } catch (_) {}
  }
  if (obsPopupWindow && !obsPopupWindow.isDestroyed()) {
    try {
      const cur = obsPopupWindow.webContents.getURL();
      if (!cur.includes(`matchId=${encodeURIComponent(mid)}`)) {
        const q = new URLSearchParams({ obsPopup: '1', matchId: mid });
        if (match.tournamentId) q.set('tournamentId', match.tournamentId);
        obsPopupWindow.loadURL(appUrl(`pages/score-match.html?${q.toString()}`));
      }
    } catch (_) {}
  }
}

function createScorecardPopupWindow({ matchId } = {}) {
  const url = buildPopupScoreUrl(matchId);
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const winW = Math.max(680, area.width - 24);
  const winH = Math.max(320, Math.round(area.height * 0.42));

  if (scorecardPopupWindow && !scorecardPopupWindow.isDestroyed()) {
    scorecardPopupWindow.loadURL(url);
    scorecardPopupWindow.show();
    scorecardPopupWindow.focus();
    return scorecardPopupWindow;
  }

  scorecardPopupWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 560,
    minHeight: 280,
    maxHeight: Math.round(area.height * 0.85),
    title: 'SLCRICKPRO — Popup Score',
    frame: true,
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: '#f0f2f8',
    webPreferences: WEB_PREFS,
  });
  attachDevToolsKeyHandler(scorecardPopupWindow);
  scorecardPopupWindow.setMenu(null);
  scorecardPopupWindow.setBounds({
    x: area.x + 12,
    y: area.y + area.height - winH - 8,
    width: winW,
    height: winH,
  });
  scorecardPopupWindow.loadURL(url);

  scorecardPopupWindow.once('ready-to-show', () => {
    if (!scorecardPopupWindow || scorecardPopupWindow.isDestroyed()) return;
    scorecardPopupWindow.show();
    scorecardPopupWindow.focus();
  });

  scorecardPopupWindow.webContents.on('did-finish-load', async () => {
    await hydrateFromFileStore(scorecardPopupWindow);
    await refreshCloudSyncAllowedFromWindow(scorecardPopupWindow);
    await injectDesktopScripts(scorecardPopupWindow);
    try {
      await scorecardPopupWindow.webContents.executeJavaScript(
        `(function() {
          document.documentElement.classList.add('popup-score-mode');
          if (localStorage.getItem('theme') !== 'dark') document.body.classList.add('light-mode');
          function boot() {
            if (typeof showScreen === 'function') showScreen('scoring');
            if (typeof switchScoringTab === 'function') switchScoringTab('scoring');
            else setTimeout(boot, 150);
          }
          boot();
          window.dispatchEvent(new Event('slcrick-db-ready'));
        })();`,
        true
      );
      if (matchId) {
        const match = fileStore.loadEntity(FILE_DATA_ROOT(), 'match', matchId);
        if (match) broadcast('desktop:match-update', match);
      }
    } catch (e) {
      console.warn('[SLCRICKPRO] popup score boot', e.message);
    }
  });

  scorecardPopupWindow.on('closed', () => {
    scorecardPopupWindow = null;
  });

  return scorecardPopupWindow;
}

function createObsPopupWindow({ matchId, tournamentId } = {}) {
  const q = new URLSearchParams({ obsPopup: '1' });
  if (matchId) q.set('matchId', matchId);
  if (tournamentId) q.set('tournamentId', tournamentId);
  const url = appUrl(`pages/score-match.html?${q.toString()}`);

  if (obsPopupWindow && !obsPopupWindow.isDestroyed()) {
    obsPopupWindow.loadURL(url);
    obsPopupWindow.show();
    obsPopupWindow.focus();
    return obsPopupWindow;
  }

  const work = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1280, Math.max(900, work.width - 80));
  const winH = Math.min(900, Math.round(winW * 0.65));

  obsPopupWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 720,
    minHeight: 480,
    title: 'SLCRICKPRO — OBS / Hotkeys',
    frame: true,
    resizable: true,
    maximizable: true,
    show: false,
    backgroundColor: '#0a0a0f',
    webPreferences: WEB_PREFS,
  });
  attachDevToolsKeyHandler(obsPopupWindow);
  obsPopupWindow.setMenu(null);
  obsPopupWindow.center();
  obsPopupWindow.loadURL(url);

  obsPopupWindow.once('ready-to-show', () => {
    if (!obsPopupWindow || obsPopupWindow.isDestroyed()) return;
    obsPopupWindow.show();
    obsPopupWindow.focus();
  });

  obsPopupWindow.webContents.on('did-finish-load', async () => {
    await hydrateFromFileStore(obsPopupWindow);
    await refreshCloudSyncAllowedFromWindow(obsPopupWindow);
    await injectDesktopScripts(obsPopupWindow);
    try {
      await obsPopupWindow.webContents.executeJavaScript(
        `(function() {
          document.documentElement.classList.add('obs-popup-mode');
          function bootObsPopup() {
            if (typeof showScreen === 'function') showScreen('scoring');
            if (typeof switchScoringTab === 'function') switchScoringTab('hotkeys');
            else setTimeout(bootObsPopup, 200);
          }
          bootObsPopup();
          window.dispatchEvent(new Event('slcrick-db-ready'));
        })();`,
        true
      );
      if (matchId) {
        const match = fileStore.loadEntity(FILE_DATA_ROOT(), 'match', matchId);
        if (match) broadcast('desktop:match-update', match);
      }
    } catch (e) {
      console.warn('[SLCRICKPRO] obs popup boot', e.message);
    }
  });

  obsPopupWindow.on('closed', () => {
    obsPopupWindow = null;
  });

  return obsPopupWindow;
}

function resolveTargetWindow(preferred) {
  if (preferred && !preferred.isDestroyed()) return preferred;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return wins[0] || null;
}

function isDevToolsBrowserWindow(win) {
  if (!win || win.isDestroyed()) return false;
  const t = String(win.getTitle() || '');
  return t.includes('Developer Tools') || t.includes('DevTools');
}

/** Dock DevTools inside the app window (reliable on Windows). */
function openDevToolsForWindow(preferredWin) {
  let win = preferredWin;
  if (!win || win.isDestroyed() || isDevToolsBrowserWindow(win)) {
    win = BrowserWindow.getFocusedWindow();
  }
  if (!win || win.isDestroyed() || isDevToolsBrowserWindow(win)) {
    win = mainWindow;
  }
  if (!win || win.isDestroyed()) {
    dialog.showErrorBox('Developer Tools', 'No SLCRICKPRO window is open.');
    return false;
  }

  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) {
    dialog.showErrorBox('Developer Tools', 'Page is not ready yet. Wait a moment and try again.');
    return false;
  }

  try {
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
      win.focus();
      return true;
    }

    wc.openDevTools({ mode: 'right', activate: true });
    win.focus();
    console.log('[SLCRICKPRO] Developer Tools opened (docked on the right)');
    return true;
  } catch (err) {
    console.error('[SLCRICKPRO] Developer Tools failed', err);
    dialog.showErrorBox(
      'Developer Tools failed',
      String(err?.message || err) + '\n\nTry closing the app and run START-SLCRICKPRO-DESKTOP.bat again.'
    );
    return false;
  }
}

function onMenuOpenDevTools(_menuItem, browserWindow) {
  openDevToolsForWindow(browserWindow);
}

function closeDevToolsForAllWindows() {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win.isDestroyed() || isDevToolsBrowserWindow(win)) return;
    try {
      if (win.webContents?.isDevToolsOpened()) win.webContents.closeDevTools();
    } catch (_) {}
  });
}

function toggleDevToolsForWindow(preferredWin) {
  const win = resolveTargetWindow(preferredWin);
  const wc = win?.webContents;
  if (wc && !wc.isDestroyed() && wc.isDevToolsOpened()) {
    wc.closeDevTools();
    win.focus();
    return true;
  }
  return openDevToolsForWindow(preferredWin);
}

function toggleDevToolsForFocusedWindow() {
  return toggleDevToolsForWindow(null);
}

function reloadFocusedWindow() {
  const win = resolveTargetWindow(null);
  const wc = win?.webContents;
  if (wc && !wc.isDestroyed()) wc.reload();
}

function attachDevToolsKeyHandler(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '');
    const ctrl = !!(input.control || input.meta);
    const shift = !!input.shift;
    if (key === 'F12' || (ctrl && shift && key.toLowerCase() === 'i')) {
      event.preventDefault();
      openDevToolsForWindow(win);
    }
  });
}

function registerGlobalDevToolsShortcuts() {
  try {
    globalShortcut.unregister('F12');
    globalShortcut.unregister('CommandOrControl+Shift+I');
  } catch (_) {}
  const f12 = globalShortcut.register('F12', () => openDevToolsForWindow(mainWindow));
  const csi = globalShortcut.register('CommandOrControl+Shift+I', () =>
    openDevToolsForWindow(null)
  );
  if (!f12) console.warn('[SLCRICKPRO] Could not register global F12 (use View menu)');
  if (!csi) console.warn('[SLCRICKPRO] Could not register Ctrl+Shift+I');
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Save data now', accelerator: 'CmdOrCtrl+S', click: () => persistNow() },
          { label: 'Open data folder', click: () => shell.openPath(FILE_DATA_ROOT()) },
          { label: 'Open legacy backup', click: () => shell.openPath(app.getPath('userData')) },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Scoring',
        submenu: [
          {
            label: 'Score new match',
            accelerator: 'CmdOrCtrl+N',
            click: () => mainWindow?.loadURL(appUrl('pages/score-match.html')),
          },
          {
            label: 'Ongoing matches',
            click: () => mainWindow?.loadURL(appUrl('pages/ongoing-matches.html')),
          },
          {
            label: 'Player registration',
            click: () => mainWindow?.loadURL(appUrl('pages/player-registration.html')),
          },
          { label: 'Admin panel', click: () => mainWindow?.loadURL(appUrl('pages/admin.html')) },
          { type: 'separator' },
          {
            label: 'Cloud sync settings',
            click: () => mainWindow?.loadURL(appUrl('pages/settings.html')),
          },
          {
            label: 'Popup window settings',
            click: () => mainWindow?.loadURL(appUrl('pages/settings.html#desktop-popup-settings')),
          },
        ],
      },
      {
        label: 'OBS',
        submenu: [
          {
            label: 'Open OBS overlay window',
            accelerator: 'CmdOrCtrl+Shift+O',
            click: () => createOverlayWindow(),
          },
          {
            label: 'Copy OBS Browser Source URL',
            click: () => {
              const url = buildObsOverlayUrl(null, null, 'combined');
              clipboard.writeText(url);
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                message: 'Hotkeys OBS URL copied — also copy Scorebar URL from Hotkeys tab',
                detail: url,
              });
            },
          },
          {
            label: 'Quick OBS setup (open overlay + guide)',
            click: () => {
              createOverlayWindow();
              showObsGuide();
            },
          },
          {
            label: 'Popup OBS / Hotkeys window',
            accelerator: 'CmdOrCtrl+Shift+H',
            click: () => {
              openObsPopupFromMenu().catch((e) => console.error('[SLCRICKPRO] OBS popup', e));
            },
          },
          { label: 'OBS setup guide', click: () => showObsGuide() },
        ],
      },
      {
        label: 'Popups',
        submenu: [
          {
            label: 'Open Popup Scorecard',
            accelerator: 'CmdOrCtrl+Shift+P',
            click: () => {
              openPopupScorecardFromMenu().catch((e) => console.error('[SLCRICKPRO] score popup', e));
            },
          },
          {
            label: 'Open OBS / Hotkeys popup',
            accelerator: 'CmdOrCtrl+Shift+H',
            click: () => {
              openObsPopupFromMenu().catch((e) => console.error('[SLCRICKPRO] OBS popup', e));
            },
          },
          { type: 'separator' },
          {
            label: 'Close all popups',
            click: () => {
              if (scorecardPopupWindow && !scorecardPopupWindow.isDestroyed()) scorecardPopupWindow.close();
              if (obsPopupWindow && !obsPopupWindow.isDestroyed()) obsPopupWindow.close();
            },
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Reload',
            accelerator: 'CmdOrCtrl+R',
            click: () => reloadFocusedWindow(),
          },
          {
            label: 'Developer Tools',
            accelerator: 'F12',
            click: onMenuOpenDevTools,
          },
          {
            label: 'Close Developer Tools',
            click: () => closeDevToolsForAllWindows(),
          },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Developer Tools (F12)',
            click: onMenuOpenDevTools,
          },
          { type: 'separator' },
          {
            label: 'About',
            click: () => {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'SLCRICKPRO',
                message: 'SLCRICKPRO Desktop',
                detail:
                  'Offline-first — data saved as JSON files on your PC.\n' +
                  `Folder: ${FILE_DATA_ROOT()}\n` +
                  'Menu → File → Open data folder',
              });
            },
          },
        ],
      },
    ])
  );
}

ipcMain.on('desktop:match-update', (_e, match) => {
  if (!match?.id) return;
  try {
    fileStore.saveEntity(FILE_DATA_ROOT(), 'match', match);
  } catch (e) {
    console.error('[SLCRICKPRO] save match file', e);
  }
  broadcast('desktop:match-update', match);
  relinkPopupsToMatch(match);
  schedulePersist();
});

ipcMain.handle('desktop:open-popup-scorecard', async (_e, opts) => {
  const matchId = await resolveLiveMatchId(opts?.matchId);
  if (!matchId) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Popup Scorecard',
      message: 'No live match found',
      detail: 'Start or resume scoring a match on the main window first.',
    });
    return false;
  }
  await ensureMainScorerForMatch(matchId);
  createScorecardPopupWindow({ matchId });
  return true;
});

ipcMain.handle('desktop:open-obs-popup', async (_e, opts) => {
  const matchId = await resolveLiveMatchId(opts?.matchId);
  let tournamentId = opts?.tournamentId || null;
  if (matchId) {
    try {
      const m = fileStore.loadEntity(FILE_DATA_ROOT(), 'match', matchId);
      if (m?.tournamentId) tournamentId = m.tournamentId;
    } catch (_) {}
    await ensureMainScorerForMatch(matchId);
  }
  createObsPopupWindow({ matchId: matchId || undefined, tournamentId: tournamentId || undefined });
  return true;
});

ipcMain.handle('desktop:get-live-match-id', async () => resolveLiveMatchId());

ipcMain.handle('desktop:close-popup-scorecard', () => {
  if (scorecardPopupWindow && !scorecardPopupWindow.isDestroyed()) scorecardPopupWindow.close();
  return true;
});

ipcMain.handle('desktop:close-obs-popup', () => {
  if (obsPopupWindow && !obsPopupWindow.isDestroyed()) obsPopupWindow.close();
  return true;
});

ipcMain.handle('desktop:scoring-command', async (_e, payload) => {
  let matchId = String(payload?.matchId || '')
    .replace(/\\/g, '')
    .replace(/'/g, '');
  if (!matchId) matchId = await resolveLiveMatchId();
  if (!matchId) {
    return { ok: false, error: 'No live match — start scoring first' };
  }

  const win = await ensureMainScorerForMatch(matchId);
  if (!win) {
    return { ok: false, error: 'Could not open main scorer — start a match first' };
  }

  const action = String(payload?.action || '');
  const cmdPayload = payload?.payload || {};
  const eventJson = JSON.stringify(cmdPayload.event ?? payload?.event ?? null);
  const extraType = JSON.stringify(cmdPayload.extraType || payload?.extraType || '');
  const cmdJson = JSON.stringify(cmdPayload);
  const uiConsumer = JSON.stringify(payload?.uiConsumer || '');

  const script = `(async function() {
    const mid = ${JSON.stringify(matchId)};
    function finishScoringCmd() {
      if (window.currentMatch) delete window.currentMatch._pendingUiConsumer;
      let snap = null;
      try {
        if (window.currentMatch) snap = JSON.parse(JSON.stringify(window.currentMatch));
      } catch (_) {}
      return { ok: true, match: snap };
    }
    try {
      if (!window.currentMatch || window.currentMatch.id !== mid) {
        const m = window.DB && window.DB.getMatch(mid);
        if (m && typeof window.loadMatch === 'function') {
          window.loadMatch(m);
        } else {
          return { ok: false, error: 'Match not loaded in main scorer' };
        }
      }
      const uiC = ${uiConsumer};
      if (uiC && window.currentMatch) window.currentMatch._pendingUiConsumer = uiC;
      const act = ${JSON.stringify(action)};
      if (act === 'recordBall' && typeof window.recordBall === 'function') {
        await window.recordBall(${eventJson});
        return finishScoringCmd();
      }
      if (act === 'recordExtra' && typeof window.recordExtra === 'function') {
        window.recordExtra(${extraType});
        return finishScoringCmd();
      }
      if (act === 'openWicketModal' && typeof window.openWicketModal === 'function') {
        window.openWicketModal();
        return finishScoringCmd();
      }
      if (act === 'undoAction' && typeof window.undoAction === 'function') {
        await window.undoAction();
        return finishScoringCmd();
      }
      if (act === 'redoAction' && typeof window.redoAction === 'function') {
        await window.redoAction();
        return finishScoringCmd();
      }
      if (act === 'confirmWide' && typeof window.confirmWide === 'function') {
        const p = ${cmdJson};
        window.wideExtraRuns = parseInt(p.wideExtraRuns, 10) || 0;
        await window.confirmWide();
        return finishScoringCmd();
      }
      if (act === 'confirmBye' && typeof window.confirmBye === 'function') {
        const p = ${cmdJson};
        window.byeExtraType = p.byeExtraType || 'bye';
        window.byeRuns = parseInt(p.byeRuns, 10) || 1;
        await window.confirmBye();
        return finishScoringCmd();
      }
      if (act === 'confirmNoball' && typeof window.confirmNoball === 'function') {
        const p = ${cmdJson};
        window.noballRuns = parseInt(p.noballRuns, 10) || 0;
        await window.confirmNoball();
        return finishScoringCmd();
      }
      if (act === 'confirmWicket' && typeof window.confirmWicket === 'function') {
        const p = ${cmdJson};
        window.wicketRuns = parseInt(p.wicketRuns, 10) || 0;
        const slot = String(p.dismissedSlot != null ? p.dismissedSlot : '0');
        const r = document.querySelector('input[name="dismissed"][value="' + slot + '"]');
        if (r) r.checked = true;
        const wt = document.getElementById('wicket-type');
        if (wt && p.wicketType) wt.value = p.wicketType;
        const wf = document.getElementById('wicket-fielder');
        if (wf) wf.value = p.fielder || '';
        await window.confirmWicket();
        return finishScoringCmd();
      }
      if (act === 'confirmNewBatsman' && typeof window.confirmNewBatsman === 'function') {
        const p = ${cmdJson};
        window.currentPendingWicket = p.slot != null ? p.slot : 0;
        const nameEl = document.getElementById('new-bat-name');
        const pidEl = document.getElementById('new-bat-pid');
        if (nameEl) nameEl.value = p.name || '';
        if (pidEl) pidEl.value = p.pid || '';
        await window.confirmNewBatsman();
        return finishScoringCmd();
      }
      if (act === 'confirmNewBowler' && typeof window.confirmNewBowler === 'function') {
        const p = ${cmdJson};
        const nameEl = document.getElementById('new-bowl-name');
        const pidEl = document.getElementById('new-bowl-pid');
        if (nameEl) nameEl.value = p.name || '';
        if (pidEl) pidEl.value = p.pid || '';
        await window.confirmNewBowler();
        return finishScoringCmd();
      }
      if (act === 'swapBatsmenEnds' && typeof window.swapBatsmenEnds === 'function') {
        await window.swapBatsmenEnds();
        return finishScoringCmd();
      }
      return { ok: false, error: 'Unknown action: ' + act };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  })()`;

  try {
    const result = await win.webContents.executeJavaScript(script, true);
    if (result?.ok && result?.match?.id) {
      try {
        fileStore.saveEntity(FILE_DATA_ROOT(), 'match', result.match);
      } catch (e) {
        console.error('[SLCRICKPRO] scoring-command save', e);
      }
      broadcast('desktop:match-update', result.match);
      relinkPopupsToMatch(result.match);
      schedulePersist();
      if (win !== mainWindow) {
        await pushMatchSnapshotToMainWindow(result.match);
      }
    }
    return result;
  } catch (e) {
    return { ok: false, error: e.message || 'Scoring command failed' };
  }
});

ipcMain.on('desktop:tournament-update', (_e, tourn) => {
  if (!tourn?.id) return;
  try {
    fileStore.saveEntity(FILE_DATA_ROOT(), 'tournament', tourn);
    if (Array.isArray(tourn.matches)) {
      const root = FILE_DATA_ROOT();
      const all = fileStore.loadAll(root);
      const matchMap = new Map(all.matches.map((m) => [m.id, m]));
      tourn.matches.forEach((mid) => {
        const m = matchMap.get(mid);
        if (m) fileStore.saveEntity(root, 'match', m);
      });
    }
  } catch (e) {
    console.error('[SLCRICKPRO] save tournament file', e);
  }
  broadcast('desktop:tournament-update', tourn);
  schedulePersist();
});

ipcMain.handle('desktop:get-storage-folder', () => FILE_DATA_ROOT());
ipcMain.handle('desktop:save-match-file', (_e, match) => {
  if (!match?.id) return null;
  return fileStore.saveEntity(FILE_DATA_ROOT(), 'match', match);
});
ipcMain.handle('desktop:save-tournament-file', (_e, tourn) => {
  if (!tourn?.id) return null;
  return fileStore.saveEntity(FILE_DATA_ROOT(), 'tournament', tourn);
});

ipcMain.handle('desktop:delete-match-file', (_e, id) => {
  if (!id) return false;
  try {
    fileStore.deleteEntity(FILE_DATA_ROOT(), 'match', id);
    return true;
  } catch (e) {
    console.error('[SLCRICKPRO] delete match file', e);
    return false;
  }
});

ipcMain.handle('desktop:purge-all-match-files', () => {
  try {
    const root = FILE_DATA_ROOT();
    const { matches } = fileStore.loadAll(root);
    matches.forEach((m) => fileStore.deleteEntity(root, 'match', m.id));
    schedulePersist();
    return { deleted: matches.length };
  } catch (e) {
    console.error('[SLCRICKPRO] purge match files', e);
    return { deleted: 0, error: e.message };
  }
});

/** Schedule tournament entirely in main process → JSON files on disk (no renderer DB). */
ipcMain.handle('desktop:schedule-tournament', async (_e, cfg) => {
  try {
    const root = FILE_DATA_ROOT();
    const { tournament, matches } = tournamentEngine.createTournament(cfg || {});

    fileStore.saveEntity(root, 'tournament', tournament);
    for (const m of matches) {
      fileStore.saveEntity(root, 'match', m);
    }

    const win =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      await hydrateFromFileStore(win);
      const pw = tournament.scoringPassword || 'offline';
      await win.webContents.executeJavaScript(
        `(function() {
          const t = ${JSON.stringify({ id: tournament.id, pw })};
          localStorage.setItem('tourn_pw_' + t.id, t.pw);
          if (typeof setTournamentAuthorized === 'function') {
            setTournamentAuthorized(t.id, 'local-creator', 7200000);
          }
          if (typeof SLCRICK_renderFromSchedule === 'function') {
            SLCRICK_renderFromSchedule(${JSON.stringify({ tournament, matchCount: matches.length })});
          }
          if (typeof renderResumeMatches === 'function') renderResumeMatches();
          if (typeof SLCRICK_renderResumeList === 'function') SLCRICK_renderResumeList();
          window.dispatchEvent(new Event('slcrick-db-ready'));
        })();`,
        true
      );
    }

    console.log(
      `[SLCRICKPRO] Scheduled ${tournament.name}: ${matches.length} matches → ${root}`
    );
    return {
      ok: true,
      tournament,
      matches,
      matchCount: matches.length,
      storageRoot: root,
    };
  } catch (err) {
    console.error('[SLCRICKPRO] schedule-tournament failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('desktop:reload-storage', async () => {
  const win =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return { ok: false };
  await hydrateFromFileStore(win);
  await win.webContents.executeJavaScript(
    `(function() {
      if (typeof renderResumeMatches === 'function') renderResumeMatches();
      window.dispatchEvent(new Event('slcrick-db-ready'));
    })();`,
    true
  );
  return { ok: true, root: FILE_DATA_ROOT() };
});

function pushBroadcastToOverlayWindow(payload) {
  if (!payload?.cmd || !overlayWindow || overlayWindow.isDestroyed()) return;
  const json = JSON.stringify(payload);
  overlayWindow.webContents
    .executeJavaScript(
      `(function(p){
        try {
          if (typeof handleBroadcastCommand === 'function') {
            handleBroadcastCommand(p.cmd, p.data || {});
          }
        } catch (e) { console.error('[overlay cmd]', e); }
      })(${json})`,
      true
    )
    .catch(() => {});
}

ipcMain.on('desktop:broadcast-command', (_e, payload) => {
  broadcastRelay.setLastBroadcast(payload);
  broadcast('desktop:broadcast-command', payload);
  pushBroadcastToOverlayWindow(payload);
});

ipcMain.on('desktop:persist-request', () => schedulePersist());
ipcMain.on('desktop:sync-settings', (_e, cfg) => {
  if (cfg && typeof cfg.enabled === 'boolean') cloudSyncAllowed = !!cfg.enabled;
  else if (cfg && cfg.userDisabled === true) cloudSyncAllowed = false;
  schedulePersist();
});

/** Cold-start wake from main process (bypasses renderer webRequest / ad-block patterns on /api/ping) */
ipcMain.handle('desktop:wake-backend', async (_e, backendUrl) => {
  const base = String(backendUrl || 'https://slcrickpro.onrender.com').replace(/\/$/, '');
  const target = `${base}/sync/matches`;
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'GET', url: target });
      req.on('response', (res) => {
        resolve(res.statusCode > 0 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
});
ipcMain.handle('desktop:get-data-path', () => DATA_FILE());
ipcMain.handle('desktop:get-base-url', () => appBaseUrl);
ipcMain.handle('desktop:open-overlay', (_e, opts) => {
  createOverlayWindow(opts || {});
  return true;
});
ipcMain.handle('desktop:show-obs-guide', (_e, opts) => {
  showObsGuide(opts?.matchId, opts?.tournamentId);
  return true;
});
ipcMain.handle('desktop:get-obs-url', (_e, opts) => {
  return buildObsOverlayUrl(
    opts?.matchId,
    opts?.tournamentId,
    opts?.layer || 'combined',
    opts?.theme
  );
});
ipcMain.handle('desktop:get-obs-browser-urls', (_e, opts) => {
  const matchId = opts?.matchId;
  const tournamentId = opts?.tournamentId;
  const layer = opts?.layer || 'combined';
  const theme = opts?.theme;
  const local = buildObsOverlayUrlAt(appBaseUrl, matchId, tournamentId, layer, theme);
  const lan = appLanBaseUrl
    ? buildObsOverlayUrlAt(appLanBaseUrl, matchId, tournamentId, layer, theme)
    : null;
  const website = buildObsOverlayUrlAt(
    'https://slcrickpro.live',
    matchId,
    tournamentId,
    layer,
    theme
  );
  return {
    local,
    lan,
    website,
    lanIp: localServer?.lanIp || null,
    port: localServer?.port || null,
    localBase: appBaseUrl,
    lanBase: appLanBaseUrl || null,
  };
});
ipcMain.on('desktop:close-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});

ipcMain.handle('desktop:toggle-devtools', () => toggleDevToolsForFocusedWindow());
ipcMain.handle('desktop:open-devtools', () => openDevToolsForWindow(mainWindow));

app.whenReady().then(async () => {
  try {
    const userDataPath = app.getPath('userData');
    app.setPath('cache', path.join(userDataPath, 'Cache'));
    fs.mkdirSync(getAppStorageRoot(), { recursive: true });
    migrateFromLegacyRoots(FILE_DATA_ROOT());
  } catch (e) {
    console.warn('[SLCRICKPRO] Storage init', e.message);
  }
  try {
    localServer = await startLocalServer(ROOT, {
      getDataRoot: FILE_DATA_ROOT,
      getLastBroadcast: () => broadcastRelay.getLastBroadcast(),
    });
    appBaseUrl = localServer.baseUrl;
    appLanBaseUrl = localServer.lanBaseUrl || '';
    console.log('[SLCRICKPRO] Local server:', appBaseUrl);
    if (appLanBaseUrl) console.log('[SLCRICKPRO] OBS LAN URL base:', appLanBaseUrl);
    else console.log('[SLCRICKPRO] OBS LAN: no Wi-Fi IP detected — use This PC URL only');
  } catch (e) {
    dialog.showErrorBox('SLCRICKPRO', 'Failed to start: ' + (e.message || e));
    app.quit();
    return;
  }
  refreshCloudSyncAllowedFromDisk();
  setupNetworkPolicy();
  setupContentSecurityPolicy();
  createMainWindow();
  buildMenu();
  registerGlobalDevToolsShortcuts();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createMainWindow();
  });
});

app.on('window-all-closed', async () => {
  await persistNow();
  if (localServer) await localServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
});

// Handle unhandled promise rejections gracefully
process.on('unhandledRejection', (reason, promise) => {
  console.error('[SLCRICKPRO] Unhandled Rejection:', reason);
});
app.on('before-quit', async () => {
  await persistNow();
  if (localServer) await localServer.close();
});
