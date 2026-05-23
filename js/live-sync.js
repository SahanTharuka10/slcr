/**
 * SLCRICKPRO — Live sync facade (delegates to SLCRICK_REALTIME)
 * Requires: realtime-manager.js, socket.io client, db.js
 */
(function (global) {
  const PUBLIC_SITE = 'https://slcrickpro.live';
  const DEFAULT_API = 'https://slcrickpro.onrender.com';

  const RT = () => global.SLCRICK_REALTIME;

  function backendUrl() {
    return RT()?.resolveBackendUrl?.() || DEFAULT_API;
  }

  function siteOrigin() {
    return PUBLIC_SITE;
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
    global.SLCRICK_BROADCAST?.emitStatus?.();
    global.SLCRICK_BROADCAST_STATION?.refresh?.();
  }

  function disconnect() {
    RT()?.disconnect?.();
  }

  function getSocketState() {
    return RT()?.mapSocketState?.() || 'off';
  }

  function connect() {
    return RT()?.connect?.() || null;
  }

  function joinMatch(matchId) {
    RT()?.joinMatch?.(matchId);
  }

  function joinTournament(tournamentId) {
    RT()?.joinTournament?.(tournamentId);
  }

  function buildOverlayUrl(opts) {
    const o = opts || {};
    const base =
      o.base ||
      (o.useLocalPreview ? global.location?.origin || '' : siteOrigin());
    const q = ['obs=1'];
    if (o.layer) q.push('layer=' + encodeURIComponent(o.layer));
    if (o.tournamentId) q.push('tournament=' + encodeURIComponent(o.tournamentId));
    if (o.matchId) q.push('matchId=' + encodeURIComponent(o.matchId));
    if (o.extra) q.push(o.extra);
    return base + '/pages/overlay.html?' + q.join('&');
  }

  function buildShareOverlayUrl(matchId, theme, tournamentId) {
    const t = theme || 'theme1';
    if (tournamentId) {
      return buildOverlayUrl({
        tournamentId,
        layer: 'combined',
        extra: 'theme=' + encodeURIComponent(t),
      });
    }
    return buildOverlayUrl({
      matchId,
      layer: 'combined',
      extra: 'theme=' + encodeURIComponent(t),
    });
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
    RT()?.install?.({ force: !!force });
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
    buildShareOverlayUrl,
    getLiveMatchForTournament,
    getAnyLiveMatch,
    install,
    get socket() {
      return RT()?.socket || global._cricproSocket;
    },
  };

})(typeof window !== 'undefined' ? window : global);
