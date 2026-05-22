/**
 * SLCRICKPRO Broadcast Station — desktop studio + site viewer
 */
(function (global) {
  let selectedTournamentId = null;
  let selectedMatchId = null;
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

  function statusKey(m) {
    return String(m?.status || 'scheduled').toLowerCase();
  }

  function statusLabel(m) {
    const s = statusKey(m);
    if (s === 'live') return 'LIVE';
    if (s === 'paused') return 'PAUSED';
    if (s === 'completed' || s === 'finished') return 'DONE';
    return 'SCHEDULED';
  }

  function badgeClass(m) {
    const s = statusKey(m);
    if (s === 'live') return 'bs-ci-badge--live';
    if (s === 'paused') return 'bs-ci-badge--paused';
    return 'bs-ci-badge--sched';
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

  function isUnlocked(tournamentId) {
    if (!tournamentId) return true;
    try {
      if (sessionStorage.getItem('bs_unlock_' + tournamentId) === '1') return true;
      const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
      if (grants[tournamentId]) return true;
    } catch (_) {}
    return false;
  }

  function markUnlocked(tournamentId, password) {
    if (!tournamentId) return;
    sessionStorage.setItem('bs_unlock_' + tournamentId, '1');
    if (password) localStorage.setItem('tourn_pw_' + tournamentId, password);
    try {
      const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
      grants[tournamentId] = true;
      localStorage.setItem('cricpro_grants', JSON.stringify(grants));
    } catch (_) {}
  }

  function clearUnlock(tournamentId) {
    if (tournamentId) sessionStorage.removeItem('bs_unlock_' + tournamentId);
  }

  function allFeedMatches() {
    if (!global.DB) return [];
    const matches = global.DB.getMatches().filter((m) => m && m.id && !m.deleted);
    const order = { live: 0, paused: 1, scheduled: 2, completed: 3, finished: 3 };
    return matches.sort((a, b) => {
      const oa = order[statusKey(a)] ?? 4;
      const ob = order[statusKey(b)] ?? 4;
      if (oa !== ob) return oa - ob;
      return (b.lastUpdated || b.createdAt || 0) - (a.lastUpdated || a.createdAt || 0);
    });
  }

  function getSelectedMatch() {
    if (selectedMatchId && global.DB) {
      return global.DB.getMatch(selectedMatchId) || null;
    }
    if (operatorMode && selectedTournamentId) {
      const L = liveApi();
      if (selectedMatchId) return global.DB?.getMatch(selectedMatchId) || null;
      return L?.getLiveMatchForTournament(selectedTournamentId) || null;
    }
    return null;
  }

  function overlayUrl(match, extra, useLocal) {
    const L = liveApi();
    if (!L || !match) return '';
    const theme = getTheme();
    return L.buildOverlayUrl({
      tournamentId: match.tournamentId,
      matchId: match.id,
      layer: 'scorebar',
      extra: 'strip=1&theme=' + encodeURIComponent(theme) + (extra || ''),
      useLocalPreview: !!useLocal,
    });
  }

  function formatTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString();
    } catch (_) {
      return '—';
    }
  }

  function renderPipeline(st) {
    const phase = st?.phase || 'isolated';
    document.body.classList.remove('bs-phase-isolated', 'bs-phase-linked', 'bs-phase-on-air');
    document.body.classList.add('bs-phase-' + phase);

    const nodes = [
      ['bs-step-desktop', phase !== 'isolated'],
      ['bs-step-cloud', phase === 'linked' || phase === 'on-air'],
      ['bs-step-site', phase === 'on-air'],
    ];
    nodes.forEach(([id, on]) => {
      document.getElementById(id)?.classList.toggle('bs-node--on', on);
    });
    document.getElementById('bs-line-1')?.classList.toggle('bs-connector--on', phase !== 'isolated');
    document.getElementById('bs-line-2')?.classList.toggle('bs-connector--on', phase === 'on-air');
  }

  function renderStatusRibbon() {
    const st = linkApi()?.getStatus() || {
      phase: 'isolated',
      syncEnabled: false,
      websocket: 'off',
      liveMatch: null,
    };

    renderPipeline(st);

    const pills = document.getElementById('bs-status-pills');
    if (pills) {
      const ws = st.websocket || 'off';
      pills.innerHTML = `
        <span class="bs-chip ${st.syncEnabled ? 'bs-chip--ok' : 'bs-chip--off'}">Publish ${st.syncEnabled ? 'ON' : 'OFF'}</span>
        <span class="bs-chip ${ws === 'connected' ? 'bs-chip--ok' : ws === 'connecting' ? 'bs-chip--warn' : 'bs-chip--off'}">Socket ${ws}</span>
        <span class="bs-chip ${st.liveMatch ? 'bs-chip--ok' : 'bs-chip--off'}">${st.liveMatch ? 'ON AIR' : 'Idle'}</span>`;
    }

    const note = document.getElementById('bs-ribbon-note');
    if (note) {
      if (operatorMode) {
        if (!st.syncEnabled) note.textContent = 'Isolated — nothing is sent to the website.';
        else if (st.liveMatch)
          note.textContent = `Publishing ${st.liveMatch.team1} vs ${st.liveMatch.team2} — WebSocket mirrors each ball.`;
        else note.textContent = 'Linked to cloud — start a LIVE match to push overlay data.';
      } else {
        if (!st.liveMatch && !selectedMatchId)
          note.textContent = 'Pick any match from the feed. Live matches update via WebSocket from desktop.';
        else note.textContent = 'Password unlocks OBS URL. Preview is available for all published matches.';
      }
    }

    const wsInd = document.getElementById('bs-ws-indicator');
    if (wsInd) {
      const ws = st.websocket || 'off';
      if (ws === 'connected') {
        wsInd.textContent = 'WebSocket live';
        wsInd.className = 'bs-ws-badge bs-ws-badge--live';
      } else if (ws === 'connecting') {
        wsInd.textContent = 'Connecting…';
        wsInd.className = 'bs-ws-badge';
      } else {
        wsInd.textContent = 'Polling / offline';
        wsInd.className = 'bs-ws-badge';
      }
    }

    const toggle = document.getElementById('bs-publish-toggle');
    const toggleText = document.getElementById('bs-toggle-text');
    if (toggle) toggle.checked = !!st.syncEnabled;
    if (toggleText) toggleText.textContent = st.syncEnabled ? 'Publishing' : 'Isolated';

    const sub = document.getElementById('bs-brand-sub');
    if (sub) {
      sub.textContent = operatorMode ? 'Desktop broadcast studio' : 'Viewer · slcrickpro.live';
    }
  }

  function renderPushDetails(match) {
    const panel = document.getElementById('bs-push-panel');
    const dl = document.getElementById('bs-push-details');
    if (!panel || !dl) return;
    if (!operatorMode || !match) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const st = linkApi()?.getStatus() || {};
    const t = global.DB?.getTournament(match.tournamentId);
    const api = st.backendUrl || global.BACKEND_BASE_URL || '—';
    const syncCfg = global.SLCRICK_SYNC?.loadSettings?.();
    dl.innerHTML = `
      <div><dt>Match</dt><dd>${esc(match.team1)} vs ${esc(match.team2)}</dd></div>
      <div><dt>Status</dt><dd>${statusLabel(match)}</dd></div>
      <div><dt>Score</dt><dd>${esc(scoreLine(match))}</dd></div>
      <div><dt>Tournament</dt><dd>${esc(t?.name || '—')}</dd></div>
      <div><dt>Match ID</dt><dd>${esc(match.id)}</dd></div>
      <div><dt>Last update</dt><dd>${formatTime(match.lastUpdated)}</dd></div>
      <div><dt>Publish</dt><dd>${st.syncEnabled ? 'ON → website' : 'OFF (local only)'}</dd></div>
      <div><dt>API target</dt><dd>${esc(api)}</dd></div>
      <div><dt>Last sync</dt><dd>${syncCfg?.lastSyncAt ? formatTime(syncCfg.lastSyncAt) : '—'}</dd></div>`;
  }

  function renderMatchHero(match) {
    const el = document.getElementById('bs-match-hero');
    if (!el || !match) return;
    const t = global.DB?.getTournament(match.tournamentId);
    el.innerHTML = `
      ${t?.name ? `<span class="bs-studio-tourn">${esc(t.name)}</span>` : ''}
      <span class="bs-studio-teams">${esc(match.team1)} vs ${esc(match.team2)}</span>
      <div class="bs-studio-scoreline">
        <span>${esc(scoreLine(match))}</span>
        <span class="bs-studio-live">${statusLabel(match)}</span>
      </div>`;
  }

  function renderStudio() {
    const match = getSelectedMatch();
    const idle = document.getElementById('bs-idle');
    const stage = document.getElementById('bs-live-stage');
    const locked = document.getElementById('bs-tools-locked');
    const open = document.getElementById('bs-tools-open');
    const frame = document.getElementById('bs-preview-frame');

    renderPushDetails(match);

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
    const isLive = statusKey(match) === 'live' || statusKey(match) === 'paused';
    const previewUrl = overlayUrl(match, isLive ? '&preview=1' : '&preview=1', useLocal);

    if (frame) {
      frame.style.height = h + 'px';
      if (frame.src !== previewUrl) frame.src = previewUrl;
    }

    const L = liveApi();
    L?.joinTournament(match.tournamentId);
    L?.joinMatch(match.id);

    const tid = match.tournamentId;
    const needsPw = !operatorMode && tournamentLocked(global.DB?.getTournament(tid));
    const unlocked = operatorMode || !needsPw || isUnlocked(tid);

    if (locked) locked.hidden = unlocked;
    if (open) open.hidden = !unlocked;

    const urlEl = document.getElementById('bs-url-overlay');
    if (urlEl && unlocked) urlEl.value = overlayUrl(match, '', false);

    if (operatorMode) {
      const hotEl = document.getElementById('bs-url-hotkeys');
      if (hotEl && L) {
        hotEl.value = L.buildOverlayUrl({
          tournamentId: match.tournamentId,
          matchId: match.id,
          layer: 'hotkeys',
        });
      }
      const viewer = document.getElementById('bs-viewer-link');
      const site = linkApi()?.PUBLIC_SITE || 'https://slcrickpro.live';
      if (viewer) viewer.href = site + '/pages/broadcast-station.html';
    }

    renderStatusRibbon();
  }

  function renderWebCatalog() {
    const list = document.getElementById('bs-catalog-list');
    const count = document.getElementById('bs-catalog-count');
    if (!list) return;

    const matches = allFeedMatches();
    if (count) count.textContent = String(matches.length);

    if (!matches.length) {
      list.innerHTML =
        '<p class="bs-rail-desc">No matches on the cloud feed yet. Desktop must Publish ON and sync.</p>';
      return;
    }

    list.innerHTML = matches
      .map((m) => {
        const active = m.id === selectedMatchId ? ' bs-catalog-item--active' : '';
        const liveRow = statusKey(m) === 'live' ? ' bs-catalog-item--live' : '';
        const t = global.DB?.getTournament(m.tournamentId);
        const locked = tournamentLocked(t);
        return `<button type="button" class="bs-catalog-item${active}${liveRow}" data-mid="${esc(m.id)}">
          <div class="bs-ci-top">
            <span class="bs-ci-teams">${esc(m.team1)} vs ${esc(m.team2)}</span>
            <span class="bs-ci-badge ${badgeClass(m)}">${statusLabel(m)}</span>
          </div>
          <div class="bs-ci-meta">${esc(t?.name || 'Match')} · ${esc(scoreLine(m))}</div>
          ${locked ? '<div class="bs-ci-lock">🔐 Password required for OBS URL</div>' : ''}
        </button>`;
      })
      .join('');

    list.querySelectorAll('[data-mid]').forEach((btn) => {
      btn.onclick = () => selectPublicMatch(btn.getAttribute('data-mid'));
    });
  }

  function selectPublicMatch(mid) {
    selectedMatchId = mid;
    renderWebCatalog();
    renderStudio();
    const m = global.DB?.getMatch(mid);
    if (m?.tournamentId) liveApi()?.joinTournament(m.tournamentId);
    liveApi()?.joinMatch(mid);
  }

  function renderIdleCopy() {
    const title = document.getElementById('bs-idle-title');
    const desc = document.getElementById('bs-idle-desc');
    if (!title || !desc) return;
    const st = linkApi()?.getStatus();
    if (operatorMode && !st?.syncEnabled) {
      title.textContent = 'Publish is OFF';
      desc.textContent = 'Turn on Publish, then score a match as LIVE.';
    } else if (operatorMode) {
      title.textContent = 'Select a match';
      desc.textContent = 'Pick a tournament match or go LIVE in Score Match.';
    } else {
      title.textContent = 'Select a match from the feed';
      desc.textContent = 'All synced matches appear on the left. Click one to preview and unlock OBS.';
    }
  }

  async function submitUnlock(ev) {
    if (ev) ev.preventDefault();
    const match = getSelectedMatch();
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
      markUnlocked(tid, pw);
      showToast?.('Access granted', 'success');
      renderStudio();
      return false;
    }
    const hs = global.DB?.handshake ? await global.DB.handshake(tid, pw) : null;
    if (hs?.ok) {
      markUnlocked(tid, pw);
      localStorage.setItem('tourn_pw_' + tid, pw);
      showToast?.('Access granted', 'success');
      renderStudio();
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
    const tid = getSelectedMatch()?.tournamentId;
    if (tid) clearUnlock(tid);
    renderStudio();
    showToast?.('Access locked', 'default');
  }

  function renderTournamentList() {
    const el = document.getElementById('bs-tournament-list');
    if (!el || !global.DB) return;
    const tourns = global.DB.getTournaments().filter((t) => t && t.id && t.status !== 'requested');
    if (!tourns.length) {
      el.innerHTML = '<p class="bs-rail-desc">No tournaments yet.</p>';
      return;
    }
    tourns.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    el.innerHTML = tourns
      .map((t) => {
        const active = t.id === selectedTournamentId ? ' bs-catalog-item--active' : '';
        const live = liveApi()?.getLiveMatchForTournament(t.id);
        return `<button type="button" class="bs-catalog-item${active}" data-tid="${esc(t.id)}">
          <span class="bs-ci-teams">${esc(t.name)}</span>
          <span class="bs-ci-meta">${(t.matches?.length || 0)} matches${live ? ' · LIVE' : ''}</span>
        </button>`;
      })
      .join('');
    el.querySelectorAll('[data-tid]').forEach((btn) => {
      btn.onclick = () => selectTournament(btn.getAttribute('data-tid'));
    });
  }

  function renderOperatorMatchList() {
    const el = document.getElementById('bs-match-list');
    if (!el || !selectedTournamentId || !global.DB) return;
    const matches = global.DB.getMatches().filter((m) => m.tournamentId === selectedTournamentId);
    if (!matches.length) {
      el.innerHTML = '';
      return;
    }
    matches.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    el.innerHTML = matches
      .map((m) => {
        const active = m.id === selectedMatchId ? ' bs-catalog-item--active' : '';
        const liveRow = statusKey(m) === 'live' ? ' bs-catalog-item--live' : '';
        return `<button type="button" class="bs-catalog-item${active}${liveRow}" data-mid="${esc(m.id)}">
          <div class="bs-ci-top">
            <span class="bs-ci-teams">${esc(m.team1)} vs ${esc(m.team2)}</span>
            <span class="bs-ci-badge ${badgeClass(m)}">${statusLabel(m)}</span>
          </div>
          <div class="bs-ci-meta">${esc(scoreLine(m))}</div>
        </button>`;
      })
      .join('');
    el.querySelectorAll('[data-mid]').forEach((btn) => {
      btn.onclick = () => {
        selectedMatchId = btn.getAttribute('data-mid');
        renderOperatorMatchList();
        renderStudio();
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
    renderOperatorMatchList();
    renderStudio();
    liveApi()?.joinTournament(tid);
  }

  function setupPublishToggle() {
    const panel = document.getElementById('bs-publish-panel');
    const toggle = document.getElementById('bs-publish-toggle');
    if (!panel || !toggle) return;
    panel.hidden = false;
    toggle.onchange = async () => {
      const on = toggle.checked;
      showToast?.(on ? 'Publishing to website…' : 'Isolated from website', 'default');
      await linkApi()?.setPublishEnabled(on, { syncNow: on });
      if (on) {
        global.SLCRICK_LIVE?.install?.({ force: true });
        if (global._cricproSocket && !global._cricproSocket.connected) {
          global.SLCRICK_LIVE?.connect?.();
        }
      }
      refresh();
    };
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
    }
  }

  function ensureSocket() {
    global.SLCRICK_LIVE?.install?.({ force: true });
    if (global._cricproSocket && !global._cricproSocket.connected && global.SLCRICK_LIVE?.connect) {
      global.SLCRICK_LIVE.connect();
    }
  }

  async function syncNow() {
    const btn = document.getElementById('bs-btn-sync');
    if (btn) btn.disabled = true;
    try {
      await pullLatest();
      ensureSocket();
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

  function onBroadcastStatus() {
    renderStatusRibbon();
  }

  function refresh() {
    renderStatusRibbon();
    renderIdleCopy();
    if (operatorMode) {
      renderTournamentList();
      if (selectedTournamentId) renderOperatorMatchList();
    } else {
      renderWebCatalog();
    }
    renderStudio();
  }

  async function init() {
    const params = new URLSearchParams(global.location.search);
    operatorMode =
      !!global.SLCRICK_DESKTOP || params.get('operator') === '1' || params.get('full') === '1';

    document.body.classList.add(operatorMode ? 'bs-mode-operator' : 'bs-mode-public');

    const railTitle = document.getElementById('bs-rail-title');
    const railDesc = document.getElementById('bs-rail-desc');
    if (operatorMode) {
      document.getElementById('bs-catalog-panel')?.setAttribute('hidden', '');
      document.getElementById('bs-operator-sidebar')?.removeAttribute('hidden');
      document.getElementById('bs-settings-link')?.removeAttribute('hidden');
      const back = document.getElementById('bs-back-link');
      if (back) {
        back.href = 'score-match.html?tab=hotkeys';
        back.textContent = '← Hotkeys';
      }
      if (railTitle) railTitle.textContent = 'Tournaments';
      if (global.SLCRICK_SYNC) {
        const s = global.SLCRICK_SYNC.loadSettings();
        if (s.enabled) global.SLCRICK_SYNC.install();
      }
      setupPublishToggle();
    } else {
      document.getElementById('bs-publish-panel')?.setAttribute('hidden', '');
      if (railTitle) railTitle.textContent = 'All matches';
      if (railDesc) railDesc.textContent = 'Click a match → password → OBS URL & preview.';
    }

    ensureSocket();

    global.addEventListener('slcrick-live-update', refresh);
    global.addEventListener('slcrick-broadcast-status', onBroadcastStatus);
    if (global._cricproSocket) {
      global._cricproSocket.on('connect', onBroadcastStatus);
      global._cricproSocket.on('disconnect', onBroadcastStatus);
    }

    await pullLatest();
    ensureSocket();

    if (operatorMode) {
      renderTournamentList();
      const tid = params.get('tournament') || params.get('tournamentId');
      if (tid) selectTournament(tid);
      else {
        const live = liveApi()?.getAnyLiveMatch();
        if (live) {
          selectedMatchId = live.id;
          selectedTournamentId = live.tournamentId;
        }
      }
    } else {
      const matches = allFeedMatches();
      const live = matches.find((m) => statusKey(m) === 'live') || matches.find((m) => statusKey(m) === 'paused');
      const pick = params.get('match') || params.get('matchId') || live?.id || matches[0]?.id;
      if (pick) selectedMatchId = pick;
      renderWebCatalog();
    }

    refresh();

    if (!operatorMode) setInterval(refresh, 8000);
    else setInterval(onBroadcastStatus, 4000);
  }

  global.SLCRICK_BROADCAST_STATION = {
    init,
    refresh,
    syncNow,
    selectTournament,
    selectPublicMatch,
    copyUrl,
    submitUnlock,
    lockStudio,
  };
})(window);
