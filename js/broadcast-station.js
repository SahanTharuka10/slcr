/**
 * SLCRICKPRO Broadcast Station
 * - Site: desktop live mirror → password → OBS URL + preview only
 * - Desktop operator: tournament list + full OBS tools
 */
(function (global) {
  let selectedTournamentId = null;
  let selectedMatchId = null;
  let activeLiveMatch = null;
  let operatorMode = false;

  function liveApi() {
    if (!global.SLCRICK_LIVE) {
      console.error('[BroadcastStation] SLCRICK_LIVE missing — load live-sync.js');
      return null;
    }
    return global.SLCRICK_LIVE;
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

  function resolveLiveMatch() {
    const L = liveApi();
    if (!L) return null;
    return L.getAnyLiveMatch?.() || null;
  }

  function overlayUrlForMatch(match, extra) {
    const L = liveApi();
    if (!L || !match) return '';
    const theme = getTheme();
    const tid = match.tournamentId;
    const parts = 'strip=1&theme=' + encodeURIComponent(theme) + (extra || '');
    return L.buildOverlayUrl({
      tournamentId: tid,
      matchId: match.id,
      layer: 'scorebar',
      extra: parts,
    });
  }

  function setIframe(frameId, url, heightPx) {
    const frame = document.getElementById(frameId);
    if (!frame || !url) return;
    if (heightPx) frame.style.height = heightPx + 'px';
    if (frame.src !== url) frame.src = url;
  }

  function renderLiveBanner(elId, match) {
    const el = document.getElementById(elId);
    if (!el || !match) return;
    const t = global.DB?.getTournament(match.tournamentId);
    const tName = t?.name ? `<span class="bs-banner-tourn">${esc(t.name)}</span>` : '';
    el.innerHTML = `${tName}<strong>${esc(match.team1)} vs ${esc(match.team2)}</strong>
      <span class="bs-banner-score">${esc(scoreLine(match))}</span>
      <span class="bs-banner-status">${statusLabel(match)}</span>`;
  }

  function showPublicState(state) {
    ['bs-idle', 'bs-gate', 'bs-studio'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== state;
    });
  }

  function refreshPublic() {
    if (operatorMode) return;
    activeLiveMatch = resolveLiveMatch();
    const match = activeLiveMatch;
    const L = liveApi();

    if (!match) {
      showPublicState('bs-idle');
      return;
    }

    const tid = match.tournamentId;
    const theme = getTheme();
    const h = stripHeight(theme);
    const previewUrl = overlayUrlForMatch(match, '&preview=1');
    L?.joinTournament(tid);
    L?.joinMatch(match.id);

    const unlocked =
      !tournamentLocked(global.DB?.getTournament(tid)) || isBroadcastUnlocked(tid);

    if (unlocked) {
      showPublicState('bs-studio');
      renderLiveBanner('bs-studio-banner', match);
      const label = document.getElementById('bs-studio-preview-label');
      if (label) label.textContent = `Live — ${match.team1} vs ${match.team2}`;
      setIframe('bs-studio-preview-frame', previewUrl, h);
      const urlEl = document.getElementById('bs-url-overlay');
      if (urlEl) urlEl.value = overlayUrlForMatch(match, '');
      return;
    }

    showPublicState('bs-gate');
    renderLiveBanner('bs-live-banner', match);
    const gateLabel = document.getElementById('bs-gate-preview-label');
    if (gateLabel) gateLabel.textContent = `Live from desktop — ${match.team1} vs ${match.team2}`;
    setIframe('bs-gate-preview-frame', previewUrl, h);
    const unlockCard = document.getElementById('bs-unlock-card');
    if (unlockCard) unlockCard.style.display = '';
  }

  async function submitUnlock(ev) {
    if (ev) ev.preventDefault();
    const match = activeLiveMatch || resolveLiveMatch();
    if (!match?.tournamentId) {
      showToast?.('No live match', 'error');
      return false;
    }
    const tid = match.tournamentId;
    const pw = (document.getElementById('bs-password')?.value || '').trim();
    const errEl = document.getElementById('bs-unlock-error');
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    if (!pw) {
      if (errEl) {
        errEl.textContent = 'Enter the tournament scoring password.';
        errEl.hidden = false;
      }
      return false;
    }

    const t = global.DB?.getTournament(tid);
    const localPw = t?.scoringPassword || t?.password;
    if (localPw && pw === localPw) {
      markBroadcastUnlocked(tid, pw);
      showToast?.('✅ Unlocked', 'success');
      refreshPublic();
      return false;
    }

    if (typeof global.DB?.handshake === 'function') {
      showToast?.('🔐 Verifying…', 'default');
      const result = await global.DB.handshake(tid, pw);
      if (result?.ok) {
        markBroadcastUnlocked(tid, pw);
        localStorage.setItem('tourn_pw_' + tid, pw);
        showToast?.('✅ Unlocked', 'success');
        refreshPublic();
        return false;
      }
      if (errEl) {
        errEl.textContent = result?.error || 'Wrong password';
        errEl.hidden = false;
      }
      showToast?.('❌ Wrong password', 'error');
      return false;
    }

    if (errEl) {
      errEl.textContent = 'Could not verify — check connection.';
      errEl.hidden = false;
    }
    return false;
  }

  function lockStudio() {
    const tid = activeLiveMatch?.tournamentId;
    if (tid) clearBroadcastUnlock(tid);
    refreshPublic();
    showToast?.('OBS link locked', 'default');
  }

  // ─── Operator mode (desktop) ─────────────────────────────────────────────

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
        '<div class="bs-empty">No tournaments yet. <button type="button" class="btn btn-primary btn-sm" onclick="SLCRICK_BROADCAST_STATION.syncNow()">Sync now</button></div>';
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
    const L = liveApi();
    const mid = selectedMatchId || L?.getLiveMatchForTournament(tid)?.id;
    if (!tid || !L) {
      scoreEl.value = '';
      hotEl.value = '';
      return;
    }
    const extra = 'strip=1&theme=' + encodeURIComponent(theme);
    scoreEl.value = L.buildOverlayUrl({ tournamentId: tid, matchId: mid, layer: 'scorebar', extra });
    hotEl.value = L.buildOverlayUrl({ tournamentId: tid, matchId: mid, layer: 'hotkeys' });
    if (siteEl) {
      siteEl.textContent = 'Public URLs: ' + (L.PUBLIC_SITE || 'https://slcrickpro.live');
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
    const live = L?.getLiveMatchForTournament(tid);
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
        : 'Preview — select or start a live match';
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

  function refreshOperator() {
    if (!operatorMode) return;
    renderTournamentList();
    if (selectedTournamentId) {
      renderMatchList();
      updatePreview();
      updateObsUrls();
    }
  }

  // ─── Shared ──────────────────────────────────────────────────────────────

  async function syncNow() {
    const btn = document.getElementById('bs-btn-sync');
    if (btn) btn.disabled = true;
    try {
      await pullLatest();
      showToast?.('✅ Synced with cloud', 'success');
      refresh();
    } catch (e) {
      showToast?.('Sync failed — check connection', 'error');
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
    if (operatorMode) refreshOperator();
    else refreshPublic();
  }

  function enableOperatorUi() {
    operatorMode = true;
    const pub = document.getElementById('bs-public');
    if (pub) pub.hidden = true;
    const op = document.getElementById('bs-operator');
    if (op) op.hidden = false;
    const back = document.getElementById('bs-back-link');
    if (back) {
      back.href = 'score-match.html?tab=hotkeys';
      back.textContent = '← Hotkeys';
    }
  }

  async function init() {
    const params = new URLSearchParams(global.location.search);
    operatorMode =
      !!global.SLCRICK_DESKTOP || params.get('operator') === '1' || params.get('full') === '1';

    if (operatorMode) {
      enableOperatorUi();
      ensureDesktopCloudSync();
      const warn = document.getElementById('bs-sync-warn');
      if (warn && global.SLCRICK_SYNC && !global.SLCRICK_SYNC.isEnabled()) warn.style.display = 'block';
    }

    if (global.SLCRICK_LIVE?.install) global.SLCRICK_LIVE.install({ force: true });
    await pullLatest();

    global.addEventListener('slcrick-live-update', refresh);

    if (operatorMode) {
      renderTournamentList();
      const tid = params.get('tournament') || params.get('tournamentId');
      if (tid) selectTournament(tid);
      return;
    }

    refreshPublic();
    setInterval(() => {
      if (!operatorMode) refreshPublic();
    }, 8000);
  }

  global.SLCRICK_BROADCAST_STATION = {
    init,
    refresh,
    syncNow,
    selectTournament,
    selectMatch,
    copyUrl,
    submitUnlock,
    lockStudio,
  };
})(window);
