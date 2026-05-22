/**
 * SLCRICKPRO — Broadcast link layer (desktop ↔ cloud ↔ site)
 * Sync ON  = publish + WebSocket live mirror
 * Sync OFF = isolated (local only, socket disconnected)
 */
(function (global) {
  const PUBLIC_SITE = 'https://slcrickpro.live';

  function syncEnabled() {
    return !!(global.SLCRICK_SYNC?.isEnabled?.() || (global.BACKEND_BASE_URL && global.SLCRICK_SYNC));
  }

  function getLiveMatch() {
    return global.SLCRICK_LIVE?.getAnyLiveMatch?.() || null;
  }

  function socketState() {
    if (!syncEnabled() && !global.BACKEND_BASE_URL && !global.CRICPRO_CLOUD_CONFIG?.backendUrl) {
      return 'off';
    }
    const s = global.SLCRICK_LIVE?.socket || global._cricproSocket;
    if (s?.connected) return 'connected';
    if (s && !s.connected) return 'connecting';
    if (syncEnabled() || global.BACKEND_BASE_URL || global.CRICPRO_CLOUD_CONFIG?.backendUrl) {
      return 'connecting';
    }
    return 'off';
  }

  /** @returns {'isolated'|'linked'|'on-air'} */
  function getPhase() {
    const onWeb = !global.SLCRICK_DESKTOP;
    if (!syncEnabled() && global.SLCRICK_DESKTOP) return 'isolated';
    if (getLiveMatch()) return 'on-air';
    if (onWeb && (global.BACKEND_BASE_URL || global.CRICPRO_CLOUD_CONFIG?.backendUrl)) return 'linked';
    if (!syncEnabled()) return 'isolated';
    return 'linked';
  }

  function getStatus() {
    const live = getLiveMatch();
    return {
      phase: getPhase(),
      syncEnabled: syncEnabled(),
      websocket: socketState(),
      liveMatch: live,
      publicSite: PUBLIC_SITE,
      backendUrl: global.SLCRICK_SYNC?.getBackendUrl?.() || global.BACKEND_BASE_URL || '',
      isDesktop: !!global.SLCRICK_DESKTOP,
    };
  }

  let _statusEmitLock = false;

  function emitStatus() {
    if (_statusEmitLock) return;
    _statusEmitLock = true;
    try {
      global.dispatchEvent?.(
        new CustomEvent('slcrick-broadcast-status', { detail: getStatus() })
      );
    } finally {
      _statusEmitLock = false;
    }
  }

  function setPublishEnabled(enabled, options = {}) {
    if (!global.SLCRICK_SYNC) return getStatus();
    const cfg = global.SLCRICK_SYNC.loadSettings();
    global.SLCRICK_SYNC.saveSettings({
      enabled: !!enabled,
      backendUrl: cfg.backendUrl || global.SLCRICK_SYNC.DEFAULT_BACKEND,
      lastSyncAt: cfg.lastSyncAt,
      lastSyncError: enabled ? null : 'Broadcast isolated from website',
    });
    if (enabled) {
      global.SLCRICK_SYNC.install();
      global.SLCRICK_LIVE?.install?.({ force: true });
      if (options.syncNow) {
        global.SLCRICK_SYNC.flushQueue?.();
        return global.SLCRICK_SYNC.syncCloudData({ forceRefresh: true, silent: false }).then(() => {
          emitStatus();
          return getStatus();
        });
      }
    } else {
      global.SLCRICK_LIVE?.disconnect?.();
      global.BACKEND_BASE_URL = '';
      if (global._slcrickSyncInterval) {
        clearInterval(global._slcrickSyncInterval);
        global._slcrickSyncInterval = null;
      }
    }
    emitStatus();
    return getStatus();
  }

  global.SLCRICK_BROADCAST = {
    PUBLIC_SITE,
    getStatus,
    emitStatus,
    setPublishEnabled,
    syncEnabled,
    getLiveMatch,
  };
})(typeof window !== 'undefined' ? window : global);
