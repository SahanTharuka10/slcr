/**
 * SLCRICKPRO — OBS URLs, live preview (combined = scorebar + hotkeys in one Browser Source)
 * Tournament link: one URL per event — overlay auto-follows the live match.
 */
(function () {
  async function getBase() {
    if (window.SLCRICK_BASE_URL) return window.SLCRICK_BASE_URL;
    if (window.desktopAPI?.getBaseUrl) {
      window.SLCRICK_BASE_URL = await window.desktopAPI.getBaseUrl();
      return window.SLCRICK_BASE_URL;
    }
    return window.location.origin || '';
  }

  function currentMatchIds() {
    const m = typeof currentMatch !== 'undefined' ? currentMatch : null;
    return {
      matchId: m?.id || null,
      tournamentId: m?.tournamentId || null,
    };
  }

  const SCOREBAR_THEME_MAP = { theme1: 4, theme2: 2, theme3: 3, theme4: 4 };
  const OBS_FULL_HEIGHT = 1080;
  const PUBLIC_SITE = 'https://slcrickpro.live';

  function getSavedScorebarTheme() {
    try {
      return localStorage.getItem('cricpro_scorebar_theme') || 'theme1';
    } catch (_) {
      return 'theme1';
    }
  }

  function scorebarStripHeightForTheme(theme) {
    return theme === 'theme2' ? 120 : theme === 'theme3' ? 90 : 280;
  }

  function scorebarObsSizeLabel(theme) {
    const h = scorebarStripHeightForTheme(theme || getSavedScorebarTheme());
    if (theme === 'theme2') return `1920×${h} (Scorecard 2 — strip only)`;
    if (theme === 'theme3') return `1920×${h} (Manual bar — strip only)`;
    return `1920×${h} (Classic — strip only)`;
  }

  function combinedObsSizeLabel() {
    return `1920×${OBS_FULL_HEIGHT} (scorebar + hotkeys)`;
  }

  /** Prefer tournament-only query so OBS URLs never change between matches. */
  function buildOverlayQuery(matchId, tournamentId, layer, extra) {
    const q = ['obs=1'];
    if (layer) q.push('layer=' + encodeURIComponent(layer));
    if (tournamentId) {
      q.push('tournament=' + encodeURIComponent(tournamentId));
    }
    if (matchId) {
      q.push('matchId=' + encodeURIComponent(matchId));
      q.push('match=' + encodeURIComponent(matchId));
    }
    if (extra) q.push(extra);
    return q.join('&');
  }

  function hasObsContext() {
    const { matchId, tournamentId } = currentMatchIds();
    return !!(tournamentId || matchId);
  }

  /** Full overlay on slcrickpro.live — share via site (WebSocket + cloud sync) */
  window.getObsWebsiteUrl = async function (matchId, tournamentId, themeOverride) {
    const ids = currentMatchIds();
    const theme = themeOverride || getSavedScorebarTheme();
    const mid = matchId || ids.matchId;
    const tid = tournamentId || ids.tournamentId;
    const live = window.SLCRICK_LIVE;
    if (live?.buildShareOverlayUrl && mid) {
      return live.buildShareOverlayUrl(mid, theme, tid);
    }
    const q = ['obs=1', 'layer=combined', 'theme=' + encodeURIComponent(theme)];
    if (mid) q.push('matchId=' + encodeURIComponent(mid));
    if (tid) q.push('tournament=' + encodeURIComponent(tid));
    return PUBLIC_SITE + '/pages/overlay.html?' + q.join('&');
  };

  window.openObsWebsitePreview = async function () {
    const { matchId, tournamentId } = currentMatchIds();
    const url = await window.getObsWebsiteUrl(matchId, tournamentId);
    if (!url) {
      if (typeof showToast === 'function') showToast('Start a live match first', 'error');
      return;
    }
    window.open(url, '_blank', 'noopener');
  };

  /** Full OBS frame: scorebar + 4/6/W, profiles, wicket cards, etc. */
  window.getObsCombinedUrl = async function (matchId, tournamentId, themeOverride) {
    const base = await getBase();
    const ids = currentMatchIds();
    const theme = themeOverride || getSavedScorebarTheme();
    return (
      base +
      '/pages/overlay.html?' +
      buildOverlayQuery(
        matchId || ids.matchId,
        tournamentId || ids.tournamentId,
        'combined',
        'theme=' + encodeURIComponent(theme)
      )
    );
  };

  window.getObsOverlayUrl = window.getObsCombinedUrl;

  window.getObsTournamentUrl = window.getObsCombinedUrl;

  window.getObsScorebarUrl = async function (matchId, tournamentId, themeOverride) {
    const base = await getBase();
    const ids = currentMatchIds();
    const theme = themeOverride || getSavedScorebarTheme();
    return (
      base +
      '/pages/overlay.html?' +
      buildOverlayQuery(
        matchId || ids.matchId,
        tournamentId || ids.tournamentId,
        'scorebar',
        'strip=1&theme=' + encodeURIComponent(theme)
      )
    );
  };

  window.getScorebarObsHeight = function (theme) {
    return scorebarStripHeightForTheme(theme || getSavedScorebarTheme());
  };

  window.refreshObsScorebarUrls = async function () {
    await window.refreshObsSetupPanel();
    if (typeof window.refreshBroadcastPreview === 'function') {
      window.refreshBroadcastPreview();
    }
  };

  /** @deprecated Use getObsCombinedUrl — kept alias for older buttons */
  window.getObsHotkeysUrl = window.getObsCombinedUrl;

  window.copyObsWebsiteUrl = async function () {
    if (!hasObsContext()) {
      if (typeof showToast === 'function') showToast('Start a tournament match first', 'error');
      return;
    }
    const { matchId, tournamentId } = currentMatchIds();
    const url = await window.getObsWebsiteUrl(matchId, tournamentId);
    try {
      await navigator.clipboard.writeText(url);
      if (typeof showToast === 'function') {
        showToast('Site overlay URL copied — share via slcrickpro.live (Publish ON)', 'success');
      }
    } catch (_) {
      if (typeof showToast === 'function') showToast(url, 'default');
    }
    ['obs-setup-url-website', 'obs-url-website'].forEach((id) => {
      const inp = document.getElementById(id);
      if (inp) inp.value = url;
    });
    return url;
  };

  window.copyObsCombinedUrl = async function () {
    if (!hasObsContext()) {
      if (typeof showToast === 'function') showToast('Start a tournament match first', 'error');
      return;
    }
    const { matchId, tournamentId } = currentMatchIds();
    const url = await window.getObsCombinedUrl(matchId, tournamentId);
    try {
      await navigator.clipboard.writeText(url);
      const hint = tournamentId
        ? `OBS URL copied (${combinedObsSizeLabel()}) — scorebar + hotkeys · tournament link`
        : `OBS URL copied — ${combinedObsSizeLabel()}, transparent`;
      if (typeof showToast === 'function') showToast(hint, 'success');
    } catch (_) {
      if (typeof showToast === 'function') showToast(url, 'default');
    }
    ['obs-setup-url-combined', 'obs-url-combined', 'obs-setup-url-hotkeys', 'obs-url-hotkeys'].forEach((id) => {
      const inp = document.getElementById(id);
      if (inp) inp.value = url;
    });
    return url;
  };

  window.copyObsScorebarUrl = async function () {
    if (!hasObsContext()) {
      if (typeof showToast === 'function') showToast('Start a tournament match first', 'error');
      return;
    }
    const { matchId, tournamentId } = currentMatchIds();
    const url = await window.getObsScorebarUrl(matchId, tournamentId);
    try {
      await navigator.clipboard.writeText(url);
      const hint = tournamentId
        ? `Strip-only URL copied (${scorebarObsSizeLabel(getSavedScorebarTheme())})`
        : `Scorebar strip URL copied — ${scorebarObsSizeLabel(getSavedScorebarTheme())}`;
      if (typeof showToast === 'function') showToast(hint, 'success');
    } catch (_) {
      if (typeof showToast === 'function') showToast(url, 'default');
    }
    ['obs-setup-url-scorebar', 'obs-url-scorebar'].forEach((id) => {
      const inp = document.getElementById(id);
      if (inp) inp.value = url;
    });
    return url;
  };

  window.copyObsHotkeysUrl = window.copyObsCombinedUrl;

  window.copyObsLink = window.copyObsCombinedUrl;

  window.setupObsQuick = async function () {
    if (!hasObsContext()) {
      if (typeof showToast === 'function') showToast('Score a match first', 'error');
      return;
    }
    await window.copyObsCombinedUrl();
    const m = typeof currentMatch !== 'undefined' ? currentMatch : null;
    if (m && window.desktopAPI?.broadcastCommand) {
      const theme = getSavedScorebarTheme();
      const modeNum = SCOREBAR_THEME_MAP[theme] || 4;
      window.desktopAPI.broadcastCommand({
        cmd: 'SYNC_SCORE',
        data: { match: m, matchId: m.id },
        matchId: m.id,
        tournamentId: m.tournamentId || null,
        timestamp: Date.now(),
      });
      window.desktopAPI.broadcastCommand({
        cmd: 'SET_OVERLAY_MODE',
        data: { mode: modeNum },
        matchId: m.id,
        tournamentId: m.tournamentId || null,
        timestamp: Date.now(),
      });
      window.desktopAPI.publishMatch(m);
    }
    if (window.desktopAPI?.openObsOverlay) {
      const { matchId, tournamentId } = currentMatchIds();
      window.desktopAPI.openObsOverlay({ matchId, tournamentId, layer: 'combined' });
    }
    if (typeof showToast === 'function') {
      showToast(
        'OBS URL copied — one Browser Source 1920×1080 (scorebar + all graphics)',
        'success'
      );
    }
    if (typeof window.refreshBroadcastPreview === 'function') window.refreshBroadcastPreview();
  };

  window.openObsOverlayForMatch =
    window.openObsOverlayForMatch ||
    async function (matchId, tournamentId) {
      if (window.desktopAPI?.openObsOverlay) {
        return window.desktopAPI.openObsOverlay({ matchId, tournamentId, layer: 'combined' });
      }
    };

  function postToPreviewIframes(payload) {
    const ids = [
      'broadcast-preview-combined',
      'broadcast-preview-hotkeys',
      'broadcast-preview-scorebar',
      'broadcast-preview-frame',
    ];
    ids.forEach((id) => {
      const f = document.getElementById(id);
      if (f?.contentWindow) {
        f.contentWindow.postMessage({ type: 'cricpro_broadcast_cmd', payload }, '*');
      }
    });
  }

  window.forwardBroadcastToPreviews = function (payload) {
    postToPreviewIframes(payload);
  };

  function scalePreviewFrame(frame, wrap, baseW, baseH, scale) {
    if (!frame || !wrap) return;
    const h = Math.round(baseH * scale);
    wrap.style.height = h + 'px';
    frame.style.position = 'absolute';
    frame.style.left = '0';
    frame.style.bottom = '0';
    frame.style.top = 'auto';
    frame.style.width = baseW + 'px';
    frame.style.height = baseH + 'px';
    frame.style.transform = `scale(${scale})`;
    frame.style.transformOrigin = 'bottom left';
  }

  window.scaleBroadcastPreview = function () {
    const composite = document.getElementById('broadcast-preview-composite');
    if (!composite) return;
    const w = composite.clientWidth || 640;
    const scale = w / 1920;
    const totalH = Math.round(OBS_FULL_HEIGHT * scale);
    composite.style.height = totalH + 'px';

    const wrapHk = document.getElementById('preview-wrap-hotkeys');
    const frame =
      document.getElementById('broadcast-preview-combined') ||
      document.getElementById('broadcast-preview-hotkeys');
    if (wrapHk) {
      wrapHk.style.display = 'block';
      wrapHk.style.position = 'absolute';
      wrapHk.style.inset = '0';
      wrapHk.style.height = '100%';
      wrapHk.style.zIndex = '3';
    }
    const wrapSb = document.getElementById('preview-wrap-scorebar');
    if (wrapSb) wrapSb.style.display = 'none';

    scalePreviewFrame(frame, wrapHk, 1920, OBS_FULL_HEIGHT, scale);

    const single = document.getElementById('broadcast-preview-frame');
    const singleWrap = document.getElementById('preview-wrap-single');
    if (single && singleWrap) {
      scalePreviewFrame(single, singleWrap, 1920, OBS_FULL_HEIGHT, scale);
    }
  };

  window.refreshBroadcastPreview = async function () {
    const m = typeof currentMatch !== 'undefined' ? currentMatch : null;
    const mId = m?.id || null;
    const tId = m?.tournamentId || null;
    const base = await getBase();
    const theme = getSavedScorebarTheme();

    const combinedUrl =
      base +
      '/pages/overlay.html?' +
      buildOverlayQuery(mId, tId, 'combined', 'theme=' + encodeURIComponent(theme) + '&preview=1');

    const noMatch = document.getElementById('preview-no-match');
    const hasMatch = !!mId;
    if (noMatch) noMatch.style.display = hasMatch ? 'none' : 'flex';

    const syncPayload = {
      type: 'cricpro_broadcast_cmd',
      payload: {
        cmd: 'SYNC_SCORE',
        data: { match: m, matchId: m?.id },
        matchId: m?.id,
        tournamentId: tId,
        timestamp: Date.now(),
      },
    };

    const loadFrame = (id, url) => {
      const iframe = document.getElementById(id);
      if (!iframe) return;
      const sync = () => {
        if (iframe.contentWindow && m) {
          iframe.contentWindow.postMessage(syncPayload, '*');
        }
      };
      if (!iframe.src || !iframe.src.includes('overlay.html') || iframe.src !== url) {
        iframe.onload = () => {
          setTimeout(sync, 90);
          window.scaleBroadcastPreview();
        };
        iframe.src = url;
      } else if (m) {
        setTimeout(sync, 40);
      }
    };

    loadFrame('broadcast-preview-combined', combinedUrl);
    loadFrame('broadcast-preview-hotkeys', combinedUrl);
    window.scaleBroadcastPreview();

    if (m?.innings && typeof syncBroadcastMasterPhotos === 'function') {
      syncBroadcastMasterPhotos(m);
    }
    if (m?.innings) {
      const inn = m.innings[m.currentInnings || 0] || { runs: 0, wickets: 0, balls: 0 };
      const scoreEl = document.getElementById('bm-score-indicator');
      const vsEl = document.getElementById('bm-vs-indicator');
      if (scoreEl) scoreEl.textContent = `${inn.runs}/${inn.wickets}`;
      if (vsEl) vsEl.textContent = 'Overlay linked';
      const t1lbl = document.getElementById('btn-team1-label');
      const t2lbl = document.getElementById('btn-team2-label');
      if (t1lbl) t1lbl.textContent = m.team1 || 'TEAM A';
      if (t2lbl) t2lbl.textContent = m.team2 || 'TEAM B';
    }
  };

  window.openObsSetupModal = function () {
    const modal = document.getElementById('modal-obs-setup');
    if (modal) modal.style.display = 'flex';
    window.refreshObsSetupPanel();
  };

  window.closeObsSetupModal = function () {
    const modal = document.getElementById('modal-obs-setup');
    if (modal) modal.style.display = 'none';
  };

  function setObsUrlFields(ids, value) {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = value || '';
    });
  }

  window.refreshObsSetupPanel = async function () {
    const { matchId, tournamentId } = currentMatchIds();
    if (!hasObsContext()) {
      setObsUrlFields(
        [
          'obs-setup-url-scorebar',
          'obs-url-scorebar',
          'obs-setup-url-combined',
          'obs-url-combined',
          'obs-setup-url-hotkeys',
          'obs-url-hotkeys',
          'obs-setup-url-website',
          'obs-url-website',
        ],
        ''
      );
      return;
    }
    const combinedUrl = await window.getObsCombinedUrl(matchId, tournamentId);
    const websiteUrl = await window.getObsWebsiteUrl(matchId, tournamentId);
    const sbUrl = await window.getObsScorebarUrl(matchId, tournamentId);
    setObsUrlFields(['obs-setup-url-combined', 'obs-url-combined'], combinedUrl);
    setObsUrlFields(['obs-setup-url-hotkeys', 'obs-url-hotkeys'], combinedUrl);
    setObsUrlFields(['obs-setup-url-website', 'obs-url-website'], websiteUrl);
    setObsUrlFields(['obs-setup-url-scorebar', 'obs-url-scorebar'], sbUrl);
    const sizeHint = document.getElementById('obs-scorebar-size-hint');
    const sizeHintModal = document.getElementById('obs-setup-size-hint');
    if (sizeHint) sizeHint.textContent = '1920×1080';
    if (sizeHintModal) sizeHintModal.textContent = '1920×1080';
  };

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (hasObsContext()) window.refreshObsSetupPanel();
      window.refreshBroadcastPreview();
    }, 1200);
    setInterval(() => {
      const panel = document.getElementById('obs-setup-panel');
      if (panel && panel.style.display !== 'none') {
        window.refreshObsSetupPanel();
      }
    }, 12000);
  });

  window.addEventListener('resize', () => {
    if (document.getElementById('panel-hotkeys')?.style.display === 'block') {
      window.scaleBroadcastPreview();
    }
  });
})();
