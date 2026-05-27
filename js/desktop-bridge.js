/**
 * SLCRICKPRO Desktop — UI helpers & home polish
 */
(function () {
  if (!window.SLCRICK_DESKTOP) return;

  function updateSyncBadge() {
    let badge = document.getElementById('desktop-offline-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'desktop-offline-badge';
      badge.style.cssText =
        'position:fixed;bottom:12px;right:12px;z-index:99999;padding:6px 12px;' +
        'border-radius:20px;font-size:11px;font-weight:700;font-family:Outfit,sans-serif;' +
        'cursor:pointer;';
      badge.title = 'Open cloud sync settings';
      badge.onclick = () => {
        const base = window.SLCRICK_BASE_URL || '';
        location.href = base + '/pages/settings.html';
      };
      document.body.appendChild(badge);
    }
    const on = window.SLCRICK_SYNC && window.SLCRICK_SYNC.isEnabled();
    const rt = window.SLCRICK_REALTIME?.getStatus?.();
    const userOff = window.SLCRICK_SYNC?.isUserSyncDisabled?.();
    const netOff = window.SLCRICK_SYNC?.isNetworkOnline?.() === false;
    if (userOff) {
      badge.textContent = '● Site sync paused';
      badge.style.background = 'rgba(148,163,184,0.15)';
      badge.style.color = '#94a3b8';
      badge.style.border = '1px solid rgba(148,163,184,0.35)';
    } else if (netOff) {
      badge.textContent = '● Offline · local only';
      badge.style.background = 'rgba(34,197,94,0.15)';
      badge.style.color = '#22c55e';
      badge.style.border = '1px solid rgba(34,197,94,0.35)';
    } else if (!on) {
      badge.textContent = '● Offline Desktop';
      badge.style.background = 'rgba(34,197,94,0.15)';
      badge.style.color = '#22c55e';
      badge.style.border = '1px solid rgba(34,197,94,0.35)';
    } else if (rt?.socketConnected) {
      badge.textContent = '● Live · WebSocket';
      badge.style.background = 'rgba(56,189,248,0.15)';
      badge.style.color = '#38bdf8';
      badge.style.border = '1px solid rgba(56,189,248,0.35)';
    } else if (rt?.state === 'reconnecting' || rt?.state === 'connecting') {
      badge.textContent = `● Reconnecting${rt.reconnectAttempt ? ' #' + rt.reconnectAttempt : ''}`;
      badge.style.background = 'rgba(251,191,36,0.15)';
      badge.style.color = '#fbbf24';
      badge.style.border = '1px solid rgba(251,191,36,0.35)';
    } else {
      badge.textContent = '● Cloud · REST fallback';
      badge.style.background = 'rgba(251,191,36,0.12)';
      badge.style.color = '#fbbf24';
      badge.style.border = '1px solid rgba(251,191,36,0.3)';
    }
  }

  function polishDesktopHome() {
    document.querySelectorAll('a[href="http://localhost:3000"]').forEach((el) => {
      el.style.display = 'none';
    });

    const actions = document.querySelector('.header-actions');
    if (actions && !document.getElementById('desktop-sync-header-btn')) {
      const syncBtn = document.createElement('a');
      syncBtn.id = 'desktop-sync-header-btn';
      syncBtn.className = 'header-btn-sm';
      syncBtn.href = 'pages/settings.html';
      syncBtn.title = 'Cloud sync settings';
      syncBtn.style.cssText = 'background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.35);';
      syncBtn.innerHTML =
        '<svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M20 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg><span>Sync</span>';
      actions.insertBefore(syncBtn, actions.firstChild);
    }

    document.documentElement.classList.add('slcrick-desktop-home');

    document.querySelectorAll('.nav-card.card-ranking, .nav-card.card-store').forEach((el) => {
      el.remove();
    });

    const grid = document.querySelector('.nav-grid');
    if (grid) {
      const cards = [...grid.querySelectorAll('.nav-card')];
      cards.forEach((card, i) => {
        const num = card.querySelector('.card-number');
        if (num) num.textContent = String(i + 1).padStart(2, '0');
      });
    }

    const footer = document.querySelector('.main-footer p');
    if (footer) {
      footer.textContent = '© 2026 SLCRICKPRO · Desktop App · Data saved on this PC';
    }
  }

  if (window.desktopAPI?.onStorageRestored) {
    window.desktopAPI.onStorageRestored(() => {
      if (typeof window.renderResumeMatches === 'function') window.renderResumeMatches();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (window.SLCRICK_SYNC && window.DB && !window._slcrickSyncClientBooted) window.SLCRICK_SYNC.install();
    updateSyncBadge();
    setInterval(updateSyncBadge, 5000);
    window.addEventListener('slcrick-realtime-state', updateSyncBadge);
    window.addEventListener('online', updateSyncBadge);
    window.addEventListener('offline', updateSyncBadge);

    if (window.desktopAPI?.getBaseUrl) {
      try {
        window.SLCRICK_BASE_URL = await window.desktopAPI.getBaseUrl();
      } catch (_) {}
    }

    polishDesktopHome();
  });

  window.openObsOverlayForMatch = function (matchId, tournamentId) {
    if (window.desktopAPI) {
      return window.desktopAPI.openObsOverlay({ matchId, tournamentId });
    }
  };

  window.copyObsBrowserUrl = window.copyObsLink || async function (matchId, tournamentId) {
    if (window.desktopAPI?.getObsBrowserUrls) {
      const urls = await window.desktopAPI.getObsBrowserUrls({
        matchId,
        tournamentId,
        layer: 'combined',
      });
      const url = urls.lan || urls.local || urls.website;
      try {
        await navigator.clipboard.writeText(url);
        if (typeof showToast === 'function') {
          showToast(urls.lan ? 'LAN OBS URL copied' : 'OBS URL copied', 'success');
        }
      } catch (_) {
        if (typeof showToast === 'function') showToast(url, 'default');
      }
      return url;
    }
    if (window.getObsOverlayUrl) {
      const url = await window.getObsOverlayUrl(matchId, tournamentId);
      try {
        await navigator.clipboard.writeText(url);
        if (typeof showToast === 'function') showToast('OBS URL copied', 'success');
      } catch (_) {
        if (typeof showToast === 'function') showToast(url, 'default');
      }
      return url;
    }
  };

  window.submitFeedback = async function () {
    const el = document.getElementById('user-feedback-msg');
    const msg = el ? el.value.trim() : '';
    if (!msg) {
      if (typeof showToast === 'function') showToast('Please write something', 'error');
      return;
    }
    const key = 'cricpro_local_feedback';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    list.push({ id: 'fb_' + Date.now(), message: msg, createdAt: Date.now() });
    localStorage.setItem(key, JSON.stringify(list));
    if (window.desktopAPI) window.desktopAPI.requestPersist();
    if (window.SLCRICK_SYNC?.isEnabled() && typeof syncToDB === 'function') {
      try {
        await fetch(window.SLCRICK_SYNC.getBackendUrl() + '/sync/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'fb_' + Date.now(), message: msg, status: 'unread', createdAt: Date.now() }),
        });
      } catch (_) {}
    }
    if (typeof showToast === 'function') showToast('Feedback saved', 'success');
    const modal = document.getElementById('modal-feedback');
    if (modal) modal.style.display = 'none';
    if (el) el.value = '';
  };
})();
