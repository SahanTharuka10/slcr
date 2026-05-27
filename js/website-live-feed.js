/**
 * SLCRICKPRO — Website live score feed (ongoing-matches, home ticker, etc.)
 * Requires: cloud-config.js, db.js, socket-loader.js, realtime-manager.js
 */
(function (global) {
  let _applyingRemoteMatch = false;

  function refreshLiveUi() {
    if (typeof global.renderOngoing === 'function') global.renderOngoing();
    if (typeof global.renderLive === 'function') global.renderLive();
    if (typeof global.updateTicker === 'function') global.updateTicker();
  }

  function notifyLiveUpdate(matchId) {
    if (!matchId) return;
    try {
      global.dispatchEvent(
        new CustomEvent('slcrick-live-update', { detail: { type: 'match', id: matchId } })
      );
    } catch (_) {}
  }

  function applyRemoteMatch(data, opts) {
    if (!data?.id || !global.DB || _applyingRemoteMatch) return;
    _applyingRemoteMatch = true;
    try {
      const list = global.DB.getMatches();
      const idx = list.findIndex((m) => m.id === data.id);
      const local = idx >= 0 ? list[idx] : null;
      const cloudTs = data.lastUpdated || data.cloudUpdatedAt || 0;
      const localTs = local?.lastUpdated || 0;
      const fromSocket = !!(opts && opts.fromSocket);
      const liveish = data.status === 'live' || data.status === 'paused';
      if (local && !fromSocket && !liveish && localTs > cloudTs) return;
      if (local && !fromSocket && liveish && localTs > cloudTs + 2000) return;

      if (idx >= 0) list[idx] = data;
      else list.push(data);

      global.DB.saveMatches(list);
      try {
        localStorage.setItem('cricpro_force_update', String(Date.now()));
      } catch (_) {}

      refreshLiveUi();
      if (!opts?.skipLiveEvent) notifyLiveUpdate(data.id);
    } finally {
      _applyingRemoteMatch = false;
    }
  }

  function wireSocketHandlers(sock) {
    if (!sock || sock._slcrickWebsiteFeedWired) return;
    sock._slcrickWebsiteFeedWired = true;

    const onUpdate = (payload) => {
      const match = payload?.match || payload?.data || payload;
      if (!match?.id) return;
      // When live-sync.js is loaded, realtime-manager already calls applyScoreUpdate.
      if (typeof global.SLCRICK_LIVE?.applyScoreUpdate === 'function') return;
      applyRemoteMatch(match, { fromSocket: true });
    };

    sock.on('scoreUpdate', onUpdate);
    sock.on('match-update', onUpdate);

    sock.on('globalUpdate', (info) => {
      if (!info || info.type === 'joined') return;
      if (info.type === 'match_deleted' && info.id) {
        const arr = global.DB.getMatches().filter((m) => m.id !== info.id);
        global.DB.saveMatches(arr);
      }
      if (typeof global.syncCloudData === 'function') {
        global.syncCloudData({ silent: true, forceRefresh: true });
      } else if (global.SLCRICK_SYNC?.syncCloudData) {
        global.SLCRICK_SYNC.syncCloudData({ silent: true, forceRefresh: true });
      }
      if (typeof global.renderOngoing === 'function') global.renderOngoing();
    });
  }

  function joinAllLiveRooms() {
    if (!global.DB) return;
    const live = global.DB.getMatches().filter(
      (m) => m?.id && global.DB.isActivelyScoredMatch?.(m)
    );
    live.slice(0, 6).forEach((m) => {
      global.SLCRICK_REALTIME?.joinMatch?.(m.id);
      if (m.tournamentId) global.SLCRICK_REALTIME?.joinTournament?.(m.tournamentId);
    });
  }

  function startWebsitePolling() {
    if (global.SLCRICK_DESKTOP || global._slcrickWebsitePollStarted) return;
    global._slcrickWebsitePollStarted = true;
    const tick = () => {
      if (!global.SLCRICK_SYNC?.isEnabled?.()) return;
      const run =
        global.SLCRICK_SYNC.syncCloudData ||
        global.syncCloudData;
      if (typeof run === 'function') {
        run({ silent: true, forceRefresh: true }).catch(() => {});
      }
    };
    tick();
    setInterval(tick, 8000);
  }

  async function start() {
    if (global.SLCRICK_REALTIME) {
      const forceConnect = !global.SLCRICK_DESKTOP;
      await global.SLCRICK_REALTIME.install({ force: forceConnect });
      const sock = global.SLCRICK_REALTIME.socket;
      if (sock) wireSocketHandlers(sock);
      else {
        global.SLCRICK_REALTIME.on('scoreUpdate', (data) => {
          const m = data?.match || data?.data || data;
          if (m?.id) applyRemoteMatch(m, { fromSocket: true });
        });
      }
      joinAllLiveRooms();
      if (!global.SLCRICK_DESKTOP) startWebsitePolling();
      return;
    }

    if (global._cricproSocket) {
      wireSocketHandlers(global._cricproSocket);
      if (!global.SLCRICK_DESKTOP) startWebsitePolling();
      return;
    }
  }

  global.SLCRICK_WEBSITE_FEED = { start, applyRemoteMatch };

  global.addEventListener('slcrick-live-update', (e) => {
    if (e.detail?.type === 'match') refreshLiveUi();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start());
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : global);
