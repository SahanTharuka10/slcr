/**
 * SLCRICKPRO — Local-first cloud sync (slcrickpro.live / Render API)
 * Load after js/db.js
 */
(function (global) {
  const DEFAULT_BACKEND = 'https://slcrickpro.onrender.com';
  const SETTINGS_KEY = 'cricpro_sync_settings';
  const MATCH_HISTORY_LIMIT = 80;

  let _serverAwake = false;
  let _wakePromise = null;
  let _isSyncingCloud = false;
  let _lastSyncTime = 0;
  const SYNC_DEBOUNCE_MS = 2000;

  function isLocalHost() {
    const h = global.location?.hostname || '';
    return h === 'localhost' || h === '127.0.0.1';
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    const legacyUrl = (localStorage.getItem('cricpro_backend_url') || '').trim();
    const legacyOn = localStorage.getItem('cricpro_sync_enabled') === 'true';
    const cfgUrl = (global.CRICPRO_CLOUD_CONFIG?.backendUrl || '').trim();
    const existing = (global.BACKEND_BASE_URL || '').trim();
    let enabled = legacyOn;
    let backendUrl = legacyUrl || cfgUrl || existing || DEFAULT_BACKEND;
    if (!global.SLCRICK_DESKTOP && !isLocalHost() && !legacyOn && !localStorage.getItem(SETTINGS_KEY)) {
      enabled = true;
    }
    return { enabled, backendUrl };
  }

  function saveSettings(cfg) {
    const next = {
      enabled: !!cfg.enabled,
      backendUrl: (cfg.backendUrl || DEFAULT_BACKEND).trim().replace(/\/$/, ''),
      lastSyncAt: cfg.lastSyncAt || null,
      lastSyncError: cfg.lastSyncError || null,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    localStorage.setItem('cricpro_sync_enabled', next.enabled ? 'true' : 'false');
    localStorage.setItem('cricpro_backend_url', next.enabled ? next.backendUrl : '');
    if (!next.enabled) {
      if (global.SLCRICK_DESKTOP) global.BACKEND_BASE_URL = '';
      global.SLCRICK_LIVE?.disconnect?.();
      if (global._slcrickSyncInterval) {
        clearInterval(global._slcrickSyncInterval);
        global._slcrickSyncInterval = null;
      }
    }
    if (global.desktopAPI?.notifySyncSettings) {
      global.desktopAPI.notifySyncSettings(next);
    }
    if (global.desktopAPI) global.desktopAPI.requestPersist();
    global.SLCRICK_BROADCAST?.emitStatus?.();
    return next;
  }

  function isEnabled() {
    return !!loadSettings().enabled;
  }

  function getBackendUrl() {
    if (!isEnabled()) return '';
    return loadSettings().backendUrl || DEFAULT_BACKEND;
  }

  function prepareMatchForPersistence(match) {
    if (!match || typeof match !== 'object') return match;
    const copy = JSON.parse(JSON.stringify(match));
    delete copy._isSyncing;
    delete copy._isBackgroundSync;
    if (Array.isArray(copy.history) && copy.history.length > MATCH_HISTORY_LIMIT) {
      copy.history = copy.history.slice(-MATCH_HISTORY_LIMIT);
    }
    if (Array.isArray(copy.redoStack) && copy.redoStack.length > MATCH_HISTORY_LIMIT) {
      copy.redoStack = copy.redoStack.slice(-MATCH_HISTORY_LIMIT);
    }
    return copy;
  }

  function getStoredTournamentScoringToken(tournamentId) {
    if (!tournamentId) return null;
    try {
      const map = JSON.parse(localStorage.getItem('cricpro_scoring_auth') || '{}');
      const entry = map[tournamentId];
      if (entry?.token && entry.exp > Date.now()) return entry.token;
    } catch (_) {}
    return null;
  }

  async function requestTournamentScoringToken(tournamentId, password) {
    const url = getBackendUrl();
    if (!url || !tournamentId || !password) return null;
    try {
      const r = await fetch(`${url}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tournamentId, type: 'tournament', password }),
      });
      const d = await r.json();
      if (r.ok && d.ok && d.token) {
        localStorage.setItem('cricpro_token', d.token);
        if (d.expiresInMs) {
          localStorage.setItem('cricpro_token_expiry', String(Date.now() + d.expiresInMs));
        }
        return d.token;
      }
    } catch (e) {
      console.warn('[Sync] handshake failed', e);
    }
    return null;
  }

  async function wakeUpServer(maxAttempts = 4) {
    if (!isEnabled()) return false;
    const url = getBackendUrl();
    if (!url || url.includes('127.0.0.1') || url.includes('localhost')) return false;
    if (_serverAwake) return true;
    if (_wakePromise) return _wakePromise;

    _wakePromise = (async () => {
      for (let i = 0; i < maxAttempts; i++) {
        try {
          await fetch(`${url}/api/ping`, {
            method: 'GET',
            cache: 'no-store',
            mode: 'cors',
            signal: AbortSignal.timeout(12000),
          });
          _serverAwake = true;
          return true;
        } catch (_) {
          await new Promise((r) => setTimeout(r, (i + 1) * 2500));
        }
      }
      _wakePromise = null;
      return false;
    })();
    return _wakePromise;
  }

  function applyRemoteMatches(remoteMatches, options = {}) {
    if (!global.DB || !Array.isArray(remoteMatches)) return false;
    const localMatches = global.DB.getMatches();
    const matchMap = new Map(localMatches.filter((m) => m && m.id).map((m) => [m.id, m]));
    let anyUpdated = false;

    remoteMatches
      .filter((m) => m && m.id && !m.deleted)
      .forEach((remoteMatch) => {
        const localMatch = matchMap.get(remoteMatch.id);
        const remoteTs = remoteMatch.lastUpdated || remoteMatch.cloudUpdatedAt || 0;
        const localTs = localMatch ? localMatch.lastUpdated || 0 : 0;
        if (!localMatch || remoteTs >= localTs) {
          if (!localMatch || JSON.stringify(localMatch) !== JSON.stringify(remoteMatch)) {
            anyUpdated = true;
          }
          matchMap.set(remoteMatch.id, remoteMatch);
        }
      });

    if (anyUpdated || options.forceRefresh) {
      global.DB.saveMatches(Array.from(matchMap.values()));
      localStorage.setItem('cricpro_force_update', String(Date.now()));
      _refreshAllUIs();
    }
    return anyUpdated;
  }

  function _refreshAllUIs() {
    if (typeof global.SLCRICK_BROADCAST_STATION?.refresh === 'function') {
      global.SLCRICK_BROADCAST_STATION.refresh();
    }
  }

  async function syncCloudData(options = {}) {
    const backendUrl = getBackendUrl();
    if (!backendUrl) {
      global._isGlobalSyncCompleted = true;
      return { ok: true, offline: true };
    }
    if (_isSyncingCloud) return;
    const now = Date.now();
    if (options.silent && now - _lastSyncTime < SYNC_DEBOUNCE_MS) return;
    _lastSyncTime = now;

    if (!_serverAwake && !options.forceRefresh) wakeUpServer(1).catch(() => {});

    _isSyncingCloud = true;
    try {
      const [mReq, tReq] = await Promise.all([
        fetch(`${backendUrl}/sync/matches`, { signal: AbortSignal.timeout(30000) }).catch(() => ({ ok: false })),
        fetch(`${backendUrl}/sync/tournaments`, { signal: AbortSignal.timeout(30000) }).catch(() => ({ ok: false })),
      ]);

      if (!mReq.ok && !tReq.ok) {
        const cfg = loadSettings();
        cfg.lastSyncError = 'Server unreachable';
        saveSettings(cfg);
        return { ok: false, error: 'fetch_failed' };
      }

      if (mReq.ok) {
        const matchData = await mReq.json();
        const remoteMatches = Array.isArray(matchData)
          ? matchData
          : Array.isArray(matchData?.matches)
            ? matchData.matches
            : [];
        applyRemoteMatches(remoteMatches, options);
      }

      if (tReq.ok && global.DB) {
        const tournData = await tReq.json();
        const remoteTourns = Array.isArray(tournData)
          ? tournData
          : Array.isArray(tournData?.tournaments)
            ? tournData.tournaments
            : [];
        if (Array.isArray(remoteTourns) && remoteTourns.length) {
          const local = global.DB.getTournaments();
          const map = new Map(local.filter((t) => t && t.id).map((t) => [t.id, t]));
          remoteTourns.forEach((t) => {
            if (!t.id) return;
            const loc = map.get(t.id);
            const remoteTs = t.lastUpdated || 0;
            const localTs = loc ? loc.lastUpdated || 0 : 0;
            if (!loc || remoteTs >= localTs) map.set(t.id, t);
          });
          global.DB.saveTournaments(Array.from(map.values()));
          _refreshAllUIs();
        }
      }

      const cfg = loadSettings();
      cfg.lastSyncAt = Date.now();
      cfg.lastSyncError = null;
      saveSettings(cfg);
      global._isGlobalSyncCompleted = true;
      return { ok: true };
    } catch (e) {
      console.error('[Sync] pull failed', e);
      const cfg = loadSettings();
      cfg.lastSyncError = e.message || 'sync_error';
      saveSettings(cfg);
      return { ok: false, error: e.message };
    } finally {
      _isSyncingCloud = false;
    }
  }

  function syncToDB(type, data) {
    const backendUrl = getBackendUrl();
    if (!backendUrl || !data) return;

    const syncPayload = type === 'match' ? prepareMatchForPersistence(data) : data;
    let endpoint = '';
    if (type === 'player') {
      endpoint = '/players';
      if (syncPayload && !syncPayload.id && syncPayload.playerId) syncPayload.id = syncPayload.playerId;
    } else if (type === 'team') endpoint = '/teams';
    else if (type === 'match') endpoint = '/sync/match';
    else if (type === 'tournament') {
      endpoint = '/sync/tournament';
      if (syncPayload?.teams && global.DB?.getTeamPhoto) {
        syncPayload.teamPhotos = syncPayload.teamPhotos || {};
        syncPayload.teams.forEach((teamName) => {
          const photo = global.DB.getTeamPhoto(teamName, syncPayload.id);
          if (photo && photo.startsWith('data:')) syncPayload.teamPhotos[teamName] = photo;
        });
      }
    } else if (type === 'order') endpoint = '/sync/order';
    else if (type === 'post') endpoint = '/sync/post';
    else return;

    if (data._isSyncing) return;
    data._isSyncing = true;

    let token = localStorage.getItem('cricpro_token');
    if (!token && type === 'match' && syncPayload?.tournamentId) {
      token = getStoredTournamentScoringToken(syncPayload.tournamentId);
    }

    const headers = { 'Content-Type': 'application/json', 'x-api-key': 'slcrickpro-v1' };
    if (token) headers['x-scoring-token'] = token;

    const finish = () => {
      data._isSyncing = false;
    };

    fetch(backendUrl + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(syncPayload),
    })
      .then(async (r) => {
        finish();
        if (r.status === 401 && type === 'match' && syncPayload?.tournamentId) {
          const pw = localStorage.getItem(`tourn_pw_${syncPayload.tournamentId}`);
          if (pw) {
            const newToken = await requestTournamentScoringToken(syncPayload.tournamentId, pw);
            if (newToken) syncToDB(type, data);
          }
          return;
        }
        if (!r.ok) console.warn(`[Sync] ${type} push ${r.status}`);
      })
      .catch((err) => {
        finish();
        console.warn('[Sync] push failed', err);
      });
  }

  async function pullGlobalData(showFeedback = false) {
    if (!isEnabled()) {
      global._isGlobalSyncCompleted = true;
      if (typeof global.renderResumeMatches === 'function') global.renderResumeMatches();
      return { ok: true, offline: true };
    }
    if (showFeedback && typeof global.showToast === 'function') {
      global.showToast('🔄 Syncing with cloud…', 'default');
    }
    await wakeUpServer();
    const res = await syncCloudData({ forceRefresh: true, silent: !showFeedback });
    global._isGlobalSyncCompleted = true;
    if (typeof global.renderResumeMatches === 'function') global.renderResumeMatches();
    if (typeof global.renderOngoing === 'function') global.renderOngoing();
    return res;
  }

  async function handshake(id, password) {
    if (!isEnabled()) {
      if (!global.DB) return { ok: false, error: 'DB not ready' };
      const type = id.startsWith('MATCH') ? 'match' : 'tournament';
      const obj = type === 'match' ? global.DB.getMatch(id) : global.DB.getTournament(id);
      if (!obj) return { ok: false, error: 'Not found' };
      const pw = obj.scoringPassword || obj.password;
      if (!pw || pw === password) {
        const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
        grants[id] = true;
        localStorage.setItem('cricpro_grants', JSON.stringify(grants));
        return { ok: true, offline: true };
      }
      return { ok: false, error: 'Wrong password' };
    }

    const url = getBackendUrl();
    const type = id.startsWith('MATCH') ? 'match' : 'tournament';
    try {
      const r = await fetch(`${url}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, type, password }),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        if (d.token) {
          localStorage.setItem('cricpro_token', d.token);
          if (d.expiresInMs) {
            localStorage.setItem('cricpro_token_expiry', String(Date.now() + d.expiresInMs));
          }
        }
        const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
        grants[id] = true;
        localStorage.setItem('cricpro_grants', JSON.stringify(grants));
        return { ok: true };
      }
      return { ok: false, error: d?.error || 'Access denied' };
    } catch (e) {
      return { ok: false, error: 'Connection failed' };
    }
  }

  function install() {
    const url = getBackendUrl();
    if (url) {
      global.BACKEND_BASE_URL = url;
      window.BACKEND_BASE_URL = url;
    }

    if (global.DB) {
      global.DB.getCloudURL = () => getBackendUrl() || global.BACKEND_BASE_URL || '';
      global.DB.handshake = handshake;
    }

    if (isEnabled()) {
      global.syncToDB = syncToDB;
      global.syncCloudData = syncCloudData;
      global.pullGlobalData = pullGlobalData;
      global.wakeUpServer = wakeUpServer;
      wakeUpServer().then((ok) => {
        if (ok) {
          syncCloudData({ silent: true });
          flushQueue();
        }
      });
      if (!global._slcrickSyncInterval) {
        global._slcrickSyncInterval = setInterval(() => {
          if (!isEnabled()) return;
          syncCloudData({ silent: true });
        }, 90000);
      }
    } else {
      global._isGlobalSyncCompleted = true;
      if (global.SLCRICK_DESKTOP) {
        global.syncToDB = function () {};
        global.BACKEND_BASE_URL = '';
      }
      global.SLCRICK_LIVE?.disconnect?.();
    }
    global.SLCRICK_BROADCAST?.emitStatus?.();
  }

  function flushQueue() {
    if (!global.DB || !isEnabled()) return;
    global.DB.getMatches()
      .filter((m) => m.publishLive !== false && (m.status === 'live' || m.status === 'paused' || m.status === 'scheduled'))
      .forEach((m) => syncToDB('match', { ...m, _isBackgroundSync: true }));
    global.DB.getTournaments().forEach((t) => syncToDB('tournament', { ...t, _isBackgroundSync: true }));
  }

  global.SLCRICK_SYNC = {
    DEFAULT_BACKEND,
    loadSettings,
    saveSettings,
    isEnabled,
    getBackendUrl,
    install,
    syncToDB,
    syncCloudData,
    pullGlobalData,
    handshake,
    wakeUpServer,
    flushQueue,
  };

  if (global.DB) install();
})(typeof window !== 'undefined' ? window : global);
