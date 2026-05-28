/**
 * SLCRICKPRO — Local-first cloud sync (slcrickpro.live / Render API)
 * Load after js/db.js
 */
(function (global) {
  const SYNC_CLIENT_VERSION = '2.41';
  const DEFAULT_BACKEND = 'https://slcrickpro.onrender.com';
  const SETTINGS_KEY = 'cricpro_sync_settings';
  const CLOUD_OPT_IN_KEY = 'cricpro_cloud_opt_in_v1';
  const LOCALHOST_ONLY_KEY = 'cricpro_localhost_only_v2';
  const MATCH_HISTORY_LIMIT = 80;
  const _handshake401Logged = new Set();
  /** tournamentId -> password that already got 401 (do not retry until password changes) */
  const _handshakeFailedPw = new Map();
  /** matchId or tournamentId — avoid console spam when cloud token missing */
  const _matchSyncBlockedLogged = new Set();

  let _serverAwake = false;
  let _wakePromise = null;
  let _isSyncingCloud = false;
  let _lastSyncTime = 0;
  let _lastSyncFailAt = 0;
  const SYNC_DEBOUNCE_MS = 2000;
  const SYNC_FAIL_BACKOFF_MS = 12000;
  const _tokenPushFailUntil = new Map();
  const _tokenPushWarned = new Set();
  const _pushWarnAt = new Map();
  const _tokenReqInFlight = new Map();
  const _tokenReqFailUntil = new Map();
  let _cloudTimeoutBackoffUntil = 0;
  let _cloudBackoffStepMs = 20000;
  let _cloudBackoffLastWarnAt = 0;
  let _cloudBackoffLastMarkAt = 0;
  const CLOUD_BACKOFF_MAX_MS = 90000;
  const CLOUD_BACKOFF_WARN_COOLDOWN_MS = 5 * 60 * 1000;
  let _pushPauseUntil = 0;
  const HANDSHAKE_HINT_KEY = 'cricpro_handshake_path_v2';
  function isPrimaryRenderBackend(url) {
    const s = String(url || '').toLowerCase();
    return s.includes('slcrickpro.onrender.com') || s.includes('slcrickpro.live');
  }
  function getDefaultHandshakePathHint() {
    try {
      const backend =
        global.CRICPRO_CLOUD_CONFIG?.backendUrl ||
        localStorage.getItem('cricpro_backend_url') ||
        global.BACKEND_BASE_URL ||
        DEFAULT_BACKEND;
      if (isPrimaryRenderBackend(backend)) return '/api/handshake';
      const stored = localStorage.getItem(HANDSHAKE_HINT_KEY);
      if (stored === '/api/handshake' || stored === '/handshake') return stored;
    } catch (_) {}
    return '/api/handshake';
  }

  function rememberHandshakePath(path) {
    if (!path || path === '/sync/handshake') return;
    _handshakePathHint = path;
    try {
      localStorage.setItem(HANDSHAKE_HINT_KEY, path);
    } catch (_) {}
  }

  function handshakePathsForBackend(baseUrl) {
    if (isPrimaryRenderBackend(baseUrl)) return ['/api/handshake'];
    if (_handshakePathHint === '/handshake') {
      return ['/handshake', '/api/handshake'];
    }
    return ['/api/handshake', '/handshake'];
  }
  let _handshakePathHint = getDefaultHandshakePathHint();
  let _handshakeRetryAfter = 0;
  let _syncCloudPromise = null;

  function formatSyncError(err) {
    if (!err) return 'unknown';
    if (err instanceof DOMException) {
      return err.name + (err.message ? ': ' + err.message : '');
    }
    return err.message || String(err);
  }

  function isTimeoutLike(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      err?.name === 'AbortError' ||
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('signal timed out') ||
      msg.includes('aborted')
    );
  }

  function isTransientNetworkLike(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('err_connection_closed') ||
      msg.includes('connection closed') ||
      msg.includes('err_connection_reset') ||
      msg.includes('networkerror') ||
      msg.includes('failed to fetch') ||
      msg.includes('fetch failed')
    );
  }

  function warnPushThrottled(scope, err) {
    const now = Date.now();
    const last = _pushWarnAt.get(scope) || 0;
    if (now - last < 30000) return;
    _pushWarnAt.set(scope, now);
    console.warn('[Sync] push failed', formatSyncError(err));
  }

  function shouldPausePushes() {
    return _pushPauseUntil > Date.now();
  }

  function isCloudTimeoutBackoffActive() {
    return _cloudTimeoutBackoffUntil > Date.now();
  }

  function clearCloudTimeoutBackoff() {
    _cloudTimeoutBackoffUntil = 0;
    _cloudBackoffStepMs = 20000;
    _cloudBackoffLastMarkAt = 0;
  }

  function isTransientHttpStatus(status) {
    return status === 502 || status === 503 || status === 504;
  }

  function shouldBackoffFromError(err) {
    if (!err) return false;
    if (isTimeoutLike(err) || isTransientNetworkLike(err)) return true;
    const m = String(err.message || err).match(/HTTP\s+(\d{3})/i);
    return m ? isTransientHttpStatus(Number(m[1])) : false;
  }

  function markCloudTimeoutBackoff(err, options = {}) {
    if (!shouldBackoffFromError(err)) return;
    const now = Date.now();
    const pauseMs = _cloudBackoffStepMs;
    _cloudTimeoutBackoffUntil = Math.max(_cloudTimeoutBackoffUntil, now + pauseMs);
    if (now - _cloudBackoffLastMarkAt > 2000) {
      _cloudBackoffStepMs = Math.min(Math.round(_cloudBackoffStepMs * 1.35), CLOUD_BACKOFF_MAX_MS);
    }
    _cloudBackoffLastMarkAt = now;
    const quiet =
      options.silent ||
      (global.SLCRICK_DESKTOP && !options.showWarn);
    if (quiet) return;
    if (now - _cloudBackoffLastWarnAt < CLOUD_BACKOFF_WARN_COOLDOWN_MS) return;
    _cloudBackoffLastWarnAt = now;
    const retrySec = Math.max(5, Math.round((_cloudTimeoutBackoffUntil - now) / 1000));
    console.warn(
      '[Sync] Cloud temporarily unavailable — local scoring continues. Next cloud retry in ~' +
        retrySec +
        's.'
    );
  }

  /** Safe timeout — AbortSignal.timeout is missing in some OBS/browser builds. */
  function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      try {
        return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      } catch (_) {}
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer));
  }

  async function fetchCloud(url, options = {}, retries = 2) {
    const timeoutMs = options.timeoutMs || 22000;
    const { timeoutMs: _t, ...fetchOpts } = options;
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) {
        _serverAwake = false;
        await wakeUpServer(2);
        await new Promise((r) => setTimeout(r, 1000 * i));
      }
      try {
        const r = await fetchWithTimeout(url, fetchOpts, timeoutMs);
        if (r.ok || r.status === 401 || r.status === 403) {
          _serverAwake = true;
          clearCloudTimeoutBackoff();
          return r;
        }
        lastErr = new Error('HTTP ' + r.status);
        if (!isTransientHttpStatus(r.status)) {
          _serverAwake = false;
          throw lastErr;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    _serverAwake = false;
    throw lastErr || new Error('fetch failed');
  }

  function isLocalHost() {
    const h = global.location?.hostname || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
  }

  function hasCloudOptIn() {
    try {
      return (
        localStorage.getItem(CLOUD_OPT_IN_KEY) === 'true' ||
        localStorage.getItem('cricpro_sync_user_opted_in') === 'true'
      );
    } catch (_) {
      return false;
    }
  }

  function isLocalhostOnlyMode() {
    if (global.SLCRICK_DESKTOP) return !hasCloudOptIn();
    if (isLocalHost()) return !hasCloudOptIn();
    return false;
  }

  function stopCloudLoops() {
    if (global._slcrickSyncInterval) {
      clearInterval(global._slcrickSyncInterval);
      global._slcrickSyncInterval = null;
    }
    if (global._slcrickFlushInterval) {
      clearInterval(global._slcrickFlushInterval);
      global._slcrickFlushInterval = null;
    }
    global._slcrickSyncBooted = false;
    _flushRunning = false;
    _isSyncingCloud = false;
    _syncCloudPromise = null;
  }

  function applyLocalhostOnlyDefaults() {
    if (!isLocalhostOnlyMode()) return;
    const stored = loadStoredSettings();
    saveSettings({
      enabled: false,
      userDisabled: true,
      backendUrl: '',
    });
    try {
      localStorage.setItem(LOCALHOST_ONLY_KEY, '1');
      localStorage.setItem('cricpro_sync_enabled', 'false');
      localStorage.removeItem('cricpro_backend_url');
    } catch (_) {}
    global.BACKEND_BASE_URL = '';
    if (global.window) global.window.BACKEND_BASE_URL = '';
    stopCloudLoops();
    global.syncToDB = function () {};
    global.SLCRICK_REALTIME?.disconnect?.();
    global.SLCRICK_LIVE?.disconnect?.();
    if (global.SLCRICK_DESKTOP && global.desktopAPI?.notifySyncSettings) {
      global.desktopAPI.notifySyncSettings({ enabled: false });
    }
  }

  function isNetworkOnline() {
    try {
      return global.navigator?.onLine !== false;
    } catch (_) {
      return true;
    }
  }

  /** Raw settings from storage (no auto-enable logic). */
  function loadStoredSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    const legacyUrl = (localStorage.getItem('cricpro_backend_url') || '').trim();
    const legacyOn = localStorage.getItem('cricpro_sync_enabled') === 'true';
    const cfgUrl = (global.CRICPRO_CLOUD_CONFIG?.backendUrl || '').trim();
    const existing = (global.BACKEND_BASE_URL || '').trim();
    return {
      enabled: legacyOn,
      backendUrl: legacyUrl || cfgUrl || existing || DEFAULT_BACKEND,
    };
  }

  function isUserSyncDisabled() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg.userDisabled === true) return true;
        if (cfg.userDisabled === false) return false;
        if (cfg.enabled === false) return true;
      }
    } catch (_) {}
    return localStorage.getItem('cricpro_sync_enabled') === 'false' && !!localStorage.getItem(SETTINGS_KEY);
  }

  function loadSettings() {
    const stored = loadStoredSettings();
    const backendUrl = stored.backendUrl || DEFAULT_BACKEND;

    if (global.SLCRICK_DESKTOP || isLocalHost()) {
      let enabled = false;
      if (hasCloudOptIn() && localStorage.getItem(SETTINGS_KEY)) {
        try {
          const cfg = JSON.parse(localStorage.getItem(SETTINGS_KEY));
          enabled = cfg.enabled === true && cfg.userDisabled !== true;
        } catch (_) {}
      }
      enabled = enabled && isNetworkOnline();
      return {
        ...stored,
        enabled,
        backendUrl: enabled ? backendUrl : '',
      };
    }

    let enabled = !!stored.enabled;
    if (!localStorage.getItem(SETTINGS_KEY) && !stored.enabled) {
      enabled = true;
    }
    return { ...stored, enabled, backendUrl };
  }

  function saveSettings(cfg) {
    const userDisabled =
      cfg.userDisabled !== undefined ? !!cfg.userDisabled : cfg.enabled === false;
    const next = {
      enabled: global.SLCRICK_DESKTOP ? !userDisabled : !!cfg.enabled,
      backendUrl: (cfg.backendUrl || DEFAULT_BACKEND).trim().replace(/\/$/, ''),
      lastSyncAt: cfg.lastSyncAt || null,
      lastSyncError: cfg.lastSyncError || null,
      userDisabled: global.SLCRICK_DESKTOP ? userDisabled : undefined,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    localStorage.setItem('cricpro_sync_enabled', next.enabled ? 'true' : 'false');
    localStorage.setItem('cricpro_backend_url', next.enabled ? next.backendUrl : '');
    if (!next.enabled) {
      try {
        localStorage.removeItem(CLOUD_OPT_IN_KEY);
      } catch (_) {}
      if (global.SLCRICK_DESKTOP) global.BACKEND_BASE_URL = '';
      if (global.window) global.window.BACKEND_BASE_URL = '';
      global.SLCRICK_REALTIME?.disconnect?.();
      global.SLCRICK_LIVE?.disconnect?.();
      stopCloudLoops();
    } else {
      try {
        localStorage.setItem(CLOUD_OPT_IN_KEY, 'true');
        localStorage.setItem('cricpro_sync_user_opted_in', 'true');
      } catch (_) {}
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

  function stripHeavyFields(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = obj;
    ['photo', 'team1Photo', 'team2Photo', 'banner', 'logo'].forEach((key) => {
      const v = copy[key];
      if (typeof v === 'string' && v.startsWith('data:') && v.length > 8000) delete copy[key];
    });
    if (copy.teamPhotos && typeof copy.teamPhotos === 'object') {
      Object.keys(copy.teamPhotos).forEach((k) => {
        const p = copy.teamPhotos[k];
        if (typeof p === 'string' && p.startsWith('data:') && p.length > 8000) delete copy.teamPhotos[k];
      });
    }
    return copy;
  }

  const MAX_INLINE_PHOTO_CHARS = 52000;

  function shrinkPhotoForCloud(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return '';
    if (!dataUrl.startsWith('data:')) return dataUrl;
    if (dataUrl.length <= MAX_INLINE_PHOTO_CHARS) return dataUrl;
    return '';
  }

  /** Embed team + player photos in match JSON so site overlay can hydrate localStorage */
  function attachCloudMediaToMatch(match) {
    if (!match || !global.DB) return match;
    match.teamPhotos = match.teamPhotos || {};
    const tid = match.tournamentId;
    const inn = match.innings?.[match.currentInnings ?? 0];
    const t1 = inn?.battingTeam || match.team1;
    const t2 = inn?.bowlingTeam || match.team2;
    [t1, t2].forEach((name) => {
      if (!name) return;
      const ph = shrinkPhotoForCloud(global.DB.getTeamPhoto(name, tid));
      if (ph) match.teamPhotos[name] = ph;
    });
    if (inn) {
      (inn.batsmen || []).forEach((b) => {
        if (!b?.playerId) return;
        const ph = shrinkPhotoForCloud(global.DB.getPlayerPhoto(b.playerId));
        if (ph) b.photo = ph;
      });
      (inn.bowlers || []).forEach((b) => {
        if (!b?.playerId) return;
        const ph = shrinkPhotoForCloud(global.DB.getPlayerPhoto(b.playerId));
        if (ph) b.photo = ph;
      });
    }
    return match;
  }

  function stripMatchInlineMedia(match) {
    if (!match || typeof match !== 'object') return match;
    const copy = JSON.parse(JSON.stringify(match));
    delete copy.broadcastLivePhotos;
    delete copy.teamPhotos;
    ['photo', 'team1Photo', 'team2Photo', 'banner', 'logo'].forEach((key) => {
      if (typeof copy[key] === 'string' && copy[key].startsWith('data:')) delete copy[key];
    });
    (copy.innings || []).forEach((inn) => {
      (inn?.batsmen || []).forEach((b) => {
        if (b && typeof b.photo === 'string' && b.photo.startsWith('data:')) delete b.photo;
      });
      (inn?.bowlers || []).forEach((b) => {
        if (b && typeof b.photo === 'string' && b.photo.startsWith('data:')) delete b.photo;
      });
    });
    return copy;
  }

  const _livePushSlots = new Map();

  function prepareMatchForPersistence(match, options = {}) {
    if (!match || typeof match !== 'object') return match;
    const copy = JSON.parse(JSON.stringify(match));
    delete copy._isSyncing;
    delete copy._isBackgroundSync;
    delete copy._fastPush;
    if (Array.isArray(copy.history) && copy.history.length > MATCH_HISTORY_LIMIT) {
      copy.history = copy.history.slice(-MATCH_HISTORY_LIMIT);
    }
    if (Array.isArray(copy.redoStack) && copy.redoStack.length > MATCH_HISTORY_LIMIT) {
      copy.redoStack = copy.redoStack.slice(-MATCH_HISTORY_LIMIT);
    }
    if (options.background || match._fastPush) stripHeavyFields(copy);
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

  function storeScoringToken(tournamentId, token, expiresInMs) {
    if (!token) return;
    if (tournamentId) _handshakeFailedPw.delete(tournamentId);
    const exp = Date.now() + (expiresInMs || 2 * 60 * 60 * 1000);
    localStorage.setItem('cricpro_token', token);
    localStorage.setItem('cricpro_token_expiry', String(exp));
    if (tournamentId) {
      try {
        const map = JSON.parse(localStorage.getItem('cricpro_scoring_auth') || '{}');
        map[tournamentId] = { token, exp };
        localStorage.setItem('cricpro_scoring_auth', JSON.stringify(map));
      } catch (_) {}
    }
  }

  /** Real scoring password for cloud API — never sends desktop-only "offline". */
  function getCloudScoringPassword(tournamentId) {
    if (!tournamentId) return '';
    const stored = localStorage.getItem(`tourn_pw_${tournamentId}`);
    if (stored && String(stored).trim() && stored !== 'offline') return String(stored).trim();
    const t = global.DB?.getTournament?.(tournamentId);
    const pw = t?.scoringPassword || t?.password || '';
    const trimmed = String(pw || '').trim();
    if (trimmed && trimmed !== 'offline') return trimmed;
    return '';
  }

  function tournamentPassword(tournamentId) {
    const cloud = getCloudScoringPassword(tournamentId);
    if (cloud) return cloud;
    if (global.SLCRICK_DESKTOP) return 'offline';
    return '';
  }

  async function pushTournamentForScoringToken(tournamentId, password) {
    const url = getBackendUrl();
    if (!url || !tournamentId || !password) return null;
    if (!isNetworkOnline()) return null;
    if (isCloudTimeoutBackoffActive()) return null;
    if ((_tokenPushFailUntil.get(tournamentId) || 0) > Date.now()) return null;
    const t = global.DB?.getTournament?.(tournamentId);
    if (!t) return null;
    try {
      await wakeUpServer(2);
      const payload = stripHeavyFields(JSON.parse(JSON.stringify({ ...t, scoringPassword: password })));
      const r = await fetchCloud(
        `${url}/sync/tournament`,
        {
          method: 'POST',
          headers: buildAuthHeaders(null),
          body: JSON.stringify(payload),
          timeoutMs: 12000,
        },
        0
      );
      const d = await r.json().catch(() => ({}));
      if (d?.token) {
        _tokenPushFailUntil.delete(tournamentId);
        _tokenPushWarned.delete(tournamentId);
        storeScoringToken(tournamentId, d.token, d.expiresInMs);
        return d.token;
      }
    } catch (e) {
      markCloudTimeoutBackoff(e, { silent: true });
      const timeoutLike = isTimeoutLike(e);
      _tokenPushFailUntil.set(tournamentId, Date.now() + (timeoutLike ? 5 * 60 * 1000 : 90 * 1000));
      _tokenReqFailUntil.set(tournamentId, Date.now() + (timeoutLike ? 90 * 1000 : 30 * 1000));
      if (!timeoutLike && !_tokenPushWarned.has(tournamentId)) {
        _tokenPushWarned.add(tournamentId);
        console.warn('[Sync] tournament push for token failed', formatSyncError(e));
      }
    }
    return null;
  }

  async function requestTournamentScoringToken(tournamentId, password) {
    const url = getBackendUrl();
    const pw = String(password || '').trim();
    if (!url || !tournamentId || !pw || pw === 'offline') return null;
    if (isCloudTimeoutBackoffActive()) return null;
    if (_handshakeRetryAfter > Date.now()) return null;
    if (_handshakeFailedPw.get(tournamentId) === pw) return null;
    if ((_tokenReqFailUntil.get(tournamentId) || 0) > Date.now()) return null;
    const inFlight = _tokenReqInFlight.get(tournamentId);
    if (inFlight) return inFlight;

    const reqPromise = (async () => {
      const fromSync = await pushTournamentForScoringToken(tournamentId, pw);
      if (fromSync) {
        _tokenReqFailUntil.delete(tournamentId);
        return fromSync;
      }

      try {
        const r = await postHandshake(url, {
          id: tournamentId,
          type: 'tournament',
          password: pw,
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok && d.token) {
          _handshakeFailedPw.delete(tournamentId);
          _tokenReqFailUntil.delete(tournamentId);
          storeScoringToken(tournamentId, d.token, d.expiresInMs);
          return d.token;
        }
        if (r.status === 401) {
          _handshakeFailedPw.set(tournamentId, pw);
          if (!_handshake401Logged.has(tournamentId)) {
            _handshake401Logged.add(tournamentId);
            const tName = global.DB?.getTournament?.(tournamentId)?.name || tournamentId;
            console.warn(
              `[Sync] Tournament "${tName}" — cloud password mismatch. Open Score Match → enter the scoring password you used when creating this tournament (not "offline").`
            );
            if (typeof global.showToast === 'function') {
              global.showToast(
                `Cloud sync needs the real password for "${tName}". Open Score Match and unlock with your tournament password.`,
                'error'
              );
            }
          }
          _tokenReqFailUntil.set(tournamentId, Date.now() + 60 * 1000);
        }
      } catch (e) {
        markCloudTimeoutBackoff(e, { silent: true });
        if (e?.code === 'HANDSHAKE_ENDPOINT_MISSING') {
          _handshakeRetryAfter = Date.now() + 10 * 60 * 1000;
          _tokenReqFailUntil.set(tournamentId, Date.now() + 2 * 60 * 1000);
          return null;
        }
        if (isTimeoutLike(e)) {
          _tokenReqFailUntil.set(tournamentId, Date.now() + 90 * 1000);
        }
        if (!_tokenPushWarned.has('hs:' + tournamentId)) {
          _tokenPushWarned.add('hs:' + tournamentId);
          console.warn('[Sync] handshake failed', formatSyncError(e));
        }
      }
      return null;
    })();
    _tokenReqInFlight.set(tournamentId, reqPromise);
    try {
      return await reqPromise;
    } finally {
      _tokenReqInFlight.delete(tournamentId);
    }
  }

  function logMatchSyncBlockedOnce(tournamentId, matchId, reason) {
    const key = `${tournamentId}:${matchId || ''}:${reason || 'token'}`;
    if (_matchSyncBlockedLogged.has(key)) return;
    _matchSyncBlockedLogged.add(key);
    const tName = global.DB?.getTournament?.(tournamentId)?.name || tournamentId;
    const msg =
      reason === 'no_cloud_password'
        ? `[Sync] "${tName}" — enter your real tournament scoring password in Score Match (not offline) so live scores can sync.`
        : `[Sync] "${tName}" — cloud password mismatch. Re-unlock in Score Match with the password from tournament setup.`;
    console.warn(msg);
    if (typeof global.showToast === 'function') {
      global.showToast(msg.replace('[Sync] ', ''), 'error');
    }
  }

  function tournamentPayloadForCloud(t) {
    if (!t) return null;
    const payload = { ...t };
    const pw = getCloudScoringPassword(t.id);
    if (pw) payload.scoringPassword = pw;
    return payload;
  }

  async function ensureScoringToken(tournamentId) {
    if (!tournamentId) {
      const exp = Number(localStorage.getItem('cricpro_token_expiry') || 0);
      const token = localStorage.getItem('cricpro_token');
      if (token && token !== 'ok' && exp > Date.now()) return token;
      return null;
    }
    const fromMap = getStoredTournamentScoringToken(tournamentId);
    if (fromMap) return fromMap;

    const pw = getCloudScoringPassword(tournamentId);
    if (pw) {
      const tok = await requestTournamentScoringToken(tournamentId, pw);
      if (tok) return tok;
    }

    if (isEnabled()) {
      const openTok = await requestTournamentScoringToken(tournamentId, 'slcrick-sync');
      if (openTok) return openTok;
    }

    const exp = Number(localStorage.getItem('cricpro_token_expiry') || 0);
    const legacy = localStorage.getItem('cricpro_token');
    if (legacy && legacy !== 'ok' && exp > Date.now()) return legacy;
    return null;
  }

  /** Production requires x-scoring-token for tournament matches; prime cloud row then fetch token. */
  async function resolveMatchSyncToken(tournamentId) {
    if (!tournamentId) return null;
    await primeTournamentForMatch(tournamentId);
    let token = await ensureScoringToken(tournamentId);
    if (!token) {
      const pw = getCloudScoringPassword(tournamentId);
      if (pw) token = await requestTournamentScoringToken(tournamentId, pw);
    }
    return token || null;
  }

  async function authenticateAllTournaments() {
    if (!global.DB || !isEnabled() || !isNetworkOnline()) return;
    if (isCloudTimeoutBackoffActive()) return;
    const awake = await wakeUpServer(2);
    if (!awake) return;
    const activeTournIds = new Set();
    global.DB.getMatches().forEach((m) => {
      if (
        m?.tournamentId &&
        (m.status === 'live' || m.status === 'paused' || m.status === 'completed')
      ) {
        activeTournIds.add(m.tournamentId);
      }
    });

    const tourns = global.DB.getTournaments().filter((t) => t && t.id);
    for (const t of tourns) {
      if (!activeTournIds.has(t.id) && !t.isLocked && !t.scoringPassword && !t.password) {
        continue;
      }
      const pw = getCloudScoringPassword(t.id) || 'slcrick-sync';
      await requestTournamentScoringToken(t.id, pw);
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /** Cloud must have the tournament row (and password hash) before secured match pushes. */
  async function primeTournamentForMatch(tournamentId) {
    if (!tournamentId || !global.DB) return;
    const t = global.DB.getTournament(tournamentId);
    if (!t) return;
    const payload = tournamentPayloadForCloud(t) || t;
    await syncToDB('tournament', { ...payload, _isBackgroundSync: true, _primeOnly: true });
    await ensureScoringToken(tournamentId);
  }

  function buildAuthHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': 'slcrickpro-v1',
    };
    // Do not send x-slcrick-client — Render CORS rarely whitelists it; desktop publish is allowed via x-api-key + publishLive (see server authorizeMatchSync).
    if (token && token !== 'ok') {
      headers['x-scoring-token'] = token;
      headers.Authorization = 'Bearer ' + token;
    }
    return headers;
  }

  async function drainLivePushQueue(matchId) {
    const slot = _livePushSlots.get(matchId);
    if (!slot || slot.inFlight || !slot.pending) return;
    slot.inFlight = true;
    const src = slot.pending;
    slot.pending = null;
    const copy = JSON.parse(JSON.stringify(src));
    delete copy._isSyncing;
    copy.publishLive = copy.publishLive !== false;
    copy.lastUpdated = Date.now();
    copy._isBackgroundSync = true;
    copy._fastPush = true;
    try {
      await syncToDB('match', copy);
    } catch (_) {}
    slot.inFlight = false;
    if (slot.pending) drainLivePushQueue(matchId);
    else _livePushSlots.delete(matchId);
  }

  /** Push one live match to cloud immediately (after each score on desktop). */
  function pushLiveMatchNow(match) {
    if (!match?.id || !isEnabled() || !global.DB) return Promise.resolve({ ok: false });
    let slot = _livePushSlots.get(match.id);
    if (!slot) {
      slot = { pending: null, inFlight: false };
      _livePushSlots.set(match.id, slot);
    }
    slot.pending = match;
    if (!slot.inFlight) drainLivePushQueue(match.id);
    return Promise.resolve({ ok: true, queued: true });
  }

  async function wakeUpServer(maxAttempts = 4) {
    if (!isEnabled()) return false;
    const url = getBackendUrl();
    if (!url || url.includes('127.0.0.1') || url.includes('localhost')) return false;
    if (_serverAwake) return true;
    if (global.SLCRICK_REALTIME?.wakeApi) {
      const ok = await global.SLCRICK_REALTIME.wakeApi({
        force: maxAttempts > 2,
        reason: 'sync-client',
      });
      if (ok) {
        _serverAwake = true;
        clearCloudTimeoutBackoff();
      }
      return ok;
    }
    if (_wakePromise) return _wakePromise;
    _wakePromise = (async () => {
      try {
        const r = await fetchWithTimeout(
          `${url}/sync/matches`,
          { method: 'GET', cache: 'no-store', mode: 'cors' },
          12000
        );
        if (r.ok || r.status === 401 || r.status === 403) {
          _serverAwake = true;
          clearCloudTimeoutBackoff();
          return true;
        }
      } catch (_) {}
      return false;
    })().finally(() => {
      _wakePromise = null;
    });
    return _wakePromise;
  }

  function applyRemoteMatches(remoteMatches, options = {}) {
    if (!global.DB || !Array.isArray(remoteMatches)) return false;
    const localMatches = global.DB.getMatches();
    const matchMap = new Map(localMatches.filter((m) => m && m.id).map((m) => [m.id, m]));
    let anyUpdated = false;

    const keepFn = global.DB?.shouldStoreRemoteMatchLocally || ((m) => m && m.id && !m.deleted);
    remoteMatches
      .filter((m) => keepFn(m))
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
    if (typeof global.SLCRICK_WEBSITE_FEED?.refreshLiveUi === 'function') {
      global.SLCRICK_WEBSITE_FEED.refreshLiveUi();
    } else {
      if (typeof global.updateTicker === 'function') global.updateTicker();
      if (typeof global.renderOngoing === 'function') global.renderOngoing();
      if (typeof global.refreshTournamentStandingsUI === 'function') {
        global.refreshTournamentStandingsUI();
      }
    }
    try {
      global.dispatchEvent?.(
        new CustomEvent('slcrick-live-update', { detail: { type: 'sync' } })
      );
    } catch (_) {}
  }

  async function syncCloudData(options = {}) {
    if (isCloudTimeoutBackoffActive()) {
      return { ok: false, error: 'timeout_backoff', silent: !!options.silent };
    }
    if (_syncCloudPromise) return _syncCloudPromise;
    _syncCloudPromise = syncCloudDataInner(options).finally(() => {
      _syncCloudPromise = null;
    });
    return _syncCloudPromise;
  }

  async function syncCloudDataInner(options = {}) {
    const backendUrl = getBackendUrl();
    if (!backendUrl) {
      global._isGlobalSyncCompleted = true;
      return { ok: true, offline: true };
    }
    if (isCloudTimeoutBackoffActive()) {
      if (!options.silent) {
        return { ok: false, error: 'timeout_backoff', offline: true };
      }
      return { ok: false, error: 'timeout_backoff', silent: true };
    }
    if (!isNetworkOnline()) {
      return { ok: false, error: 'offline' };
    }
    if (_isSyncingCloud) return { ok: false, error: 'busy' };
    const now = Date.now();
    const debounceMs =
      _lastSyncFailAt && now - _lastSyncFailAt < SYNC_FAIL_BACKOFF_MS
        ? SYNC_FAIL_BACKOFF_MS
        : SYNC_DEBOUNCE_MS;
    if (options.silent && now - _lastSyncTime < debounceMs) return;
    _lastSyncTime = now;

    _isSyncingCloud = true;
    try {
      const awake = await wakeUpServer(options.forceRefresh ? 3 : 2);
      if (!awake && isPrimaryRenderBackend(backendUrl)) {
        await new Promise((r) => setTimeout(r, 1800));
      }

      const fetchOpts = { method: 'GET', cache: 'no-store', mode: 'cors', timeoutMs: 16000 };
      const pullRetries = options.forceRefresh ? 1 : 0;
      let mReq = null;
      let tReq = null;
      try {
        mReq = await fetchCloud(`${backendUrl}/sync/matches`, fetchOpts, pullRetries);
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 400));
      try {
        tReq = await fetchCloud(`${backendUrl}/sync/tournaments`, fetchOpts, pullRetries);
      } catch (_) {}

      if ((!mReq || !mReq.ok) && (!tReq || !tReq.ok)) {
        _lastSyncFailAt = Date.now();
        _serverAwake = false;
        const cfg = loadSettings();
        const st = mReq?.status || tReq?.status || 0;
        if (st === 401 || st === 403) {
          cfg.lastSyncError =
            'Cloud sync needs tournament scoring password — open match in Score Match and unlock';
        } else {
          cfg.lastSyncError = 'Server waking up — retry in a few seconds';
        }
        saveSettings(cfg);
        const pullErr = new Error(st ? 'HTTP ' + st : 'fetch_failed');
        markCloudTimeoutBackoff(pullErr, {
          silent: options.silent || global.SLCRICK_DESKTOP,
        });
        return { ok: false, error: 'fetch_failed', status: st };
      }

      if (mReq?.status === 401 || mReq?.status === 403) {
        const cfg = loadSettings();
        cfg.lastSyncError =
          'Cloud sync unauthorized — re-enter tournament password in Score Match';
        saveSettings(cfg);
        global._isGlobalSyncCompleted = true;
        return { ok: false, error: 'auth_failed', status: mReq.status };
      }

      if (mReq?.ok) {
        const matchData = await mReq.json();
        const remoteMatches = Array.isArray(matchData)
          ? matchData
          : Array.isArray(matchData?.matches)
            ? matchData.matches
            : [];
        applyRemoteMatches(remoteMatches, options);
        const cfg = loadSettings();
        cfg.lastSyncError = null;
        saveSettings(cfg);
      }

      if (tReq?.ok && global.DB) {
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
            if (!loc || remoteTs >= localTs) {
              const merged = { ...t };
              const localPw = loc?.scoringPassword || loc?.password;
              const storedPw = localStorage.getItem(`tourn_pw_${t.id}`);
              if (!merged.scoringPassword && !merged.password) {
                if (localPw) merged.scoringPassword = localPw;
                else if (storedPw) merged.scoringPassword = storedPw;
              }
              if (loc?.isLocked && !merged.isLocked) merged.isLocked = loc.isLocked;
              map.set(t.id, merged);
            }
          });
          global.DB.saveTournaments(Array.from(map.values()));
          _refreshAllUIs();
        }
      }

      const cfg = loadSettings();
      cfg.lastSyncAt = Date.now();
      cfg.lastSyncError = null;
      saveSettings(cfg);
      _lastSyncFailAt = 0;
      clearCloudTimeoutBackoff();
      if (global.SLCRICK_DESKTOP) _desktopFlushIntervalMs = 15000;
      global._isGlobalSyncCompleted = true;
      return { ok: true };
    } catch (e) {
      markCloudTimeoutBackoff(e, { silent: options.silent || global.SLCRICK_DESKTOP });
      _lastSyncFailAt = Date.now();
      _serverAwake = false;
      const msg = formatSyncError(e);
      const cfg = loadSettings();
      cfg.lastSyncError = msg.includes('Abort') ? 'Sync timed out — server may be waking' : msg;
      saveSettings(cfg);
      return { ok: false, error: msg };
    } finally {
      _isSyncingCloud = false;
    }
  }

  async function syncToDB(type, data) {
    const backendUrl = getBackendUrl();
    if (!backendUrl || !data) return;
    if (isCloudTimeoutBackoffActive()) return;
    const background = !!data._isBackgroundSync;
    if (background && shouldPausePushes()) return;

    let syncPayload =
      type === 'match'
        ? prepareMatchForPersistence(data, { background })
        : background
          ? stripHeavyFields(JSON.parse(JSON.stringify(data)))
          : data;
    if (type === 'match' && syncPayload && isEnabled() && !data._fastPush) {
      syncPayload = attachCloudMediaToMatch(syncPayload);
    }
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

    if (data._isSyncing && !data._fastPush) return;
    if (!data._fastPush) data._isSyncing = true;

    const tid =
      type === 'match'
        ? syncPayload?.tournamentId
        : type === 'tournament'
          ? syncPayload?.id
          : null;

    let token = null;
    if (type === 'match' && tid && !data._primeOnly) {
      token = await resolveMatchSyncToken(tid);
      if (!token) {
        const reason = getCloudScoringPassword(tid) ? 'handshake_failed' : 'no_cloud_password';
        if (!global.SLCRICK_DESKTOP) {
          logMatchSyncBlockedOnce(tid, syncPayload?.id, reason);
          data._isSyncing = false;
          return;
        }
        logMatchSyncBlockedOnce(tid, syncPayload?.id, reason);
      }
    } else if (type === 'tournament' && tid) {
      await ensureScoringToken(null);
      token = await ensureScoringToken(tid);
    } else {
      token = await ensureScoringToken(tid || null);
      if (!token && tid) token = await ensureScoringToken(tid);
    }

    let headers = buildAuthHeaders(token);
    if (type === 'match' && syncPayload) {
      const liveish = syncPayload.status === 'live' || syncPayload.status === 'paused';
      if (global.SLCRICK_DESKTOP && liveish) syncPayload.publishLive = true;
      else if (syncPayload.publishLive === undefined) syncPayload.publishLive = true;
    }

    const finish = () => {
      if (!data._fastPush) data._isSyncing = false;
    };

    try {
      let r = await fetchCloud(
        backendUrl + endpoint,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(syncPayload),
          timeoutMs: background || data._fastPush ? 12000 : 18000,
        },
        background || (type === 'match' && data._fastPush) ? 0 : 1
      );

      if (type === 'tournament' && tid) {
        try {
          const body = await r.clone().json();
          if (body?.token) storeScoringToken(tid, body.token, body.expiresInMs);
        } catch (_) {}
      }

      if (r.status === 401 && tid) {
        if (type === 'match' && !data._authRetried) {
          data._authRetried = true;
          finish();
          data._isSyncing = false;
          await primeTournamentForMatch(tid);
          const retryToken = await ensureScoringToken(tid);
          headers = buildAuthHeaders(retryToken);
          r = await fetchCloud(
            backendUrl + endpoint,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(syncPayload),
            },
            1
          );
          if (r.ok) {
            finish();
            return;
          }
        }
        const pw = getCloudScoringPassword(tid);
        if (pw && !data._authRetried) {
          const newToken = await requestTournamentScoringToken(tid, pw);
          if (newToken) {
            finish();
            data._isSyncing = false;
            data._authRetried = true;
            return syncToDB(type, data);
          }
        }
        console.warn(
          '[Sync] 401 Unauthorized — open tournament in Score Match, re-enter scoring password, Publish ON, then sync again.'
        );
        finish();
        return;
      }

      if (!r.ok) {
        if (type === 'match' && r.status >= 500 && !data._lightRetry) {
          data._lightRetry = true;
          try {
            const lightPayload = stripMatchInlineMedia(syncPayload);
            r = await fetchCloud(
              backendUrl + endpoint,
              {
                method: 'POST',
                headers,
                body: JSON.stringify(lightPayload),
                timeoutMs: 12000,
              },
              0
            );
            if (r.ok) {
              finish();
              return;
            }
          } catch (_) {}
          _pushPauseUntil = Date.now() + (background ? 45000 : 12000);
        }
        let detail = '';
        try {
          const errBody = await r.json();
          detail = errBody?.details || errBody?.error || '';
        } catch (_) {}
        if (r.status >= 400) {
          console.warn(`[Sync] ${type} push ${r.status}${detail ? ': ' + detail : ''}`);
        }
      }
    } catch (err) {
      markCloudTimeoutBackoff(err, {
        silent: background || !!data._fastPush || global.SLCRICK_DESKTOP,
      });
      if (isTimeoutLike(err)) {
        _serverAwake = false;
        _pushPauseUntil = Date.now() + (background ? 60000 : 25000);
        if (global.SLCRICK_DESKTOP) _desktopFlushIntervalMs = 45000;
      }
      if (!background && !data._fastPush && !global.SLCRICK_DESKTOP) {
        warnPushThrottled(type || 'unknown', err);
      }
    } finally {
      finish();
    }
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

  function verifyLocalPassword(id, password) {
    const pwd = String(password || '').trim();
    if (!id || !pwd) return { ok: false, error: 'Password required' };
    if (!global.DB) return { ok: false, error: 'DB not ready' };

    const stored = localStorage.getItem(`tourn_pw_${id}`);
    if (stored && String(stored).trim() === pwd) {
      return { ok: true, offline: true, source: 'stored' };
    }

    const type = String(id).startsWith('MATCH') ? 'match' : 'tournament';
    const obj = type === 'match' ? global.DB.getMatch(id) : global.DB.getTournament(id);
    if (!obj) return { ok: false, error: 'Not found' };

    const localPw = obj.scoringPassword || obj.password;
    if (localPw && String(localPw).trim() === pwd) {
      return { ok: true, offline: true, source: 'local' };
    }

    if (type === 'tournament' && global.SLCRICK_DESKTOP) {
      const tid = obj.id;
      const tpw = localStorage.getItem(`tourn_pw_${tid}`);
      if (tpw && String(tpw).trim() === pwd) {
        return { ok: true, offline: true, source: 'stored-tournament' };
      }
      if (!localPw && (obj.isLocked || tournamentHasPasswordFlag(obj))) {
        if (pwd === 'offline') {
          return { ok: true, offline: true, source: 'desktop-offline-default' };
        }
      }
    }

    if (!localPw && !obj.isLocked && !(obj.scoringPassword || obj.password)) {
      return { ok: true, offline: true, source: 'open' };
    }

    return { ok: false, error: 'Wrong password' };
  }

  function tournamentHasPasswordFlag(obj) {
    return !!(obj && (obj.scoringPassword || obj.password || obj.isLocked));
  }

  function grantLocalAccess(id, password, tournamentIdForToken) {
    const pwd = String(password || '').trim();
    const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
    grants[id] = true;
    localStorage.setItem('cricpro_grants', JSON.stringify(grants));
    const tid =
      tournamentIdForToken ||
      (String(id).startsWith('MATCH') ? global.DB?.getMatch?.(id)?.tournamentId : id);
    if (tid && pwd) localStorage.setItem(`tourn_pw_${tid}`, pwd);
  }

  async function handshake(id, password) {
    const pwd = String(password || '').trim();
    if (!id || !pwd) return { ok: false, error: 'Password required' };

    const local = verifyLocalPassword(id, pwd);
    if (local.ok) {
      const tid = String(id).startsWith('MATCH')
        ? global.DB?.getMatch?.(id)?.tournamentId
        : id;
      grantLocalAccess(id, pwd, tid || null);
      if (isEnabled() && tid && pwd !== 'offline') {
        requestTournamentScoringToken(tid, pwd).catch(() => {});
      } else if (isEnabled() && tid) {
        requestTournamentScoringToken(tid, 'slcrick-sync').catch(() => {});
      }
      return { ok: true, offline: true, source: local.source };
    }

    if (!isEnabled()) {
      return { ok: false, error: local.error || 'Wrong password' };
    }
    if (_handshakeRetryAfter > Date.now()) {
      return { ok: false, error: local.error || 'Cloud handshake temporarily unavailable' };
    }

    const url = getBackendUrl();
    const type = String(id).startsWith('MATCH') ? 'match' : 'tournament';
    try {
      const r = await postHandshake(url, { id, type, password: pwd });
      let d = {};
      try {
        d = await r.json();
      } catch (_) {
        d = {};
      }
      if (r.ok && d.ok) {
        if (d.token) {
          storeScoringToken(
            type === 'tournament' ? id : global.DB?.getMatch?.(id)?.tournamentId,
            d.token,
            d.expiresInMs
          );
          localStorage.setItem('cricpro_token', d.token);
          if (d.expiresInMs) {
            localStorage.setItem('cricpro_token_expiry', String(Date.now() + d.expiresInMs));
          }
        }
        grantLocalAccess(id, pwd, type === 'tournament' ? id : global.DB?.getMatch?.(id)?.tournamentId);
        return { ok: true, token: d.token, expiresInMs: d.expiresInMs };
      }
      return {
        ok: false,
        error: d?.error || local.error || 'Access denied',
        httpStatus: r.status,
      };
    } catch (e) {
      if (e?.code === 'HANDSHAKE_ENDPOINT_MISSING') {
        _handshakeRetryAfter = Date.now() + 10 * 60 * 1000;
        return { ok: false, error: local.error || 'Cloud handshake temporarily unavailable' };
      }
      if (local.error === 'Wrong password') {
        return { ok: false, error: 'Connection failed — check internet or use the password from when you created this tournament' };
      }
      return { ok: false, error: 'Connection failed' };
    }
  }

  /**
   * Backward-compatible handshake: some deployments expose /handshake (legacy),
   * others expose /api/handshake or /sync/handshake. Try all and remember which works.
   */
  async function postHandshake(baseUrl, payload) {
    if (_handshakeRetryAfter > Date.now()) {
      const cooldownErr = new Error('Handshake endpoint cooldown active');
      cooldownErr.code = 'HANDSHAKE_ENDPOINT_MISSING';
      throw cooldownErr;
    }

    const paths = handshakePathsForBackend(baseUrl);
    const headers = buildAuthHeaders(null);
    let lastError = null;
    let sawOnly404 = true;

    await wakeUpServer(1);

    for (const path of paths) {
      try {
        const r = await fetchWithTimeout(
          `${baseUrl}${path}`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          },
          22000
        );

        if (r.status === 404) {
          lastError = new Error(`HTTP 404 on ${path}`);
          continue;
        }
        sawOnly404 = false;
        if (r.ok || r.status === 401 || r.status === 403) {
          rememberHandshakePath(path);
          _serverAwake = true;
          clearCloudTimeoutBackoff();
          return r;
        }
        lastError = new Error(`HTTP ${r.status} on ${path}`);
      } catch (e) {
        lastError = e;
        sawOnly404 = false;
      }
    }

    if (sawOnly404) {
      _handshakeRetryAfter = Date.now() + 10 * 60 * 1000;
      const err = new Error('Handshake endpoint not found on server');
      err.code = 'HANDSHAKE_ENDPOINT_MISSING';
      throw err;
    }

    throw lastError || new Error('Handshake failed');
  }

  function install() {
    bootstrapDesktopAutoSync();
    if (isLocalhostOnlyMode()) {
      applyLocalhostOnlyDefaults();
    }

    const url = getBackendUrl();
    if (url) {
      global.BACKEND_BASE_URL = url;
      window.BACKEND_BASE_URL = url;
      if (isPrimaryRenderBackend(url)) {
        _handshakePathHint = '/api/handshake';
        try {
          localStorage.setItem(HANDSHAKE_HINT_KEY, '/api/handshake');
        } catch (_) {}
      }
    }

    if (global.DB) {
      global.DB.getCloudURL = () => getBackendUrl() || global.BACKEND_BASE_URL || '';
      global.DB.handshake = handshake;
      if (!localStorage.getItem('cricpro_storage_migrated_v2')) {
        try {
          global.DB.saveMatches(global.DB.getMatches());
          localStorage.setItem('cricpro_storage_migrated_v2', '1');
        } catch (_) {}
      }
    }

    if (isEnabled()) {
      global.syncToDB = syncToDB;
      global.syncCloudData = syncCloudData;
      global.pullGlobalData = pullGlobalData;
      global.wakeUpServer = wakeUpServer;
      global.SLCRICK_REALTIME?.install?.({ force: !!global.SLCRICK_DESKTOP });
      if (!global._slcrickSyncBooted) {
        global._slcrickSyncBooted = true;
        wakeUpServer().then(async (ok) => {
          if (ok) {
            await syncCloudData({ silent: true });
            await authenticateAllTournaments();
          }
        });
      }
      startBackgroundSyncLoops();
    } else {
      global._isGlobalSyncCompleted = true;
      applyLocalhostOnlyDefaults();
    }
    if (global.SLCRICK_DESKTOP && global.desktopAPI?.notifySyncSettings) {
      global.desktopAPI.notifySyncSettings({ enabled: isEnabled() });
    }
    global.SLCRICK_BROADCAST?.emitStatus?.();
  }

  function startBackgroundSyncLoops() {
    if (!global._slcrickSyncInterval) {
      global._slcrickSyncInterval = setInterval(() => {
        if (!isEnabled()) return;
        if (isCloudTimeoutBackoffActive()) return;
        syncCloudData({ silent: true });
      }, 45000);
    }
    if (global.SLCRICK_DESKTOP && !global._slcrickFlushInterval) {
      const runDesktopFlush = () => {
        if (!isEnabled()) return;
        if (isCloudTimeoutBackoffActive() || shouldPausePushes()) return;
        flushQueue().catch(() => {});
      };
      global._slcrickFlushInterval = setInterval(runDesktopFlush, _desktopFlushIntervalMs);
    }
  }

  function bootstrapDesktopAutoSync() {
    if (!global.SLCRICK_DESKTOP) return;

    if (!localStorage.getItem('cricpro_desktop_offline_migrated_v2')) {
      localStorage.setItem('cricpro_desktop_offline_migrated_v2', '1');
    }

    if (!localStorage.getItem(LOCALHOST_ONLY_KEY)) {
      localStorage.setItem(LOCALHOST_ONLY_KEY, '1');
      if (!hasCloudOptIn()) {
        saveSettings({
          enabled: false,
          userDisabled: true,
          backendUrl: '',
        });
      }
    }

    if (!hasCloudOptIn() || isUserSyncDisabled()) {
      applyLocalhostOnlyDefaults();
      return;
    }

    if (!isNetworkOnline()) return;

    const stored = loadStoredSettings();
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg.enabled === true && cfg.userDisabled !== true) {
          global.desktopAPI?.notifySyncSettings?.({ enabled: true });
          return;
        }
      }
    } catch (_) {}

    saveSettings({
      enabled: true,
      userDisabled: false,
      backendUrl: stored.backendUrl || DEFAULT_BACKEND,
    });
    global.desktopAPI?.notifySyncSettings?.({ enabled: true });
  }

  function wireDesktopAutoSync() {
    if (!global.SLCRICK_DESKTOP || global._slcrickAutoSyncWired) return;
    global._slcrickAutoSyncWired = true;

    global.addEventListener('online', () => {
      if (isUserSyncDisabled() || !isEnabled()) return;
      install();
      global.SLCRICK_REALTIME?.install?.({ force: true });
      flushQueue().catch(() => {});
    });

    global.addEventListener('offline', () => {
      install();
      global.SLCRICK_REALTIME?.disconnect?.();
    });
  }

  let _flushRunning = false;
  let _desktopFlushIntervalMs = 15000;

  async function flushQueue() {
    if (_flushRunning || !global.DB || !isEnabled()) return;
    if (isCloudTimeoutBackoffActive() || shouldPausePushes()) return;
    if (!isNetworkOnline()) return;
    _flushRunning = true;
    try {
      if (isCloudTimeoutBackoffActive()) return;
      await authenticateAllTournaments();

      const liveMatches = global.DB.getMatches()
        .filter(
          (m) =>
            m &&
            m.id &&
            m.publishLive !== false &&
            (m.status === 'live' || m.status === 'paused')
        )
        .sort(
          (a, b) =>
            (b.lastUpdated || b.scoringStartedAt || 0) - (a.lastUpdated || a.scoringStartedAt || 0)
        )
        .slice(0, 2);

      const tid = liveMatches[0]?.tournamentId;
      if (tid) {
        const t = global.DB.getTournament(tid);
        if (t) {
          const tPayload = tournamentPayloadForCloud(t) || t;
          await syncToDB('tournament', { ...tPayload, _isBackgroundSync: true });
          await new Promise((r) => setTimeout(r, 350));
        }
      }

      for (const m of liveMatches) {
        await syncToDB('match', { ...m, _isBackgroundSync: true });
        await new Promise((r) => setTimeout(r, 350));
      }
    } finally {
      _flushRunning = false;
    }
  }

  async function prefetchCloudToken(tournamentId, password) {
    if (!tournamentId || !isEnabled()) return null;
    const pw = String(password || '').trim();
    if (pw && pw !== 'offline') return requestTournamentScoringToken(tournamentId, pw);
    return requestTournamentScoringToken(tournamentId, 'slcrick-sync');
  }

  global.SLCRICK_SYNC = {
    VERSION: SYNC_CLIENT_VERSION,
    DEFAULT_BACKEND,
    loadSettings,
    prefetchCloudToken,
    loadStoredSettings,
    saveSettings,
    isEnabled,
    isLocalhostOnlyMode,
    hasCloudOptIn,
    applyLocalhostOnlyDefaults,
    isUserSyncDisabled,
    isNetworkOnline,
    getBackendUrl,
    install,
    syncToDB,
    syncCloudData,
    pullGlobalData,
    handshake,
    verifyLocalPassword,
    wakeUpServer,
    flushQueue,
    pushLiveMatchNow,
    ensureScoringToken,
    authenticateAllTournaments,
    storeScoringToken,
  };

  if (global.DB && !global._slcrickSyncClientBooted) {
    global._slcrickSyncClientBooted = true;
    wireDesktopAutoSync();
    install();
  }
})(typeof window !== 'undefined' ? window : global);
