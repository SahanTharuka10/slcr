/**
 * SLCRICKPRO — Local-first cloud sync (slcrickpro.live / Render API)
 * Load after js/db.js
 */
(function (global) {
  const DEFAULT_BACKEND = 'https://slcrickpro.onrender.com';
  const SETTINGS_KEY = 'cricpro_sync_settings';
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
  const SYNC_DEBOUNCE_MS = 2000;

  function isLocalHost() {
    const h = global.location?.hostname || '';
    return h === 'localhost' || h === '127.0.0.1';
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

    if (global.SLCRICK_DESKTOP) {
      let enabled = false;
      if (localStorage.getItem(SETTINGS_KEY)) {
        try {
          const cfg = JSON.parse(localStorage.getItem(SETTINGS_KEY));
          enabled = cfg.enabled === true && cfg.userDisabled !== true;
        } catch (_) {}
      } else if (localStorage.getItem('cricpro_sync_enabled') === 'true') {
        enabled = true;
      }
      enabled = enabled && isNetworkOnline();
      return { ...stored, enabled, backendUrl };
    }

    let enabled = !!stored.enabled;
    if (!isLocalHost() && !localStorage.getItem(SETTINGS_KEY) && !stored.enabled) {
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
      if (global.SLCRICK_DESKTOP) global.BACKEND_BASE_URL = '';
      global.SLCRICK_REALTIME?.disconnect?.();
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
    const t = global.DB?.getTournament?.(tournamentId);
    if (!t) return null;
    try {
      const payload = stripHeavyFields(JSON.parse(JSON.stringify({ ...t, scoringPassword: password })));
      const r = await fetch(`${url}/sync/tournament`, {
        method: 'POST',
        headers: buildAuthHeaders(null),
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.token) {
        storeScoringToken(tournamentId, d.token, d.expiresInMs);
        return d.token;
      }
    } catch (e) {
      console.warn('[Sync] tournament push for token failed', e.message || e);
    }
    return null;
  }

  async function requestTournamentScoringToken(tournamentId, password) {
    const url = getBackendUrl();
    const pw = String(password || '').trim();
    if (!url || !tournamentId || !pw || pw === 'offline') return null;
    if (_handshakeFailedPw.get(tournamentId) === pw) return null;

    const fromSync = await pushTournamentForScoringToken(tournamentId, pw);
    if (fromSync) return fromSync;

    try {
      const r = await fetch(`${url}/api/handshake`, {
        method: 'POST',
        headers: buildAuthHeaders(null),
        body: JSON.stringify({ id: tournamentId, type: 'tournament', password: pw }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && d.token) {
        _handshakeFailedPw.delete(tournamentId);
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
      }
    } catch (e) {
      console.warn('[Sync] handshake failed', e.message || e);
    }
    return null;
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
    if (!global.DB || !isEnabled()) return;
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
      if (ok) _serverAwake = true;
      return ok;
    }
    if (_wakePromise) return _wakePromise;
    _wakePromise = (async () => {
      try {
        const r = await fetch(`${url}/sync/matches`, {
          method: 'GET',
          cache: 'no-store',
          mode: 'cors',
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok || r.status === 401 || r.status === 403) {
          _serverAwake = true;
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

    if (!_serverAwake && !options.forceRefresh && !global.SLCRICK_REALTIME?.socket?.connected) {
      wakeUpServer(1).catch(() => {});
    }

    _isSyncingCloud = true;
    try {
      const [mReq, tReq] = await Promise.all([
        fetch(`${backendUrl}/sync/matches`, { signal: AbortSignal.timeout(30000) }).catch(() => ({ ok: false })),
        fetch(`${backendUrl}/sync/tournaments`, { signal: AbortSignal.timeout(30000) }).catch(() => ({ ok: false })),
      ]);

      if (!mReq.ok && !tReq.ok) {
        const cfg = loadSettings();
        if (mReq.status === 401 || mReq.status === 403) {
          cfg.lastSyncError =
            'Cloud sync needs tournament scoring password — open match in Score Match and unlock';
        } else {
          cfg.lastSyncError = 'Server unreachable';
        }
        saveSettings(cfg);
        return { ok: false, error: 'fetch_failed', status: mReq.status || 0 };
      }

      if (mReq.status === 401 || mReq.status === 403) {
        const cfg = loadSettings();
        cfg.lastSyncError =
          'Cloud sync unauthorized — re-enter tournament password in Score Match';
        saveSettings(cfg);
        global._isGlobalSyncCompleted = true;
        return { ok: false, error: 'auth_failed', status: mReq.status };
      }

      if (mReq.ok) {
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

  async function syncToDB(type, data) {
    const backendUrl = getBackendUrl();
    if (!backendUrl || !data) return;

    const background = !!data._isBackgroundSync;
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
      let r = await fetch(backendUrl + endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(syncPayload),
      });

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
          r = await fetch(backendUrl + endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(syncPayload),
          });
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
      console.warn('[Sync] push failed', err);
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

    const url = getBackendUrl();
    const type = String(id).startsWith('MATCH') ? 'match' : 'tournament';
    try {
      const r = await fetch(`${url}/api/handshake`, {
        method: 'POST',
        headers: buildAuthHeaders(null),
        body: JSON.stringify({ id, type, password: pwd }),
      });
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
      if (local.error === 'Wrong password') {
        return { ok: false, error: 'Connection failed — check internet or use the password from when you created this tournament' };
      }
      return { ok: false, error: 'Connection failed' };
    }
  }

  function install() {
    bootstrapDesktopAutoSync();

    const url = getBackendUrl();
    if (url) {
      global.BACKEND_BASE_URL = url;
      window.BACKEND_BASE_URL = url;
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
      if (global.SLCRICK_DESKTOP) {
        global.syncToDB = function () {};
        global.BACKEND_BASE_URL = '';
      }
      global.SLCRICK_REALTIME?.disconnect?.();
      global.SLCRICK_LIVE?.disconnect?.();
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
        syncCloudData({ silent: true });
      }, 45000);
    }
    if (global.SLCRICK_DESKTOP && !global._slcrickFlushInterval) {
      global._slcrickFlushInterval = setInterval(() => {
        if (!isEnabled()) return;
        flushQueue().catch(() => {});
      }, 5000);
    }
  }

  function bootstrapDesktopAutoSync() {
    if (!global.SLCRICK_DESKTOP) return;

    if (!localStorage.getItem('cricpro_desktop_offline_migrated_v2')) {
      localStorage.setItem('cricpro_desktop_offline_migrated_v2', '1');
      if (!localStorage.getItem('cricpro_sync_user_opted_in')) {
        const stored = loadStoredSettings();
        saveSettings({
          enabled: false,
          backendUrl: stored.backendUrl || DEFAULT_BACKEND,
          userDisabled: true,
        });
        global.desktopAPI?.notifySyncSettings?.({ enabled: false });
        return;
      }
    }

    const stored = loadStoredSettings();
    const hasSettings = !!localStorage.getItem(SETTINGS_KEY);
    const legacyOn = localStorage.getItem('cricpro_sync_enabled') === 'true';

    if (!hasSettings && !legacyOn) {
      saveSettings({
        enabled: false,
        backendUrl: stored.backendUrl || DEFAULT_BACKEND,
        userDisabled: true,
      });
      global.desktopAPI?.notifySyncSettings?.({ enabled: false });
      return;
    }

    if (isUserSyncDisabled()) {
      global.desktopAPI?.notifySyncSettings?.({ enabled: false });
      return;
    }

    if (!isNetworkOnline()) return;

    if (hasSettings || legacyOn) {
      saveSettings({
        enabled: true,
        backendUrl: stored.backendUrl || DEFAULT_BACKEND,
        userDisabled: false,
      });
      global.desktopAPI?.notifySyncSettings?.({ enabled: true });
    }
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

  async function flushQueue() {
    if (_flushRunning || !global.DB || !isEnabled()) return;
    _flushRunning = true;
    try {
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
    DEFAULT_BACKEND,
    loadSettings,
    prefetchCloudToken,
    loadStoredSettings,
    saveSettings,
    isEnabled,
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
