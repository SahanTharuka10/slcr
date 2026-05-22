/**
 * SLCRICKPRO — Real-time mirror (Socket.IO) for desktop + broadcast station.
 * Requires: db.js, sync-client.js (optional), socket.io client script on page.
 */
(function (global) {
  const PUBLIC_SITE = 'https://slcrickpro.live';
  let _socket = null;
  let _joinedMatch = null;
  let _joinedTournament = null;

  function backendUrl() {
    if (global.SLCRICK_SYNC?.getBackendUrl?.()) return global.SLCRICK_SYNC.getBackendUrl();
    return global.BACKEND_BASE_URL || PUBLIC_SITE.replace(/\/$/, '') || '';
  }

  function siteOrigin() {
    const u = backendUrl();
    if (!u) return PUBLIC_SITE;
    try {
      return new URL(u).origin;
    } catch (_) {
      return PUBLIC_SITE;
    }
  }

  function applyScoreUpdate(data) {
    if (!data?.id || !global.DB) return;
    const list = global.DB.getMatches();
    const idx = list.findIndex((m) => m.id === data.id);
    const local = idx >= 0 ? list[idx] : null;
    const cloudTs = data.lastUpdated || 0;
    const localTs = local?.lastUpdated || 0;
    if (local && localTs > cloudTs) return;
    if (idx >= 0) list[idx] = data;
    else list.push(data);
    global._desktopApplyingRemoteMatch = true;
    try {
      global.DB.saveMatches(list);
    } finally {
      global._desktopApplyingRemoteMatch = false;
    }
    global.dispatchEvent?.(new CustomEvent('slcrick-live-update', { detail: { type: 'match', id: data.id } }));
    emitLinkStatus();
    if (typeof global.SLCRICK_BROADCAST_STATION?.refresh === 'function') {
      global.SLCRICK_BROADCAST_STATION.refresh();
    }
  }

  function wireSocket(sock) {
    if (!sock || sock._slcrickLiveWired) return sock;
    sock._slcrickLiveWired = true;
    sock.on('scoreUpdate', (data) => applyScoreUpdate(data));
    sock.on('globalUpdate', () => {
      if (typeof global.syncCloudData === 'function') {
        global.syncCloudData({ silent: true, forceRefresh: true });
      } else if (global.SLCRICK_SYNC?.syncCloudData) {
        global.SLCRICK_SYNC.syncCloudData({ silent: true, forceRefresh: true });
      }
    });
    sock.on('tournamentUpdate', () => {
      global.SLCRICK_BROADCAST_STATION?.refresh?.();
    });
    return sock;
  }

  function emitLinkStatus() {
    global.SLCRICK_BROADCAST?.emitStatus?.();
  }

  function disconnect() {
    const sock = _socket || global._cricproSocket;
    if (sock) {
      try {
        sock.removeAllListeners();
        sock.disconnect();
      } catch (_) {}
    }
    _socket = null;
    global._cricproSocket = null;
    global.socket = null;
    _joinedMatch = null;
    _joinedTournament = null;
    emitLinkStatus();
  }

  function getSocketState() {
    if (!backendUrl()) return 'off';
    const s = _socket || global._cricproSocket;
    if (s?.connected) return 'connected';
    return s ? 'connecting' : 'off';
  }

  function connect() {
    if (typeof io === 'undefined') {
      console.warn('[LiveSync] socket.io not loaded');
      return null;
    }
    const url = backendUrl();
    if (!url) return null;
    if (global._cricproSocket?.connected) {
      _socket = wireSocket(global._cricproSocket);
      return _socket;
    }
    if (_socket?.connected) return _socket;

    _socket = io(url, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 12,
      reconnectionDelay: 1000,
      timeout: 15000,
    });
    global._cricproSocket = _socket;
    global.socket = _socket;

    _socket.on('connect', () => {
      _socket.emit('join_global', {});
      if (_joinedMatch) _socket.emit('join_match', _joinedMatch);
      if (_joinedTournament) _socket.emit('join_tournament', _joinedTournament);
      emitLinkStatus();
    });
    _socket.on('disconnect', () => emitLinkStatus());
    _socket.on('connect_error', () => emitLinkStatus());

    wireSocket(_socket);
    emitLinkStatus();
    return _socket;
  }

  function joinMatch(matchId) {
    _joinedMatch = matchId || null;
    if (_socket?.connected && matchId) _socket.emit('join_match', matchId);
  }

  function joinTournament(tournamentId) {
    _joinedTournament = tournamentId || null;
    if (_socket?.connected && tournamentId) _socket.emit('join_tournament', tournamentId);
  }

  function buildOverlayUrl(opts) {
    const o = opts || {};
    const base = o.useLocalPreview ? (global.location?.origin || '') : siteOrigin();
    const q = ['obs=1'];
    if (o.layer) q.push('layer=' + encodeURIComponent(o.layer));
    if (o.tournamentId) q.push('tournament=' + encodeURIComponent(o.tournamentId));
    else if (o.matchId) q.push('match=' + encodeURIComponent(o.matchId));
    if (o.extra) q.push(o.extra);
    return base + '/pages/overlay.html?' + q.join('&');
  }

  function getLiveMatchForTournament(tournamentId) {
    if (!global.DB || !tournamentId) return null;
    const matches = global.DB.getMatches().filter((m) => m.tournamentId === tournamentId);
    return (
      matches.find((m) => m.status === 'live') ||
      matches.find((m) => m.status === 'paused') ||
      null
    );
  }

  /** First live/paused match synced from desktop (any tournament). */
  function getAnyLiveMatch() {
    if (!global.DB) return null;
    const matches = global.DB.getMatches().filter((m) => m && m.id);
    const live = matches.filter((m) => m.status === 'live' || m.status === 'paused');
    live.sort((a, b) => (b.lastUpdated || b.scoringStartedAt || 0) - (a.lastUpdated || a.scoringStartedAt || 0));
    return live[0] || null;
  }

  function install(opts) {
    const force = opts && opts.force;
    if (!force && global.SLCRICK_SYNC && !global.SLCRICK_SYNC.isEnabled()) return;
    connect();
  }

  global.SLCRICK_LIVE = {
    PUBLIC_SITE,
    backendUrl,
    siteOrigin,
    connect,
    disconnect,
    getSocketState,
    joinMatch,
    joinTournament,
    applyScoreUpdate,
    buildOverlayUrl,
    getLiveMatchForTournament,
    getAnyLiveMatch,
    install,
    get socket() {
      return _socket || global._cricproSocket;
    },
  };

  if (global.SLCRICK_SYNC?.isEnabled?.()) {
    global.SLCRICK_SYNC.wakeUpServer?.().then(() => install());
  }
})(typeof window !== 'undefined' ? window : global);
