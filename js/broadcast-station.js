/**
 * SLCRICKPRO Broadcast Station — tournaments, live mirror, OBS URLs
 */
(function (global) {
  function liveApi() {
    if (!global.SLCRICK_LIVE) {
      console.error('[BroadcastStation] SLCRICK_LIVE missing — load live-sync.js');
      return null;
    }
    return global.SLCRICK_LIVE;
  }
  let selectedTournamentId = null;
  let selectedMatchId = null;

  function esc(s) {
    if (typeof escapeHTML === 'function') return escapeHTML(String(s ?? ''));
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getTheme() {
    try {
      return localStorage.getItem('cricpro_scorebar_theme') || 'theme2';
    } catch (_) {
      return 'theme2';
    }
  }

  function stripHeight(theme) {
    return theme === 'theme2' ? 120 : theme === 'theme3' ? 90 : 280;
  }

  function statusLabel(m) {
    if (!m) return '—';
    if (m.status === 'live') return '🔴 LIVE';
    if (m.status === 'paused') return '⏸ Paused';
    if (m.status === 'completed') return '✅ Done';
    return '📅 Scheduled';
  }

  function scoreLine(m) {
    if (!m?.innings?.length) return 'Not started';
    const inn = m.innings[m.currentInnings ?? 0];
    if (!inn) return 'Not started';
    const bpo = m.ballsPerOver || 6;
    const overs =
      typeof formatOvers === 'function'
        ? formatOvers(inn.balls, bpo)
        : (inn.balls / bpo).toFixed(1);
    return `${inn.runs}/${inn.wickets} (${overs} ov)`;
  }

  async function pullLatest() {
    if (typeof global.wakeUpServer === 'function') {
      try {
        await global.wakeUpServer();
      } catch (_) {}
    }
    if (typeof global.syncCloudData === 'function') {
      await global.syncCloudData({ forceRefresh: true, silent: false });
      return;
    }
    if (global.SLCRICK_SYNC?.syncCloudData) {
      await global.SLCRICK_SYNC.syncCloudData({ forceRefresh: true });
      return;
    }
    if (typeof global.pullGlobalData === 'function') {
      await global.pullGlobalData(false);
    }
  }

  function ensureDesktopCloudSync() {
    if (!global.SLCRICK_DESKTOP || !global.SLCRICK_SYNC) return;
    const s = global.SLCRICK_SYNC.loadSettings();
    if (!s.enabled) {
      global.SLCRICK_SYNC.saveSettings({
        enabled: true,
        backendUrl: s.backendUrl || global.SLCRICK_SYNC.DEFAULT_BACKEND,
      });
      global.SLCRICK_SYNC.install();
    }
  }

  function renderTournamentList() {
    const el = document.getElementById('bs-tournament-list');
    if (!el || !global.DB) return;
    const tourns = global.DB.getTournaments().filter((t) => t && t.id && t.status !== 'requested');
    if (!tourns.length) {
      el.innerHTML =
        '<div class="bs-empty">No tournaments yet. Schedule on the site or desktop, then <button type="button" class="btn btn-primary btn-sm" onclick="SLCRICK_BROADCAST_STATION.syncNow()">Sync now</button></div>';
      return;
    }
    tourns.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    el.innerHTML = tourns
      .map((t) => {
        const active = t.id === selectedTournamentId ? ' bs-tile--active' : '';
        const live = liveApi()?.getLiveMatchForTournament(t.id);
        const badge = live ? '<span class="bs-badge bs-badge--live">LIVE</span>' : '';
        return `<button type="button" class="bs-tile${active}" data-tid="${esc(t.id)}">
          <span class="bs-tile-title">${esc(t.name)}</span>
          <span class="bs-tile-meta">${(t.matches?.length || 0)} matches ${badge}</span>
        </button>`;
      })
      .join('');
    el.querySelectorAll('[data-tid]').forEach((btn) => {
      btn.onclick = () => selectTournament(btn.getAttribute('data-tid'));
    });
  }

  function renderMatchList() {
    const el = document.getElementById('bs-match-list');
    if (!el || !selectedTournamentId || !global.DB) return;
    const matches = global.DB.getMatches().filter((m) => m.tournamentId === selectedTournamentId);
    if (!matches.length) {
      el.innerHTML = '<div class="bs-empty">No matches in this tournament yet.</div>';
      return;
    }
    matches.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    el.innerHTML = matches
      .map((m) => {
        const active = m.id === selectedMatchId ? ' bs-match--active' : '';
        return `<button type="button" class="bs-match${active}" data-mid="${esc(m.id)}">
          <div class="bs-match-top"><strong>${esc(m.team1)} vs ${esc(m.team2)}</strong>
          <span class="bs-match-status">${statusLabel(m)}</span></div>
          <div class="bs-match-score">${esc(scoreLine(m))}</div>
        </button>`;
      })
      .join('');
    el.querySelectorAll('[data-mid]').forEach((btn) => {
      btn.onclick = () => selectMatch(btn.getAttribute('data-mid'));
    });
  }

  function updateObsUrls() {
    const scoreEl = document.getElementById('bs-url-scorebar');
    const hotEl = document.getElementById('bs-url-hotkeys');
    const siteEl = document.getElementById('bs-url-site-note');
    if (!scoreEl || !hotEl) return;
    const theme = getTheme();
    const tid = selectedTournamentId;
    const mid = selectedMatchId || LIVE?.getLiveMatchForTournament(tid)?.id;
    if (!tid) {
      scoreEl.value = '';
      hotEl.value = '';
      return;
    }
    const extra = 'strip=1&theme=' + encodeURIComponent(theme);
    const L = liveApi();
    if (!L) return;
    scoreEl.value = L.buildOverlayUrl({
      tournamentId: tid,
      matchId: mid,
      layer: 'scorebar',
      extra,
    });
    hotEl.value = L.buildOverlayUrl({ tournamentId: tid, matchId: mid, layer: 'hotkeys' });
    if (siteEl) {
      siteEl.textContent =
        'Public site mirror: ' +
        (L.PUBLIC_SITE || 'https://slcrickpro.live') +
        ' — same URLs work in OBS for any viewer.';
    }
  }

  function updatePreview() {
    const wrap = document.getElementById('bs-preview-wrap');
    const frame = document.getElementById('bs-preview-frame');
    const label = document.getElementById('bs-preview-label');
    if (!wrap || !frame) return;
    const tid = selectedTournamentId;
    if (!tid) {
      wrap.style.display = 'none';
      return;
    }
    const L = liveApi();
    if (!L) return;
    const live = L.getLiveMatchForTournament(tid);
    const mid = selectedMatchId || live?.id;
    const theme = getTheme();
    const h = stripHeight(theme);
    const useLocalPreview =
      !!global.SLCRICK_DESKTOP && (!global.SLCRICK_SYNC || !global.SLCRICK_SYNC.isEnabled());
    const url = L.buildOverlayUrl({
      tournamentId: tid,
      matchId: mid,
      layer: 'scorebar',
      extra: 'strip=1&theme=' + encodeURIComponent(theme) + '&preview=1',
      useLocalPreview,
    });
    wrap.style.display = 'block';
    frame.style.height = h + 'px';
    if (frame.src !== url) frame.src = url;
    if (label) {
      label.textContent = live
        ? `Live mirror — ${live.team1} vs ${live.team2}`
        : mid
          ? 'Preview — select a live match or start scoring on desktop'
          : 'Waiting for live match…';
    }
    L.joinTournament(tid);
    if (mid) L.joinMatch(mid);
  }

  function selectTournament(tid) {
    selectedTournamentId = tid;
    selectedMatchId = null;
    const t = global.DB?.getTournament(tid);
    const title = document.getElementById('bs-detail-title');
    if (title) title.textContent = t?.name || 'Tournament';
    document.getElementById('bs-detail')?.classList.add('bs-detail--open');
    liveApi()?.joinTournament(tid);
    const live = liveApi()?.getLiveMatchForTournament(tid);
    if (live) selectedMatchId = live.id;
    renderTournamentList();
    renderMatchList();
    updatePreview();
    updateObsUrls();
  }

  function selectMatch(mid) {
    selectedMatchId = mid;
    renderMatchList();
    updatePreview();
    updateObsUrls();
    liveApi()?.joinMatch(mid);
  }

  async function syncNow() {
    const btn = document.getElementById('bs-btn-sync');
    if (btn) btn.disabled = true;
    try {
      await pullLatest();
      if (typeof showToast === 'function') showToast('✅ Synced with cloud', 'success');
      refresh();
    } catch (e) {
      if (typeof showToast === 'function') showToast('Sync failed — check cloud settings', 'error');
    }
    if (btn) btn.disabled = false;
  }

  function copyUrl(inputId) {
    const el = document.getElementById(inputId);
    if (!el?.value) return;
    navigator.clipboard.writeText(el.value).then(
      () => showToast?.('URL copied', 'success'),
      () => showToast?.(el.value, 'default')
    );
  }

  function refresh() {
    renderTournamentList();
    if (selectedTournamentId) {
      renderMatchList();
      updatePreview();
      updateObsUrls();
    }
  }

  async function init() {
    if (global.SLCRICK_DESKTOP) {
      ensureDesktopCloudSync();
      if (global.SLCRICK_SYNC && !global.SLCRICK_SYNC.isEnabled()) {
        const hint = document.getElementById('bs-sync-warn');
        if (hint) hint.style.display = 'block';
      }
    }
    if (global.SLCRICK_LIVE?.install) global.SLCRICK_LIVE.install({ force: true });
    await pullLatest();
    renderTournamentList();
    global.addEventListener('slcrick-live-update', refresh);
    const params = new URLSearchParams(global.location.search);
    const tid = params.get('tournament') || params.get('tournamentId');
    if (tid) selectTournament(tid);
  }

  global.SLCRICK_BROADCAST_STATION = {
    init,
    refresh,
    syncNow,
    selectTournament,
    selectMatch,
    copyUrl,
  };
})(window);
