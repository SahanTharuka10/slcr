/**
 * SLCRICKPRO — Website live score feed (ongoing-matches, home ticker, etc.)
 * Requires: cloud-config.js, db.js, socket-loader.js, realtime-manager.js
 */
(function (global) {
  function applyRemoteMatch(data) {
    if (!data?.id || !global.DB) return;
    const list = global.DB.getMatches();
    const idx = list.findIndex((m) => m.id === data.id);
    const local = idx >= 0 ? list[idx] : null;
    const cloudTs = data.lastUpdated || 0;
    const localTs = local?.lastUpdated || 0;
    if (local && localTs > cloudTs) return;

    if (idx >= 0) list[idx] = data;
    else list.push(data);

    global.DB.saveMatches(list);
    try {
      localStorage.setItem('cricpro_force_update', String(Date.now()));
    } catch (_) {}

    if (typeof global.renderOngoing === 'function') global.renderOngoing();
    if (typeof global.renderLive === 'function') global.renderLive();
    if (typeof global.updateTicker === 'function') global.updateTicker();
  }

  function wireSocketHandlers(sock) {
    if (!sock || sock._slcrickWebsiteFeedWired) return;
    sock._slcrickWebsiteFeedWired = true;

    const onUpdate = (payload) => {
      const match = payload?.match || payload?.data || payload;
      applyRemoteMatch(match);
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

  async function start() {
    if (global.SLCRICK_REALTIME) {
      global.SLCRICK_REALTIME.on('scoreUpdate', (data) => applyRemoteMatch(data));
      await global.SLCRICK_REALTIME.install({ force: false });
      const sock = global.SLCRICK_REALTIME.socket;
      if (sock) wireSocketHandlers(sock);
      return;
    }

    if (global._cricproSocket) {
      wireSocketHandlers(global._cricproSocket);
      return;
    }
  }

  global.SLCRICK_WEBSITE_FEED = { start, applyRemoteMatch };

  global.addEventListener('slcrick-live-update', (e) => {
    if (e.detail?.type === 'match' && e.detail.id && global.DB) {
      const m = global.DB.getMatch(e.detail.id);
      if (m) applyRemoteMatch(m);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start());
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : global);
