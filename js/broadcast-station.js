/**
 * SLCRICKPRO Broadcast Station — desktop studio + site mirror
 */
(function (global) {
  let selectedTournamentId = null;
  let selectedMatchId = null;
  let activeLiveMatch = null;
  let operatorMode = false;

  function linkApi() {
    return global.SLCRICK_BROADCAST || null;
  }

  function liveApi() {
    return global.SLCRICK_LIVE || null;
  }

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
    if (m.status === 'live') return 'LIVE';
    if (m.status === 'paused') return 'PAUSED';
    return String(m.status || '').toUpperCase();
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

  function tournamentLocked(t) {
    return !!(t && (t.scoringPassword || t.password || t.isLocked));
  }

  function isBroadcastUnlocked(tournamentId) {
    if (!tournamentId) return true;
    try {
      if (sessionStorage.getItem('bs_unlock_' + tournamentId) === '1') return true;
      const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
      if (grants[tournamentId]) return true;
    } catch (_) {}
    return false;
  }

  function markBroadcastUnlocked(tournamentId, password) {
    if (!tournamentId) return;
    sessionStorage.setItem('bs_unlock_' + tournamentId, '1');
    if (password) localStorage.setItem('tourn_pw_' + tournamentId, password);
    try {
      const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
      grants[tournamentId] = true;
      localStorage.setItem('cricpro_grants', JSON.stringify(grants));
    } catch (_) {}
  }

  function clearBroadcastUnlock(tournamentId) {
    if (tournamentId) sessionStorage.removeItem('bs_unlock_' + tournamentId);
  }

  function currentMatch() {
    if (operatorMode && selectedTournamentId) {
      const L = liveApi();
      if (selectedMatchId) return global.DB?.getMatch(selectedMatchId) || null;
      return L?.getLiveMatchForTournament(selectedTournamentId) || null;
    }
    return activeLiveMatch || linkApi()?.getLiveMatch() || liveApi()?.getAnyLiveMatch() || null;
  }

  function overlayUrlForMatch(match, extra, useLocal) {
    const L = liveApi();
    if (!L || !match) return '';
    const theme = getTheme();
    const parts = 'strip=1&theme=' + encodeURIComponent(theme) + (extra || '');
    return L.buildOverlayUrl({
      tournamentId: match.tournamentId,
      matchId: match.id,
      layer: 'scorebar',
      extra: parts,
      useLocalPreview: !!useLocal,
    });
  }

  function renderStatusRibbon() {
    const st = linkApi()?.getStatus() || {
      phase: 'isolated',
      syncEnabled: false,
      websocket: 'off',
      liveMatch: null,
      publicSite: 'https://slcrickpro.live',
    };

    document.body.classList.remove('bs-phase-isolated', 'bs-phase-linked', 'bs-phase-on-air');
    document.body.classList.add('bs-phase-' + st.phase);

    const steps = ['bs-step-desktop', 'bs-step-cloud', 'bs-step-site'];
    const lines = ['bs-line-1', 'bs-line-2'];
    steps.forEach((id) => document.getElementById(id)?.classList.remove('bs-step--active'));
    lines.forEach((id) => document.getElementById(id)?.classList.remove('bs-step-line--active'));

    if (st.phase === 'isolated') {
      document.getElementById('bs-step-desktop')?.classList.add('bs-step--active');
    } else if (st.phase === 'linked') {
      document.getElementById('bs-step-desktop')?.classList.add('bs-step--active');
      document.getElementById('bs-step-cloud')?.classList.add('bs-step--active');
      document.getElementById('bs-line-1')?.classList.add('bs-step-line--active');
    } else {
      steps.forEach((id) => document.getElementById(id)?.classList.add('bs-step--active'));
      lines.forEach((id) => document.getElementById(id)?.classList.add('bs-step-line--active'));
    }

    const pills = document.getElementById('bs-status-pills');
    if (pills) {
      const syncCls = st.syncEnabled ? 'bs-pill--ok' : 'bs-pill--off';
      const wsCls =
        st.websocket === 'connected' ? 'bs-pill--ok' : st.websocket === 'connecting' ? 'bs-pill--warn' : 'bs-pill--off';
      const liveCls = st.liveMatch ? 'bs-pill--ok' : 'bs-pill--off';
      pills.innerHTML = `
        <span class="bs-pill ${syncCls}">Publish ${st.syncEnabled ? 'ON' : 'OFF'}</span>
        <span class="bs-pill ${wsCls}">WebSocket ${st.websocket}</span>
        <span class="bs-pill ${liveCls}">${st.liveMatch ? '● ON AIR' : 'No live feed'}</span>`;
    }

    const note = document.getElementById('bs-ribbon-note');
    if (note) {
      if (st.phase === 'isolated') {
        note.textContent = operatorMode
          ? 'Isolated mode — scores stay on this PC only. Turn on Publish to push to the website.'
          : 'Waiting for desktop studio — scorer must enable Publish on the desktop app.';
      } else if (st.phase === 'linked') {
        note.textContent =
          'Linked to cloud API. Start or resume a LIVE match on desktop — WebSocket will mirror each ball to this page.';
      } else {
        note.textContent = `On air — ${st.liveMatch.team1} vs ${st.liveMatch.team2}. Overlay updates in real time via WebSocket.`;
      }
    }

    const wsInd = document.getElementById('bs-ws-indicator');
    if (wsInd) {
      if (st.websocket === 'connected') {
        wsInd.textContent = '● WEBSOCKET LIVE';
        wsInd.classList.add('bs-live-dot--pulse');
      } else {
        wsInd.textContent = st.syncEnabled ? '○ CONNECTING…' : '○ OFFLINE';
        wsInd.classList.remove('bs-live-dot--pulse');
      }
    }

    const toggle = document.getElementById('bs-publish-toggle');
    const toggleText = document.getElementById('bs-toggle-text');
    if (toggle) toggle.checked = !!st.syncEnabled;
    if (toggleText) toggleText.textContent = st.syncEnabled ? 'Publishing' : 'Isolated';
  }

  function renderMatchHero(match) {
    const el = document.getElementById('bs-match-hero');
    if (!el || !match) return;
    const t = global.DB?.getTournament(match.tournamentId);
    el.innerHTML = `
      ${t?.name ? `<span class="bs-match-hero-meta" style="opacity:0.7;font-size:11px;text-transform:uppercase;letter-spacing:1px">${esc(t.name)}</span>` : ''}
      <strong>${esc(match.team1)} vs ${esc(match.team2)}</strong>
      <div class="bs-match-hero-meta">
        <span>${esc(scoreLine(match))}</span>
        <span class="bs-match-hero-status">${statusLabel(match)}</span>
      </div>`;
  }

  function updatePreviewAndUrls() {
    const match = currentMatch();
    const frame = document.getElementById('bs-preview-frame');
    const idle = document.getElementById('bs-idle');
    const stage = document.getElementById('bs-live-stage');
    const unlockPanel = document.getElementById('bs-unlock-panel');
    const obsPanel = document.getElementById('bs-obs-panel');

    activeLiveMatch = match;

    if (!match) {
      if (idle) idle.hidden = false;
      if (stage) stage.hidden = true;
      renderStatusRibbon();
      return;
    }

    if (idle) idle.hidden = true;
    if (stage) stage.hidden = false;
    renderMatchHero(match);

    const theme = getTheme();
    const h = stripHeight(theme);
    const useLocal =
      operatorMode && global.SLCRICK_DESKTOP && (!global.SLCRICK_SYNC || !global.SLCRICK_SYNC.isEnabled());
    const previewUrl = overlayUrlForMatch(match, '&preview=1', useLocal);
    if (frame) {
      frame.style.height = h + 'px';
      if (frame.src !== previewUrl) frame.src = previewUrl;
    }

    const L = liveApi();
    L?.joinTournament(match.tournamentId);
    L?.joinMatch(match.id);

    const tid = match.tournamentId;
    const unlocked = operatorMode || !tournamentLocked(global.DB?.getTournament(tid)) || isBroadcastUnlocked(tid);

    if (unlockPanel) unlockPanel.hidden = operatorMode || unlocked;
    if (obsPanel) obsPanel.hidden = !unlocked && !operatorMode;

    const urlEl = document.getElementById('bs-url-overlay');
    if (urlEl && (unlocked || operatorMode)) {
      urlEl.value = overlayUrlForMatch(match, '', false);
    }

    if (operatorMode && selectedTournamentId) {
      const hotEl = document.getElementById('bs-url-hotkeys');
      const L2 = liveApi();
      if (hotEl && L2) {
        hotEl.value = L2.buildOverlayUrl({
          tournamentId: selectedTournamentId,
          matchId: match.id,
          layer: 'hotkeys',
        });
      }
      const viewer = document.getElementById('bs-viewer-link');
      const site = linkApi()?.PUBLIC_SITE || 'https://slcrickpro.live';
      if (viewer) {
        viewer.href = site + '/pages/broadcast-station.html';
        viewer.textContent = 'Open site mirror ↗';
      }
      document.getElementById('bs-viewer-panel')?.removeAttribute('hidden');
    }

    renderStatusRibbon();
  }

  function renderIdleCopy() {
    const st = linkApi()?.getStatus();
    const title = document.getElementById('bs-idle-title');
    const desc = document.getElementById('bs-idle-desc');
    if (!title || !desc) return;
    if (operatorMode && !st?.syncEnabled) {
      title.textContent = 'Publish is OFF';
      desc.textContent = 'Turn on Publish above, then go LIVE in Score Match — the overlay will push here and to the website.';
    } else if (operatorMode) {
      title.textContent = 'Ready — no live match';
      desc.textContent = 'Cloud link is active. Start scoring a match as LIVE to see preview and OBS URLs.';
    } else {
      title.textContent = 'Waiting for desktop broadcast';
      desc.textContent = 'When the desktop app publishes a LIVE match, preview and OBS tools appear here automatically.';
    }
  }

  // ─── Public unlock ───────────────────────────────────────────────────────

  async function submitUnlock(ev) {
    if (ev) ev.preventDefault();
    const match = currentMatch();
    if (!match?.tournamentId) return false;
    const tid = match.tournamentId;
    const pw = (document.getElementById('bs-password')?.value || '').trim();
    const errEl = document.getElementById('bs-unlock-error');
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    if (!pw) {
      if (errEl) {
        errEl.textContent = 'Enter tournament password.';
        errEl.hidden = false;
      }
      return false;
    }
    const t = global.DB?.getTournament(tid);
    const localPw = t?.scoringPassword || t?.password;
    if (localPw && pw === localPw) {
      markBroadcastUnlocked(tid, pw);
      showToast?.('Unlocked', 'success');
      updatePreviewAndUrls();
      return false;
    }
    const hs = global.DB?.handshake ? await global.DB.handshake(tid, pw) : null;
    if (hs?.ok) {
      markBroadcastUnlocked(tid, pw);
      localStorage.setItem('tourn_pw_' + tid, pw);
      showToast?.('Unlocked', 'success');
      updatePreviewAndUrls();
      return false;
    }
    if (errEl) {
      errEl.textContent = hs?.error || 'Wrong password';
      errEl.hidden = false;
    }
    showToast?.('Wrong password', 'error');
    return false;
  }

  function lockStudio() {
    const tid = currentMatch()?.tournamentId;
    if (tid) clearBroadcastUnlock(tid);
    updatePreviewAndUrls();
    showToast?.('OBS URL locked', 'default');
  }

  // ─── Operator sidebar ────────────────────────────────────────────────────

  function renderTournamentList() {
    const el = document.getElementById('bs-tournament-list');
    if (!el || !global.DB) return;
    const tourns = global.DB.getTournaments().filter((t) => t && t.id && t.status !== 'requested');
    if (!tourns.length) {
      el.innerHTML = '<p class="bs-hint">No tournaments — sync or create on desktop.</p>';
      return;
    }
    tourns.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    el.innerHTML = tourns
      .map((t) => {
        const active = t.id === selectedTournamentId ? ' bs-tile--active' : '';
        const live = liveApi()?.getLiveMatchForTournament(t.id);
        const badge = live ? ' · LIVE' : '';
        return `<button type="button" class="bs-tile${active}" data-tid="${esc(t.id)}">
          <span class="bs-tile-title">${esc(t.name)}</span>
          <span class="bs-tile-meta">${(t.matches?.length || 0)} matches${badge}</span>
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
    el.hidden = false;
    const matches = global.DB.getMatches().filter((m) => m.tournamentId === selectedTournamentId);
    if (!matches.length) {
      el.innerHTML = '<p class="bs-hint">No matches yet.</p>';
      return;
    }
    matches.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    el.innerHTML = matches
      .map((m) => {
        const active = m.id === selectedMatchId ? ' bs-match--active' : '';
        return `<button type="button" class="bs-match${active}" data-mid="${esc(m.id)}">
          <div class="bs-match-top"><strong>${esc(m.team1)} vs ${esc(m.team2)}</strong>
          <span>${statusLabel(m)}</span></div>
          <div class="bs-match-score">${esc(scoreLine(m))}</div>
        </button>`;
      })
      .join('');
    el.querySelectorAll('[data-mid]').forEach((btn) => {
      btn.onclick = () => {
        selectedMatchId = btn.getAttribute('data-mid');
        renderMatchList();
        updatePreviewAndUrls();
        liveApi()?.joinMatch(selectedMatchId);
      };
    });
  }

  function selectTournament(tid) {
    selectedTournamentId = tid;
    selectedMatchId = null;
    const live = liveApi()?.getLiveMatchForTournament(tid);
    if (live) selectedMatchId = live.id;
    renderTournamentList();
    renderMatchList();
    updatePreviewAndUrls();
    liveApi()?.joinTournament(tid);
  }

  function setupPublishToggle() {
    const panel = document.getElementById('bs-publish-panel');
    const toggle = document.getElementById('bs-publish-toggle');
    if (!panel || !toggle) return;
    panel.hidden = false;
    toggle.onchange = async () => {
      const on = toggle.checked;
      showToast?.(on ? 'Linking to website…' : 'Isolated from website', 'default');
      await linkApi()?.setPublishEnabled(on, { syncNow: on });
      if (on) global.SLCRICK_LIVE?.install?.({ force: true });
      renderStatusRibbon();
      renderIdleCopy();
      updatePreviewAndUrls();
      if (operatorMode) renderTournamentList();
    };
  }

  // ─── Sync ────────────────────────────────────────────────────────────────

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
    }
  }

  function ensureDesktopCloudSync() {
    if (!global.SLCRICK_DESKTOP || !global.SLCRICK_SYNC) return;
    const s = global.SLCRICK_SYNC.loadSettings();
    if (!s.enabled) return;
    global.SLCRICK_SYNC.install();
  }

  async function syncNow() {
    const btn = document.getElementById('bs-btn-sync');
    if (btn) btn.disabled = true;
    try {
      await pullLatest();
      if (operatorMode && global.SLCRICK_SYNC?.isEnabled()) global.SLCRICK_SYNC.flushQueue?.();
      showToast?.('Feed updated', 'success');
      refresh();
    } catch (_) {
      showToast?.('Sync failed', 'error');
    }
    if (btn) btn.disabled = false;
  }

  function copyUrl(inputId) {
    const el = document.getElementById(inputId);
    if (!el?.value) return;
    navigator.clipboard.writeText(el.value).then(
      () => showToast?.('Copied', 'success'),
      () => showToast?.(el.value, 'default')
    );
  }

  function refresh() {
    renderStatusRibbon();
    renderIdleCopy();
    if (operatorMode) {
      if (selectedTournamentId) renderMatchList();
      renderTournamentList();
    }
    updatePreviewAndUrls();
  }

  async function init() {
    const params = new URLSearchParams(global.location.search);
    operatorMode =
      !!global.SLCRICK_DESKTOP || params.get('operator') === '1' || params.get('full') === '1';

    document.body.classList.add(operatorMode ? 'bs-mode-operator' : 'bs-mode-public');

    if (operatorMode) {
      document.getElementById('bs-site-hint')?.setAttribute('hidden', '');
      document.getElementById('bs-operator-sidebar')?.removeAttribute('hidden');
      document.getElementById('bs-obs-extra')?.removeAttribute('hidden');
      document.getElementById('bs-settings-link')?.removeAttribute('hidden');
      const back = document.getElementById('bs-back-link');
      if (back) {
        back.href = 'score-match.html?tab=hotkeys';
        back.textContent = '← Hotkeys';
      }
      ensureDesktopCloudSync();
      setupPublishToggle();
    } else {
      document.getElementById('bs-publish-panel')?.setAttribute('hidden', '');
    }

    if (global.SLCRICK_LIVE?.install) {
      global.SLCRICK_LIVE.install({ force: !global.SLCRICK_SYNC || global.SLCRICK_SYNC.isEnabled() });
    }

    global.addEventListener('slcrick-live-update', refresh);
    global.addEventListener('slcrick-broadcast-status', refresh);

    await pullLatest();
    if (operatorMode) renderTournamentList();

    const tid = params.get('tournament') || params.get('tournamentId');
    if (operatorMode && tid) selectTournament(tid);

    refresh();

    if (!operatorMode) {
      setInterval(refresh, 6000);
    }
  }

  global.SLCRICK_BROADCAST_STATION = {
    init,
    refresh,
    syncNow,
    selectTournament,
    copyUrl,
    submitUnlock,
    lockStudio,
  };
})(window);
