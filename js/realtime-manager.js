/**
 * SLCRICKPRO — Single shared realtime service (Socket.IO + controlled REST fallback)
 * Load after: db.js, sync-client.js (optional). Requires socket.io client on page.
 */
(function (global) {
  const DEFAULT_API = 'https://slcrickpro.onrender.com';
  const LOG_PREFIX = '[Realtime]';

  /** @typedef {'off'|'waking'|'connecting'|'connected'|'reconnecting'|'degraded'} ConnectionState */

  const Events = Object.freeze({
    STATE: 'state',
    LOG: 'log',
    SCORE_UPDATE: 'scoreUpdate',
    GLOBAL_UPDATE: 'globalUpdate',
    TOURNAMENT_UPDATE: 'tournamentUpdate',
  });

  let _socket = null;
  let _state = 'off';
  let _wakePromise = null;
  let _lastWakeAt = 0;
  let _connectGen = 0;
  let _joinedMatch = null;
  let _joinedTournament = null;
  let _emitQueue = [];
  let _restFallbackTimer = null;
  let _wired = false;
  let _reconnectAttempt = 0;
  let _lastError = null;
  let _connectPromise = null;
  let _ioMissingLogged = false;

  const listeners = new Map();
  Object.values(Events).forEach((e) => listeners.set(e, new Set()));

  const WAKE_COOLDOWN_MS = 45000;
  const REST_FALLBACK_MS = 10000;
  const WEBSITE_SAFETY_POLL_MS = 8000;
  const WAKE_PATH = '/sync/matches';

  function on(event, fn) {
    listeners.get(event)?.add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    listeners.get(event)?.delete(fn);
  }

  function emit(event, detail) {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(detail);
      } catch (e) {
        console.warn(LOG_PREFIX, 'listener error', e);
      }
    });
    if (event === Events.STATE) {
      global.dispatchEvent?.(new CustomEvent('slcrick-realtime-state', { detail }));
      global.SLCRICK_BROADCAST?.emitStatus?.();
    }
  }

  function log(level, message, extra) {
    const line = `${LOG_PREFIX} ${message}`;
    if (level === 'error') console.error(line, extra || '');
    else if (level === 'warn') console.warn(line, extra || '');
    else console.log(line, extra || '');
    emit(Events.LOG, { level, message, extra, ts: Date.now() });
  }

  function isSyncEnabled() {
    if (global.SLCRICK_SYNC?.isEnabled?.()) return true;
    if (!global.SLCRICK_DESKTOP && (global.BACKEND_BASE_URL || global.CRICPRO_CLOUD_CONFIG?.backendUrl)) {
      return true;
    }
    return !!(global.BACKEND_BASE_URL || global.CRICPRO_CLOUD_CONFIG?.backendUrl);
  }

  function resolveBackendUrl() {
    const cfg = global.CRICPRO_CLOUD_CONFIG?.backendUrl;
    if (cfg && String(cfg).trim()) return String(cfg).trim().replace(/\/$/, '');
    if (global.SLCRICK_SYNC?.getBackendUrl) {
      const u = global.SLCRICK_SYNC.getBackendUrl();
      if (u) return u.replace(/\/$/, '');
    }
    if (global.BACKEND_BASE_URL) return String(global.BACKEND_BASE_URL).replace(/\/$/, '');
    return DEFAULT_API;
  }

  function getStatus() {
    return {
      state: _state,
      reconnectAttempt: _reconnectAttempt,
      lastError: _lastError,
      backendUrl: isSyncEnabled() ? resolveBackendUrl() : '',
      socketConnected: !!(_socket && _socket.connected),
      queueLength: _emitQueue.length,
      joinedMatch: _joinedMatch,
      joinedTournament: _joinedTournament,
    };
  }

  function setState(next, meta) {
    if (_state === next && !meta?.force) return;
    _state = next;
    emit(Events.STATE, { ...getStatus(), ...meta });
  }

  function mapSocketState() {
    if (!isSyncEnabled()) return 'off';
    if (_socket?.connected) return 'connected';
    if (_state === 'reconnecting' || _state === 'connecting' || _state === 'waking') return 'connecting';
    if (_state === 'degraded') return 'connecting';
    return 'off';
  }

  /**
   * Render cold-start wake — NOT used when socket is connected.
   * Avoids /api/ping (ad-blocker magnet). Desktop uses main-process net when available.
   */
  async function wakeApi(options = {}) {
    if (!isSyncEnabled()) return false;
    const url = resolveBackendUrl();
    if (!url || url.includes('127.0.0.1') || url.includes('localhost')) return false;

    const force = !!options.force;
    const now = Date.now();
    if (!force && _lastWakeAt && now - _lastWakeAt < WAKE_COOLDOWN_MS) return true;
    if (_wakePromise) return _wakePromise;

    setState('waking', { reason: options.reason || 'wake' });
    log('info', `Waking API ${url}`);

    _wakePromise = (async () => {
      if (global.desktopAPI?.wakeBackend) {
        try {
          const ok = await global.desktopAPI.wakeBackend(url);
          if (ok) {
            _lastWakeAt = Date.now();
            log('info', 'API awake (desktop bridge)');
            return true;
          }
        } catch (_) {}
      }

      const maxAttempts = force ? 3 : 2;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const r = await fetch(`${url}${WAKE_PATH}`, {
            method: 'GET',
            cache: 'no-store',
            mode: 'cors',
            signal: AbortSignal.timeout(15000),
          });
          if (r.ok || r.status === 401 || r.status === 403) {
            _lastWakeAt = Date.now();
            log('info', 'API awake (REST)');
            return true;
          }
        } catch (e) {
          _lastError = e?.message || 'wake_failed';
        }
        if (i < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        }
      }
      log('warn', 'API wake failed — will retry on reconnect');
      return false;
    })();

    try {
      return await _wakePromise;
    } finally {
      _wakePromise = null;
    }
  }

  function stopRestFallback() {
    if (_restFallbackTimer) {
      clearInterval(_restFallbackTimer);
      _restFallbackTimer = null;
    }
  }

  function startRestFallback() {
    if (_restFallbackTimer || _socket?.connected) return;
    log('info', 'REST fallback polling (socket down)');
    _restFallbackTimer = setInterval(() => {
      if (_socket?.connected) {
        stopRestFallback();
        return;
      }
      if (!isSyncEnabled()) return;
      if (global.SLCRICK_SYNC?.syncCloudData) {
        global.SLCRICK_SYNC.syncCloudData({ silent: true, forceRefresh: true });
      } else if (typeof global.syncCloudData === 'function') {
        global.syncCloudData({ silent: true, forceRefresh: true });
      }
    }, REST_FALLBACK_MS);
  }

  function flushEmitQueue() {
    if (!_socket?.connected || !_emitQueue.length) return;
    const batch = _emitQueue.splice(0, _emitQueue.length);
    batch.forEach(({ event, payload }) => {
      try {
        _socket.emit(event, payload);
      } catch (e) {
        log('warn', `emit failed: ${event}`, e);
      }
    });
  }

  function queueEmit(event, payload) {
    _emitQueue.push({ event, payload });
    if (_emitQueue.length > 200) _emitQueue.shift();
  }

  function safeEmit(event, payload) {
    if (_socket?.connected) _socket.emit(event, payload);
    else queueEmit(event, payload);
  }

  function rejoinRooms() {
    if (!_socket?.connected) return;
    _socket.emit('join_global', {});
    if (_joinedMatch) _socket.emit('join_match', _joinedMatch);
    if (_joinedTournament) _socket.emit('join_tournament', _joinedTournament);
    flushEmitQueue();
  }

  function destroySocket() {
    if (!_socket) return;
    const s = _socket;
    _socket = null;
    global._cricproSocket = null;
    global.socket = null;
    _wired = false;
    try {
      s.removeAllListeners();
      s.io?.removeAllListeners?.();
      s.disconnect();
      s.close();
    } catch (_) {}
  }

  function wireSocketHandlers(sock) {
    if (!sock || _wired) return;
    _wired = true;

    sock.on('connect', () => {
      _reconnectAttempt = 0;
      _lastError = null;
      setState('connected', { force: true });
      log('info', 'Socket connected');
      rejoinRooms();
      stopRestFallback();
    });

    sock.on('disconnect', (reason) => {
      setState('reconnecting', { reason });
      log('warn', `Socket disconnected (${reason})`);
      startRestFallback();
    });

    sock.on('connect_error', (err) => {
      _lastError = err?.message || 'connect_error';
      _reconnectAttempt += 1;
      setState('reconnecting', { error: _lastError });
      log('warn', `connect_error (attempt ${_reconnectAttempt})`, _lastError);
    });

    sock.io?.on('reconnect_attempt', (attempt) => {
      _reconnectAttempt = attempt;
      setState('reconnecting', { attempt });
      log('info', `reconnect attempt ${attempt}`);
    });

    sock.io?.on('reconnect', () => {
      log('info', 'Socket reconnected');
      rejoinRooms();
    });

    sock.on('scoreUpdate', (data) => {
      emit(Events.SCORE_UPDATE, data);
      if (global.SLCRICK_LIVE?.applyScoreUpdate) global.SLCRICK_LIVE.applyScoreUpdate(data);
    });

    sock.on('match-update', (payload) => {
      const data = payload?.match || payload?.data || payload;
      if (data?.id) {
        emit(Events.SCORE_UPDATE, data);
        if (global.SLCRICK_LIVE?.applyScoreUpdate) global.SLCRICK_LIVE.applyScoreUpdate(data);
      }
    });

    sock.on('globalUpdate', () => {
      emit(Events.GLOBAL_UPDATE, {});
      if (global.SLCRICK_SYNC?.syncCloudData) {
        global.SLCRICK_SYNC.syncCloudData({ silent: true, forceRefresh: true });
      } else if (typeof global.syncCloudData === 'function') {
        global.syncCloudData({ silent: true, forceRefresh: true });
      }
    });

    sock.on('tournamentUpdate', () => {
      emit(Events.TOURNAMENT_UPDATE, {});
      global.SLCRICK_BROADCAST_STATION?.refresh?.();
    });
  }

  async function ensureSocketIo() {
    if (typeof global.io !== 'undefined') return true;
    if (global.SLCRICK_SOCKET_LOADER?.load) {
      try {
        await global.SLCRICK_SOCKET_LOADER.load();
        return typeof global.io !== 'undefined';
      } catch (e) {
        _lastError = e.message;
        return false;
      }
    }
    return false;
  }

  function connect(options = {}) {
    if (!isSyncEnabled()) {
      disconnect();
      return Promise.resolve(null);
    }

    if (_socket?.connected) {
      wireSocketHandlers(_socket);
      return Promise.resolve(_socket);
    }

    if (_connectPromise) return _connectPromise;

    const gen = ++_connectGen;
    setState('connecting');

    _connectPromise = (async () => {
      const hasIo = await ensureSocketIo();
      if (!hasIo) {
        if (!_ioMissingLogged) {
          _ioMissingLogged = true;
          log('warn', 'socket.io not available — load js/socket-loader.js or CDN script first');
        }
        setState('degraded', { reason: 'no_socket_io' });
        return null;
      }
      _ioMissingLogged = false;

      const url = resolveBackendUrl();
      if (!url) return null;

      if (gen !== _connectGen) return null;

      if (!_socket?.connected) {
        const awake = await wakeApi({ force: options.force, reason: 'pre-connect' });
        if (!awake) setState('degraded');
      }
      if (gen !== _connectGen) return null;
      if (_socket?.connected) return _socket;

      destroySocket();

      _socket = global.io(url, {
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        randomizationFactor: 0.4,
        timeout: 20000,
      });

      global._cricproSocket = _socket;
      global.socket = _socket;
      wireSocketHandlers(_socket);
      return _socket;
    })().finally(() => {
      _connectPromise = null;
    });

    return _connectPromise;
  }

  function disconnect() {
    _connectGen += 1;
    stopRestFallback();
    destroySocket();
    _emitQueue = [];
    _joinedMatch = null;
    _joinedTournament = null;
    setState('off', { force: true });
    log('info', 'Realtime disconnected');
  }

  let _websiteSafetyTimer = null;

  function startWebsiteSafetyPoll() {
    if (global.SLCRICK_DESKTOP || _websiteSafetyTimer) return;
    _websiteSafetyTimer = setInterval(() => {
      if (!isSyncEnabled()) return;
      if (global.SLCRICK_SYNC?.syncCloudData) {
        global.SLCRICK_SYNC.syncCloudData({ silent: true, forceRefresh: true }).catch(() => {});
      }
    }, WEBSITE_SAFETY_POLL_MS);
  }

  function install(options = {}) {
    if (!options.force && !isSyncEnabled()) {
      disconnect();
      return Promise.resolve(null);
    }
    if (_socket?.connected && !options.force) {
      startWebsiteSafetyPoll();
      return Promise.resolve(_socket);
    }
    return connect(options).then((s) => {
      startWebsiteSafetyPoll();
      return s;
    });
  }

  function joinMatch(matchId) {
    _joinedMatch = matchId || null;
    if (matchId) safeEmit('join_match', matchId);
  }

  function joinTournament(tournamentId) {
    _joinedTournament = tournamentId || null;
    if (tournamentId) safeEmit('join_tournament', tournamentId);
  }

  global.SLCRICK_REALTIME = {
    Events,
    on,
    off,
    getStatus,
    getState: () => _state,
    mapSocketState,
    resolveBackendUrl,
    isSyncEnabled,
    wakeApi,
    connect,
    disconnect,
    install,
    joinMatch,
    joinTournament,
    get socket() {
      return _socket;
    },
  };

  global.addEventListener?.('online', () => {
    if (isSyncEnabled() && !_socket?.connected) {
      log('info', 'Browser online — reconnecting');
      install({ force: true });
    }
  });

  global.addEventListener?.('offline', () => {
    setState('degraded', { reason: 'browser_offline' });
    log('warn', 'Browser offline');
  });
})(typeof window !== 'undefined' ? window : global);
