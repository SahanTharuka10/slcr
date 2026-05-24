let matchId = null;
let tournId = null;
let isMasterOverlay = false;
/** 'all' | 'scorebar' | 'hotkeys' | 'combined' — split OBS browser sources */
let overlayLayer = 'all';

// ── GSAP fallback (CDN blocked in OBS / offline) — still show graphics ──
function installGsapFallback() {
    if (typeof gsap !== 'undefined' && gsap.version && gsap.version !== 'fallback') return;

    function applyTo(el, vars) {
        if (!el || !vars) return;
        if (vars.opacity !== undefined) el.style.opacity = String(vars.opacity);
        if (vars.x !== undefined) {
            const x = typeof vars.x === 'string' ? vars.x : vars.x + 'px';
            el.style.transform = (el.style.transform || '').replace(/translateX\([^)]*\)/, '') + ` translateX(${x})`;
        }
        if (vars.y !== undefined) {
            const y = typeof vars.y === 'string' ? vars.y : vars.y + 'px';
            el.style.transform = (el.style.transform || '').replace(/translateY\([^)]*\)/, '') + ` translateY(${y})`;
        }
        if (vars.scale !== undefined) {
            el.style.transform = `scale(${vars.scale})`;
        }
        if (vars.scaleX !== undefined) el.style.transform = `scaleX(${vars.scaleX})`;
        if (vars.boxShadow !== undefined) el.style.boxShadow = vars.boxShadow;
    }

    window.gsap = {
        version: 'fallback',
        set(target, vars) {
            const el = typeof target === 'string' ? document.querySelector(target) : target;
            applyTo(el, vars);
            return this;
        },
        killTweensOf() { return this; },
        timeline() {
            const steps = [];
            return {
                to(target, vars) { steps.push({ target, vars, type: 'to' }); return this; },
                fromTo(target, fromVars, toVars) { steps.push({ target, fromVars, toVars, type: 'fromTo' }); return this; },
                play() {
                    steps.forEach((s, i) => {
                        const delay = (s.vars?.delay || s.toVars?.delay || 0) * 1000 + i * 50;
                        setTimeout(() => {
                            const el = typeof s.target === 'string' ? document.querySelector(s.target) : s.target;
                            if (s.type === 'fromTo') applyTo(el, s.fromVars);
                            applyTo(el, s.toVars || s.vars);
                            if ((s.toVars || s.vars)?.onComplete) setTimeout(s.toVars.onComplete, ((s.toVars || s.vars).duration || 0.5) * 1000);
                        }, delay);
                    });
                },
            };
        },
        fromTo(target, fromVars, toVars) {
            const el = typeof target === 'string' ? document.querySelector(target) : target;
            applyTo(el, fromVars);
            const dur = (toVars.duration || 0.55) * 1000;
            const delay = (toVars.delay || 0) * 1000;
            setTimeout(() => {
                applyTo(el, toVars);
                if (toVars.onComplete) setTimeout(toVars.onComplete, dur);
            }, delay);
            return this;
        },
        to(target, toVars) {
            const el = typeof target === 'string' ? document.querySelector(target) : target;
            const dur = (toVars.duration || 0.55) * 1000;
            const delay = (toVars.delay || 0) * 1000;
            setTimeout(() => {
                applyTo(el, toVars);
                if (toVars.onComplete) setTimeout(toVars.onComplete, dur);
            }, delay);
            return this;
        },
    };
    console.warn('⚠️ GSAP fallback — hotkey graphics use simplified motion');
}
installGsapFallback();

let _lastBroadcastCmdTs = 0;
let _lastBroadcastCmdSig = '';
let _lastPollMatchTs = 0;
let _pollMatchInFlight = false;
let _lastRenderedScoreKey = '';
let _lastOverlayFingerprint = '';
let _lastCloudMatchUpdated = 0;
/** Match draw full-screen — cleared by STOP ALL / STOP_MATCH_DRAW / other hotkeys */
let _matchDrawOnAir = false;

/** OBS hides .broadcast-overlay unless .overlay-visible — stamp every popup */
function stampBroadcastOverlay(el) {
    if (!el) return el;
    el.classList.add('overlay-visible');
    if (document.body.classList.contains('obs-capture-mode')) {
        const flexHost =
            el.classList.contains('bo-graphic-row') ||
            el.classList.contains('last-wicket-overlay') ||
            el.classList.contains('be-dock-overlay') ||
            el.classList.contains('crr-float-overlay') ||
            el.classList.contains('next-match-overlay') ||
            el.classList.contains('runs-balls-overlay') ||
            el.style.display === 'flex';
        el.style.setProperty('display', flexHost ? 'flex' : 'block', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
    }
    return el;
}

function applyBroadcastPayload(payload) {
    if (!payload || !payload.cmd) return;
    const ts = payload.timestamp || payload.relayTs || Date.now();
    const sig = `${payload.cmd}|${ts}`;

    if (payload.matchId && !matchId) matchId = payload.matchId;
    if (payload.matchId && matchId && payload.matchId !== matchId) {
        const dataMid = payload.data?.match?.id || payload.data?.matchId;
        const incoming = payload.data?.match;
        if (dataMid === matchId) {
            /* same match via nested data */
        } else if (tournId && incoming && overlayMatchInTournament(incoming)) {
            matchId = incoming.id || payload.matchId;
        } else if (
            tournId &&
            typeof DB !== 'undefined' &&
            overlayMatchInTournament(DB.getMatch(payload.matchId))
        ) {
            matchId = payload.matchId;
        } else if (document.body.classList.contains('preview-embedded')) {
            matchId = payload.matchId;
        } else if (!tournId) {
            return;
        }
    }
    if (payload.tournamentId && !tournId) tournId = payload.tournamentId;

    if (sig === _lastBroadcastCmdSig) return;
    if (ts && ts <= _lastBroadcastCmdTs) return;
    _lastBroadcastCmdTs = ts;
    _lastBroadcastCmdSig = sig;
    handleBroadcastCommand(payload.cmd, payload.data || {});
}

function pollBroadcastCommands() {
    try {
        const raw = localStorage.getItem('cricpro_broadcast_cmd');
        if (raw) applyBroadcastPayload(JSON.parse(raw));
    } catch (_) {}
}

async function pollBroadcastApi() {
    try {
        const base = window.location.origin || '';
        const res = await fetch(base + '/api/broadcast?_=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        applyBroadcastPayload(payload);
    } catch (_) {}
}

/** Site / remote OBS (slcrickpro.live) — not Electron and not loopback */
function shouldUseCloudLive() {
    if (window.desktopAPI) return false;
    const h = (window.location.hostname || '').toLowerCase();
    return h !== 'localhost' && h !== '127.0.0.1';
}

function cloudBackendUrl() {
    if (window.SLCRICK_LIVE?.backendUrl) return window.SLCRICK_LIVE.backendUrl();
    if (window.SLCRICK_SYNC?.getBackendUrl) {
        const u = window.SLCRICK_SYNC.getBackendUrl();
        if (u) return u.replace(/\/$/, '');
    }
    return (window.CRICPRO_CLOUD_CONFIG?.backendUrl || 'https://slcrickpro.onrender.com').replace(/\/$/, '');
}

function overlayScoreKey(m) {
    const inn = m?.innings?.[m.currentInnings || 0];
    if (!inn) return '';
    const overLen = (inn.currentOver || []).length;
    return `${m.currentInnings}|${inn.runs}|${inn.wickets}|${inn.balls}|${inn.strikerIdx}|${inn.currentBowlerIdx}|${overLen}`;
}

function overlayNeedsRender(m, container) {
    if (!m || !container) return true;
    const fp = overlayMatchFingerprint(m);
    const scoreKey = overlayScoreKey(m);
    const hasBar =
        container.querySelector('.m2-pro-bar') ||
        container.querySelector('.m4-bar-wrapper') ||
        container.querySelector('.m3-left');
    if (hasBar && fp === _lastOverlayFingerprint && scoreKey === _lastRenderedScoreKey) {
        return false;
    }
    _lastOverlayFingerprint = fp;
    _lastRenderedScoreKey = scoreKey;
    return true;
}

function hydrateOverlayMediaFromMatch(m) {
    if (!m || typeof DB === 'undefined') return;
    if (m.teamPhotos && typeof m.teamPhotos === 'object') {
        Object.entries(m.teamPhotos).forEach(([teamName, photo]) => {
            if (photo) DB.saveTeamPhoto(teamName, photo, m.tournamentId);
        });
    }
    const inn = m.innings?.[m.currentInnings || 0];
    if (!inn) return;
    (inn.batsmen || []).forEach((b) => {
        if (b?.playerId && b.photo) DB.savePlayerPhoto(b.playerId, b.photo);
    });
    (inn.bowlers || []).forEach((b) => {
        if (b?.playerId && b.photo) DB.savePlayerPhoto(b.playerId, b.photo);
    });
}

function overlayMatchFingerprint(m) {
    if (!m) return '';
    const inn = m.innings?.[m.currentInnings || 0];
    if (!inn) return String(m.lastUpdated || 0);
    const bat = (inn.batsmen || [])
        .map((b) => `${b.playerId}|${b.name}|${b.runs}|${b.balls}|${(b.photo || '').length}`)
        .join(';');
    const bowl = (inn.bowlers || [])
        .map((b) => `${b.playerId}|${b.name}|${b.wickets}|${b.runs}|${b.balls}`)
        .join(';');
    return [
        m.lastUpdated,
        m.currentInnings,
        inn.runs,
        inn.wickets,
        inn.balls,
        inn.strikerIdx,
        inn.currentBowlerIdx,
        bat,
        bowl,
    ].join('|');
}

function applyCloudScorePayload(data) {
    if (!data) return;
    const m = data.fullMatch || (data.id ? data : null);
    if (!m || !m.id) return;
    if (tournId && m.tournamentId && m.tournamentId !== tournId) return;
    if (isMasterOverlay && matchId && matchId !== m.id) {
        matchId = m.id;
        window.SLCRICK_LIVE?.joinMatch?.(matchId);
        window.SLCRICK_REALTIME?.joinMatch?.(matchId);
    } else if (!matchId || isMasterOverlay) {
        matchId = m.id;
    }
    latestSocketScore = data.score
        ? data
        : { fullMatch: m, score: m.innings?.[m.currentInnings || 0] };
    latestSocketScoreTime = Date.now();
    hydrateOverlayMediaFromMatch(m);
    if (typeof DB !== 'undefined' && DB.saveMatch) {
        window._desktopApplyingRemoteMatch = true;
        DB.saveMatch(m, true, { skipPublish: true, skipForceUpdate: true });
        window._desktopApplyingRemoteMatch = false;
    }
    const fp = overlayMatchFingerprint(m);
    const ts = m.lastUpdated || Date.now();
    const scoreKey = overlayScoreKey(m);
    const changed =
        fp !== _lastOverlayFingerprint ||
        ts > _lastCloudMatchUpdated ||
        scoreKey !== _lastRenderedScoreKey;
    if (changed) {
        _lastOverlayFingerprint = fp;
        _lastCloudMatchUpdated = ts;
        _lastRenderedScoreKey = scoreKey;
        renderOverlay();
    }
}

async function fetchCloudMatchSnapshot() {
    if (!matchId || !shouldUseCloudLive()) return;
    const api = cloudBackendUrl();
    if (!api) return;
    try {
        const r = await fetch(`${api}/match/${encodeURIComponent(matchId)}`, {
            cache: 'no-store',
        });
        if (!r.ok) return;
        const body = await r.json();
        const m = body.fullMatch || body.match;
        if (m?.id) applyCloudScorePayload({ fullMatch: m, score: body.score });
    } catch (e) {
        console.warn('[overlay] GET /match failed', e);
    }
}

async function installCloudOverlayLive() {
    if (!shouldUseCloudLive()) return;
    const SL = window.SLCRICK_LIVE;
    const RT = window.SLCRICK_REALTIME;
    if (!SL || !RT) return;

    document.body.classList.add('cloud-overlay-live');

    try {
        SL.install({ force: true });
        await RT.connect?.();
    } catch (e) {
        console.warn('[overlay] cloud connect', e);
    }

    await fetchCloudMatchSnapshot();

    if (matchId) SL.joinMatch(matchId);
    if (tournId) SL.joinTournament(tournId);

    const onScore = (data) => {
        const m = data?.fullMatch || data?.match || data;
        if (m?.id) {
            applyCloudScorePayload({
                fullMatch: m,
                score: data.score || m.innings?.[m.currentInnings || 0],
            });
        } else if (data?.id) applyCloudScorePayload({ fullMatch: data });
    };

    RT.on(RT.Events.SCORE_UPDATE, onScore);

    const sock = RT.socket;
    if (sock && !sock._cricproOverlayWired) {
        sock._cricproOverlayWired = true;
        sock.on('broadcast_command', (payload) => {
            if (!payload?.cmd) return;
            if (payload.data?.match) hydrateOverlayMediaFromMatch(payload.data.match);
            applyBroadcastPayload(payload);
        });
        sock.on('match-update', (evt) => {
            const m = evt?.match || evt?.data || evt;
            if (m?.id) onScore({ fullMatch: m });
        });
        sock.on('scoreUpdate', (data) => onScore(data));
    }

    if (window.SLCRICK_SYNC?.syncCloudData) {
        window.SLCRICK_SYNC.syncCloudData({ silent: true, forceRefresh: true }).catch(() => {});
    }

    window.addEventListener('slcrick-live-update', () => {
        const m =
            (matchId && typeof DB !== 'undefined' && DB.getMatch(matchId)) ||
            latestSocketScore?.fullMatch;
        if (m) applyCloudScorePayload({ fullMatch: m });
        else {
            pollServerScore();
            if (!matchId && tournId) pollMatchApi();
        }
    });

    setInterval(() => {
        if (matchId) fetchCloudMatchSnapshot();
        else if (tournId) pollMatchApi();
    }, 2000);
}

try {
    const searchStr = window.location.search || '';
    if (searchStr.includes('?')) {
        const urlParams = new URLSearchParams(searchStr);
        matchId = urlParams.get('match') || urlParams.get('matchId') || null;
        tournId = urlParams.get('tournament') || urlParams.get('tournamentId') || null;
        
        // Safety clean up to avoid any hashes breaking the ID
        if (matchId && matchId.includes('#')) matchId = matchId.split('#')[0];
        if (tournId && tournId.includes('#')) tournId = tournId.split('#')[0];
        const obsFlag = urlParams.get('obs') === '1';
        const previewFlag = urlParams.get('preview') === '1' || urlParams.get('preview') === 'true';
        if (tournId && obsFlag && !previewFlag) {
            matchId = null;
        }
    }
} catch (e) {
    console.error("URL Params Error safely caught:", e);
}

// Tournament URL or no match id → follow live match in that tournament automatically
if (!matchId) isMasterOverlay = true;
if (tournId) isMasterOverlay = true;

let refreshInterval;
let currentPopupView = null;
let latestSocketScore = null;
let latestSocketScoreTime = 0; 
let isScorebarVisible = true;
let currentOverlayMode = 4;
let currentSubMode = 1;

const OVERLAY_THEME_TO_MODE = { theme1: 4, theme2: 2, theme3: 3, theme4: 4 };

function overlayModeFromTheme(themeValue) {
    return OVERLAY_THEME_TO_MODE[themeValue] || 4;
}

(function initOverlayThemeFromStorage() {
    try {
        const params = new URLSearchParams(window.location.search || '');
        const themeParam = params.get('theme');
        if (themeParam) {
            currentOverlayMode = overlayModeFromTheme(themeParam);
            return;
        }
        const saved = localStorage.getItem('cricpro_scorebar_theme');
        if (saved && OVERLAY_THEME_TO_MODE[saved] != null) currentOverlayMode = OVERLAY_THEME_TO_MODE[saved];
    } catch (_) {}
})();

if (typeof OVERLAY_DEFAULT_PLAYER_PHOTO === 'undefined') {
    var OVERLAY_DEFAULT_PLAYER_PHOTO = '../assets/default-player.svg';
}

function overlaySquadHasCustomPhoto(photo) {
    const p = photo && String(photo).trim();
    if (!p || p.length < 12) return false;
    if (p.includes('default-player')) return false;
    return true;
}

function overlayPlayerInitials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return (parts[0] || '?').slice(0, 2).toUpperCase();
}

function overlayEscapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function overlayPlayerPhotoUrl(photo) {
    const p = photo && String(photo).trim();
    if (p && p.length > 10) return p;
    return OVERLAY_DEFAULT_PLAYER_PHOTO;
}

function overlayBuildTossLine(data) {
    if (data.tossLine) return data.tossLine;
    const winner = data.tossWinner || data.teamName || 'TEAM';
    const decision = (data.tossDecision || 'bat').toLowerCase();
    const action = decision.includes('bowl') ? 'BOWL' : 'BAT';
    return `${String(winner).toUpperCase()} WON THE TOSS AND CHOSE TO ${action}`;
}

function overlaySplitSquadRows(players) {
    const list = players.slice(0, 11);
    if (list.length <= 6) return [list, []];
    return [list.slice(0, 6), list.slice(6)];
}

function getShortName(fullName) {
    if (!fullName || typeof fullName !== 'string') return '';
    try {
        const parts = fullName.trim().split(' ');
        if (parts.length === 0) return '';
        if (parts.length === 1) return parts[0].substring(0, 3).toUpperCase();
        return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    } catch (e) {
        return '';
    }
}

/** Broadcast-style name: SADITH W */
function overlayDisplayName(fullName) {
    if (!fullName || typeof fullName !== 'string') return 'BATTER';
    const raw = fullName.trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0].toUpperCase()} ${parts[parts.length - 1][0].toUpperCase()}`;
    }
    return raw.toUpperCase();
}

function overlayResolvePlayerPhoto(player, role, matchCtx) {
    const m =
        matchCtx ||
        (typeof latestSocketScore !== 'undefined' && latestSocketScore?.fullMatch) ||
        (matchId && typeof DB !== 'undefined' ? DB.getMatch(matchId) : null);
    if (m?.broadcastLivePhotos?.[role]) {
        const lp = m.broadcastLivePhotos[role];
        if (lp && String(lp).length > 12) return overlayPlayerPhotoUrl(lp);
    }
    if (player?.photo && String(player.photo).length > 12) {
        return overlayPlayerPhotoUrl(player.photo);
    }
    if (typeof getBroadcastPhotoForRole === 'function') {
        const bound = getBroadcastPhotoForRole(role, player);
        if (bound) return overlayPlayerPhotoUrl(bound);
    }
    if (player?.playerId && typeof DB !== 'undefined' && DB.getPlayerPhoto) {
        return overlayPlayerPhotoUrl(DB.getPlayerPhoto(player.playerId));
    }
    return OVERLAY_DEFAULT_PLAYER_PHOTO;
}

function overlayTeamLogoUrl(teamName, tournamentId) {
    if (!teamName) return '../assets/default-team.svg';
    if (typeof DB !== 'undefined' && DB.getTeamPhoto) {
        const fromDb = DB.getTeamPhoto(teamName, tournamentId);
        if (fromDb && !String(fromDb).includes('default-team')) return fromDb;
    }
    return '../assets/default-team.svg';
}

function overlayTournamentSubtitle(m) {
    if (!m?.tournamentId || typeof DB === 'undefined' || !DB.getTournament) return '';
    const t = DB.getTournament(m.tournamentId);
    const name = (t?.name || t?.title || '').trim();
    return name ? name.toUpperCase() : '';
}

function overlayProjectedScore(curInn, m) {
    const bpo = m.ballsPerOver || 6;
    const maxOv = m.overs || 20;
    const runs = curInn?.runs ?? 0;
    const balls = curInn?.balls ?? 0;
    if (!balls) return runs;
    const oversDone = balls / bpo;
    if (oversDone <= 0) return runs;
    return Math.round((runs / oversDone) * maxOv);
}

function overlayRenderBallTrackerHtml(curInn, bpo) {
    const over = curInn?.currentOver || [];
    let html = '';
    for (let i = 0; i < bpo; i++) {
        const b = over[i];
        if (!b) {
            html += '<span class="m2-ball-dot m2-ball-dot--empty"></span>';
            continue;
        }
        if (b.wicket) {
            html += '<span class="m2-ball-dot m2-ball-dot--w">W</span>';
        } else if (b.runs >= 6) {
            html += `<span class="m2-ball-dot m2-ball-dot--6">${b.runs}</span>`;
        } else if (b.runs >= 4) {
            html += `<span class="m2-ball-dot m2-ball-dot--4">${b.runs}</span>`;
        } else {
            html += `<span class="m2-ball-dot">${b.runs}</span>`;
        }
    }
    return html;
}

function overlayBuildTossShort(m, bowlingTeam) {
    if (m.tossResult) return String(m.tossResult);
    const winner = m.tossWinner || '';
    const dec = (m.tossDecision || '').toLowerCase();
    if (!winner) return `Bowling : ${bowlingTeam || '—'}`;
    const action = dec.includes('bowl') || dec.includes('field') ? 'field' : 'bat';
    return `'${winner}', elected to ${action}`;
}

function formatOvers(balls, bpo = 6) {
    const ov = Math.floor(balls / bpo);
    const rem = balls % bpo;
    return `${ov}.${rem}`;
}

function formatCRR(runs, balls, bpo = 6) {
    if (!balls) return '0.00';
    return ((runs / balls) * bpo).toFixed(2);
}

function formatRequiredRR(inn, m) {
    if (!m || m.currentInnings !== 1 || !m.innings?.[0] || !inn) return null;
    const bpo = m.ballsPerOver || 6;
    const target = m.innings[0].runs + 1;
    const need = target - inn.runs;
    const ballsLeft = m.overs * bpo - inn.balls;
    if (ballsLeft <= 0 || need <= 0) return null;
    return ((need / ballsLeft) * bpo).toFixed(2);
}

function overlayMatchInTournament(m) {
    if (!m || !tournId) return true;
    return m.tournamentId === tournId;
}

document.addEventListener('DOMContentLoaded', () => {
    const urlParamsInit = new URLSearchParams(window.location.search || '');
    const isObsMode = urlParamsInit.get('obs') === '1';
    const isObsStrip = urlParamsInit.get('strip') === '1';
    const layerParam = urlParamsInit.get('layer');
    const isPreviewLayout = urlParamsInit.get('preview') === '1' || urlParamsInit.get('preview') === 'true';
    if (layerParam === 'scorebar' || layerParam === 'hotkeys' || layerParam === 'combined') {
        overlayLayer = layerParam;
    } else if (isObsStrip) {
        overlayLayer = 'scorebar';
    } else if (isObsMode && !layerParam) {
        overlayLayer = 'combined';
    }

    if (overlayLayer === 'combined') {
        document.body.classList.add('obs-layer-combined', 'obs-full-frame');
    }
    if (isPreviewLayout && window.parent !== window) {
        document.body.classList.add('preview-embedded');
    }

    if (overlayLayer === 'hotkeys') {
        isScorebarVisible = false;
        const oc = document.getElementById('overlay-container');
        if (oc) {
            oc.style.display = 'none';
            oc.innerHTML = '';
            oc.style.background = 'transparent';
        }
    }

    if (isObsMode) {
        const oc0 = document.getElementById('overlay-container');
        if (oc0) {
            oc0.style.background = 'transparent';
            oc0.style.backdropFilter = 'none';
            oc0.style.boxShadow = 'none';
        }
        installGsapFallback();
        document.body.classList.add('obs-capture-mode');
        document.documentElement.classList.add('obs-capture-mode');
        if (overlayLayer === 'scorebar' || isObsStrip) {
            document.body.classList.add('obs-strip-only', 'obs-layer-scorebar');
            if (currentOverlayMode === 2) document.body.classList.add('mode-2-active');
        }
        const themeParam = urlParamsInit.get('theme');
        if (themeParam) {
            try {
                localStorage.setItem('cricpro_scorebar_theme', themeParam);
            } catch (_) {}
        }
        if (overlayLayer === 'hotkeys') document.body.classList.add('obs-layer-hotkeys');
        document.querySelectorAll('.broadcast-overlay').forEach((el) => {
            el.classList.remove('overlay-visible');
            el.style.display = 'none';
        });
        const hideObsUi = () => {
            document.querySelectorAll('.tv-controls, .shortcut-menu').forEach(el => {
                el.style.display = 'none';
            });
        };
        hideObsUi();
        setTimeout(hideObsUi, 500);
    }

    // ── Previews & Scale ──────────────────────────────────
    const isPreview = urlParamsInit.get('preview');
    const inParentPreview = isPreview && window.parent !== window;
    if (isPreview && overlayLayer !== 'scorebar' && !inParentPreview) {
        document.body.classList.add('preview-mode');
        const scaleToFit = () => {
            const scale = window.innerWidth / 1920;
            document.body.style.width = '1920px';
            document.body.style.height = '1080px';
            document.body.style.transform = `scale(${scale})`;
            document.body.style.transformOrigin = 'bottom left';
            document.body.style.overflow = 'hidden';
            document.body.style.margin = '0';
        };
        window.addEventListener('resize', scaleToFit);
        setTimeout(scaleToFit, 10);
    }
    if (inParentPreview) {
        document.documentElement.style.background = 'transparent';
        document.body.style.width = '1920px';
        document.body.style.height = '1080px';
        document.body.style.margin = '0';
        document.body.style.overflow = 'hidden';
    }

    if (!matchId && !tournId && !isMasterOverlay) {
        document.getElementById('overlay-container').innerHTML = '<div style="padding: 20px; color: red;">No Match or Tournament ID!</div>';
        return;
    }

    function applyDesktopMatchUpdate(match) {
        if (!match || !match.id) return;
        if (tournId && match.tournamentId !== tournId) return;
        if (!isMasterOverlay && matchId && matchId !== match.id) return;
        if (isMasterOverlay && matchId !== match.id) matchId = match.id;
        applyCloudScorePayload({ fullMatch: match, score: match.innings?.[match.currentInnings] });
    }

    if (window.desktopAPI) {
        window.desktopAPI.onMatchUpdate(applyDesktopMatchUpdate);
        window.desktopAPI.onBroadcastCommand((payload) => {
            if (payload) applyBroadcastPayload(payload);
        });
        window.desktopAPI.onStorageRestored(() => {
            pollServerScore();
            renderOverlay();
        });
    } else {
        installCloudOverlayLive();
    }

    if (typeof BroadcastChannel !== 'undefined') {
        try {
            const liveBC = new BroadcastChannel('cricpro_live');
            liveBC.onmessage = (ev) => {
                if (!ev.data || ev.data.type !== 'score_update') return;
                if (window.desktopAPI) return;
                pollServerScore();
            };
        } catch (_) {}
    }

    window.addEventListener('slcrick-db-ready', () => {
        pollServerScore();
        pollMatchApi();
        renderOverlay();
    });

    async function pollMatchApi() {
        if (!matchId && !isMasterOverlay) return;
        if (overlayLayer === 'hotkeys') return;
        const now = Date.now();
        if (_pollMatchInFlight || now - _lastPollMatchTs < 700) return;
        _pollMatchInFlight = true;
        _lastPollMatchTs = now;
        try {
            const useCloud = shouldUseCloudLive();
            const base = useCloud ? cloudBackendUrl() : window.location.origin || '';
            if (!base) return;

            let url;
            const qs = ['_=' + now];
            if (useCloud) {
                if (isMasterOverlay && tournId && !matchId) {
                    url = `${base}/api/active-match?tournamentId=${encodeURIComponent(tournId)}&${qs.join('&')}`;
                } else if (matchId) {
                    url = `${base}/tv/matches/${encodeURIComponent(matchId)}/light?${qs.join('&')}`;
                } else return;
            } else {
                url = base + '/api/live-match';
                if (tournId && (isMasterOverlay || !matchId)) {
                    qs.push('tournament=' + encodeURIComponent(tournId));
                } else if (matchId && !isMasterOverlay) {
                    url = base + '/api/match/' + encodeURIComponent(matchId);
                }
                url = url + '?' + qs.join('&');
            }

            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (useCloud) {
                if (data?.error) return;
                applyCloudScorePayload(data);
                return;
            }
            const m = data;
            if (!m || !m.id) return;
            if (tournId && m.tournamentId && m.tournamentId !== tournId) return;
            if (!matchId || isMasterOverlay) matchId = m.id;
            latestSocketScore = {
                fullMatch: m,
                score: m.innings?.[m.currentInnings || 0],
            };
            if (typeof DB !== 'undefined' && DB.saveMatch) {
                window._desktopApplyingRemoteMatch = true;
                DB.saveMatch(m, true, { skipPublish: true, skipForceUpdate: true });
                window._desktopApplyingRemoteMatch = false;
            }
            const scoreKey = overlayScoreKey(m);
            if (scoreKey !== _lastRenderedScoreKey) {
                applyCloudScorePayload({
                    fullMatch: m,
                    score: m.innings?.[m.currentInnings || 0],
                });
            }
        } catch (_) {
        } finally {
            _pollMatchInFlight = false;
        }
    }

    function pollServerScore() {
        if (window.desktopAPI) return;
        if (!matchId && !isMasterOverlay) return;
        if (typeof DB === 'undefined') return;

        if (!matchId && isMasterOverlay) {
            const live = DB.getMatches().find(
                (m) =>
                    (m.status === 'live' || m.status === 'paused') &&
                    overlayMatchInTournament(m)
            );
            if (live) {
                applyCloudScorePayload({ fullMatch: live, score: live.innings?.[live.currentInnings] });
                return;
            }
        }
        const localMatch = matchId ? DB.getMatch(matchId) : null;
        if (localMatch) {
            applyCloudScorePayload({
                fullMatch: localMatch,
                score: localMatch.innings?.[localMatch.currentInnings],
            });
        }
    }

    const inPreviewIframe = isPreview && window.parent !== window;
    const onDesktop = !!window.desktopAPI;
    const pollTick = () => {
        pollBroadcastCommands();
        if (!inPreviewIframe && !onDesktop) pollBroadcastApi();
        if (currentPopupView) return;
        if (!inPreviewIframe && !onDesktop) pollMatchApi();
        if (!inPreviewIframe && !onDesktop) pollServerScore();
    };
    if (!inPreviewIframe) {
        pollTick();
        const pollMs = onDesktop ? 2500 : isObsMode ? 900 : 600;
        setInterval(pollTick, pollMs);
    }

    let _storagePollTimer = null;
    window.addEventListener('storage', (e) => {
        if (e.key === 'cricpro_scorebar_theme' && e.newValue) {
            currentOverlayMode = overlayModeFromTheme(e.newValue);
            if (currentOverlayMode === 2) document.body.classList.add('mode-2-active');
            else document.body.classList.remove('mode-2-active');
            _lastOverlayFingerprint = '';
            renderOverlay();
        }
        if (e.key === 'cricpro_force_update' || e.key === 'cricpro_broadcast_cmd') {
            if (_storagePollTimer) clearTimeout(_storagePollTimer);
            _storagePollTimer = setTimeout(() => {
                _storagePollTimer = null;
                if (e.key === 'cricpro_broadcast_cmd') {
                    try {
                        const payload = JSON.parse(localStorage.getItem('cricpro_broadcast_cmd') || 'null');
                        if (payload?.cmd) applyBroadcastPayload(payload);
                    } catch (_) {}
                } else if (!onDesktop) {
                    pollServerScore();
                }
            }, 40);
        }
    });

    // ── Clock ─────────────────────────────────────────────
    setInterval(() => {
        const elements = document.querySelectorAll('#overlay-live-clock');
        if (elements.length === 0) return;
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
        elements.forEach(el => { if (el.textContent !== timeStr) el.textContent = timeStr; });
    }, 1000);

    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'cricpro_broadcast_cmd' && e.data.payload) {
            applyBroadcastPayload(e.data.payload);
        }
    });
});

function handleBroadcastCommand(cmd, data = {}) {
    if (!cmd) return;

    const scorebarOnlyCmds = new Set([
        'SYNC_SCORE', 'SYNC_MATCH', 'FORCE_UPDATE', 'SET_SCOREBAR_VISIBILITY',
        'TOGGLE_SCOREBAR', 'STOP_ALL', 'STOP_OVERLAY', 'CLEAR_STAY_OVERLAYS', 'STOP_BROADCAST',
        'SHOW_LAST_WICKET', 'SHOW_BIG_EVENT', 'SHOW_CRR',
    ]);
    if (overlayLayer === 'scorebar' && !scorebarOnlyCmds.has(cmd)) return;
    if (overlayLayer === 'hotkeys' && (cmd === 'SET_SCOREBAR_VISIBILITY' || cmd === 'TOGGLE_SCOREBAR' || cmd === 'SET_OVERLAY_MODE')) return;

    const requiresGsap = [
        'SHOW_RUNS_BALLS', 'SHOW_NEXT_MATCH', 'SHOW_LAST_WICKET', 'SHOW_SCORECARD', 'SHOW_SUMMARY',
        'SHOW_CRR', 'SET_SCOREBAR_VISIBILITY', 'SET_OVERLAY_MODE', 'SET_OVERLAY_SUBMODE',
        'SHOW_TEAM_CARD', 'SHOW_TEAM_ROSTER', 'SHOW_BIG_EVENT', 'SHOW_STRIKER_PROFILE',
        'SHOW_NON_STRIKER_PROFILE', 'SHOW_BOWLER_PROFILE', 'SHOW_PARTNERSHIP',
        'SHOW_BATTER_PROFILES', 'SHOW_GUEST', 'STOP_OVERLAY', 'CLEAR_STAY_OVERLAYS', 'STOP_ALL',
        'SHOW_MATCH_DRAW', 'STOP_MATCH_DRAW'
    ];
    installGsapFallback();

    if (cmd === 'STOP_OVERLAY' || cmd === 'CLEAR_STAY_OVERLAYS' || cmd === 'STOP_ALL' || cmd === 'STOP_BROADCAST') {
        hideAllBroadcastOverlays();
        isScorebarVisible = true;
        renderOverlay();
        return;
    }

    const drawSafeCmds = new Set([
        'SHOW_MATCH_DRAW', 'STOP_MATCH_DRAW', 'SYNC_SCORE', 'SYNC_MATCH', 'FORCE_UPDATE',
        'SET_SCOREBAR_VISIBILITY', 'TOGGLE_SCOREBAR', 'SET_OVERLAY_MODE', 'SET_OVERLAY_SUBMODE',
    ]);
    if (_matchDrawOnAir && !drawSafeCmds.has(cmd)) {
        hideMatchDrawOverlay(false);
    }
    if (cmd === 'FORCE_UPDATE') {
        renderOverlay();
        return;
    }
    if (cmd === 'TOGGLE_SCOREBAR' || cmd === 'SET_SCOREBAR_VISIBILITY') {
        if (cmd === 'SET_SCOREBAR_VISIBILITY') isScorebarVisible = !!data.visible;
        else isScorebarVisible = !isScorebarVisible;
        renderOverlay();
        return;
    }

    switch (cmd) {
        case 'SHOW_RUNS_BALLS': showRunsBallsGraphic(data); break;
        case 'SHOW_NEXT_MATCH': showNextMatchGraphic(data); break;
        case 'SHOW_LAST_WICKET': showLastWicketGraphic(data); break;
        case 'SHOW_SCORECARD': toggleBroadcastScorecard(data.matchId || matchId); break;
        case 'SHOW_SUMMARY': toggleBroadcastSummary(data.tournamentId || tournId); break;
        case 'SHOW_CRR': showCRRGraphic(data); break;
        case 'SYNC_MATCH':
        case 'SYNC_SCORE':
            if (data.matchId) {
                matchId = data.matchId;
                if (window._cricproSocket) window._cricproSocket.emit('join_match', matchId);
            }
            if (data.match) {
                matchId = data.match.id;
                latestSocketScore = { fullMatch: data.match };
                if (data.match.isManual && data.match.manualData) {
                    const manual = data.match.manualData;
                    latestSocketScore.fullMatch.currentInnings = 0;
                    latestSocketScore.fullMatch.overs = parseInt(manual.overs, 10) || latestSocketScore.fullMatch.overs || 0;
                    latestSocketScore.fullMatch.ballsPerOver = 6;
                    latestSocketScore.fullMatch.innings = latestSocketScore.fullMatch.innings || [{
                        battingTeam: manual.team1 || 'TEAM A',
                        bowlingTeam: manual.team2 || 'TEAM B',
                        runs: parseInt(manual.runs, 10) || 0,
                        wickets: parseInt(manual.wickets, 10) || 0,
                        balls: parseInt(manual.overs, 10) || 0,
                        batsmen: [
                            { name: manual.striker || 'Batter', runs: parseInt(manual.runs, 10) || 0, balls: 0 },
                            { name: manual.nonStriker || 'Batter', runs: 0, balls: 0 }
                        ],
                        bowlers: [{ name: manual.bowler || 'Bowler', wickets: 0, runs: 0, balls: 0 }],
                        currentBatsmenIdx: [0,1],
                        strikerIdx: 0,
                        currentBowlerIdx: 0
                    }];
                }
                if (typeof DB !== 'undefined' && DB.saveMatch) DB.saveMatch(latestSocketScore.fullMatch);
                if (overlayLayer !== 'hotkeys') renderOverlay();
            }
            break;
        case 'SET_SCOREBAR_VISIBILITY':
            isScorebarVisible = !!data.visible;
            renderOverlay();
            break;
        case 'SET_OVERLAY_MODE': {
            const mode = parseInt(data.mode, 10);
            currentOverlayMode = mode === 2 || mode === 3 || mode === 4 ? mode : 4;
            renderOverlay();
            break;
        }
        case 'SET_OVERLAY_SUBMODE':
            currentSubMode = parseInt(data.subMode) || 1;
            renderOverlay();
            break;
        case 'SHOW_TEAM_CARD': showTeamCardGraphic(data); break;
        case 'SHOW_TEAM_ROSTER': showTeamRosterGraphic(data); break;
        case 'SHOW_BIG_EVENT': showBigEventGraphic(data); break;
        case 'SHOW_STRIKER_PROFILE': showStrikerProfileLeft(data, 'STRIKER'); break;
        case 'SHOW_NON_STRIKER_PROFILE': showStrikerProfileLeft(data, 'NON-STRIKER'); break;
        case 'SHOW_BOWLER_PROFILE': showBowlerProfileGraphic(data); break;
        case 'SHOW_PARTNERSHIP': showPartnershipGraphicCinema(data); break;
        case 'SHOW_BATTER_PROFILES': showBatterProfilesGraphic(data); break;
        case 'SHOW_GUEST': showGuestGraphic(data); break;
        case 'SHOW_MATCH_DRAW': showMatchDrawOverlay(data); break;
        case 'STOP_MATCH_DRAW': hideMatchDrawOverlay(); break;
    }
}

function showMatchDrawOverlay(data) {
    const wrap = document.getElementById('broadcast-match-draw');
    const frame = document.getElementById('match-draw-frame');
    if (!wrap || !frame || !data?.draw) return;

    hideAllBroadcastOverlays(true);
    _matchDrawOnAir = true;

    const scorebar = document.getElementById('overlay-container');
    if (scorebar) scorebar.style.display = 'none';

    wrap.style.display = 'block';
    wrap.classList.add('overlay-visible', 'overlay-stay');

    const sendState = () => {
        try {
            if (frame.contentWindow) {
                frame.contentWindow.postMessage({ type: 'cricpro_match_draw_state', state: data.draw }, '*');
            }
        } catch (_) { /* ignore */ }
    };

    const onReady = (e) => {
        if (e.data?.type === 'cricpro_match_draw_ready') sendState();
    };
    window.addEventListener('message', onReady);

    if (frame._drawLoaded && frame.contentWindow) {
        sendState();
        return;
    }

    frame.onload = () => {
        frame._drawLoaded = true;
        sendState();
    };
    frame.src = 'match-draw.html?preview=1&overlay=1&tournament=' + encodeURIComponent(data.tournamentId || 'default');
}

function hideMatchDrawOverlay(restoreScorebar) {
    _matchDrawOnAir = false;
    const wrap = document.getElementById('broadcast-match-draw');
    const frame = document.getElementById('match-draw-frame');
    if (wrap) {
        wrap.style.display = 'none';
        wrap.classList.remove('overlay-visible', 'overlay-stay');
    }
    if (frame) {
        frame.src = 'about:blank';
        frame._drawLoaded = false;
    }
    if (restoreScorebar !== false) {
        const scorebar = document.getElementById('overlay-container');
        if (scorebar) scorebar.style.display = '';
        if (overlayLayer !== 'hotkeys') renderOverlay();
    }
}

function hideAllBroadcastOverlays(skipMatchDraw) {
    if (!skipMatchDraw) hideMatchDrawOverlay(true);
    clearTimeout(window._lastWicketHideTimer);
    clearTimeout(window._nextMatchHideTimer);
    clearTimeout(window._crrHideTimer);
    clearTimeout(window._bigEventHideTimer);
    const crrFloat = document.getElementById('broadcast-crr-float');
    if (crrFloat) {
        crrFloat.classList.remove('overlay-visible');
        crrFloat.style.display = 'none';
    }
    const beDock = document.getElementById('broadcast-big-event');
    if (beDock) {
        beDock.classList.remove('overlay-visible');
        beDock.style.display = 'none';
        beDock.innerHTML = '';
    }
    const overlaySelector = skipMatchDraw
        ? '.broadcast-overlay:not(#broadcast-match-draw)'
        : '.broadcast-overlay';
    try {
        const overlays = document.querySelectorAll(overlaySelector);
        if (overlays.length > 0 && typeof gsap !== 'undefined') {
            gsap.to(overlaySelector, { opacity: 0, scale: 0.9, duration: 0.4, onComplete: () => {
                document.querySelectorAll(overlaySelector).forEach((el) => {
                    if (el.id) {
                        el.classList.remove('overlay-visible', 'overlay-stay');
                        el.style.display = 'none';
                        gsap.set(el, { opacity: 1, scale: 1, x: 0, y: 0, clearProps: 'transform,opacity' });
                    } else {
                        el.remove();
                    }
                });
                document.querySelectorAll('.broadcast-team-squad').forEach((el) => el.remove());
            }});
        } else {
            overlays.forEach((el) => {
                if (el.id) {
                    el.classList.remove('overlay-visible', 'overlay-stay');
                    el.style.display = 'none';
                } else el.remove();
            });
        }
    } catch (err) {
        console.warn('Error hiding overlays:', err);
        document.querySelectorAll(overlaySelector).forEach((el) => {
            if (el.id) {
                el.classList.remove('overlay-visible', 'overlay-stay');
                el.style.display = 'none';
            } else el.remove();
        });
    }
}

function renderOverlay() {
    if (overlayLayer === 'hotkeys') return;

    let m = matchId && typeof DB !== 'undefined' ? DB.getMatch(matchId) : null;
    if (!m && latestSocketScore && latestSocketScore.fullMatch) {
        m = latestSocketScore.fullMatch;
        if (!matchId && latestSocketScore.fullMatch.id) {
            matchId = latestSocketScore.fullMatch.id;
        }
    }
    const container = document.getElementById('overlay-container');
    if (!m) {
        if (container && !container.querySelector('.obs-waiting')) {
            container.innerHTML =
                '<div class="obs-waiting" style="color:#fff;font-family:Outfit,sans-serif;font-weight:800;font-size:22px;padding:40px;text-align:center">Waiting for live match…<br><span style="font-size:13px;opacity:0.5">Score in SLCRICKPRO — overlay updates automatically</span></div>';
        }
        return;
    }
    
    if (!container) return;
    if (!isScorebarVisible) {
        container.innerHTML = '';
        return;
    }

    if (!overlayNeedsRender(m, container)) return;

    if (currentOverlayMode === 2) {
        document.body.classList.add('mode-2-active');
        _renderOverlayMode2(m);
    } else {
        document.body.classList.remove('mode-2-active');
        if (currentOverlayMode === 3) {
            _renderOverlayMode3(m);
        } else {
            _renderOverlayMode4(m);
        }
    }
}

let _m4PrevWickets = -1;

/**
 * Scorecard 2 (Modern) — TPL-style broadcast bar (green brand | batters | score | bowler+balls | purple brand)
 */
function _renderOverlayMode2(m) {
    const container = document.getElementById('overlay-container');
    const curInn = m.innings?.[m.currentInnings];
    if (!container || !curInn) return;

    container.className = 'mode-2';

    const batTeam = curInn.battingTeam || m.team1 || 'TEAM A';
    const bowlTeam = curInn.bowlingTeam || m.team2 || 'TEAM B';
    const batShort = getShortName(batTeam);
    const bowlShort = getShortName(bowlTeam);
    const batLogo = overlayTeamLogoUrl(batTeam, m.tournamentId);
    const bowlLogo = overlayTeamLogoUrl(bowlTeam, m.tournamentId);

    const siIdx =
        curInn.currentBatsmenIdx && typeof curInn.strikerIdx !== 'undefined'
            ? curInn.currentBatsmenIdx[curInn.strikerIdx]
            : null;
    const nsiIdx =
        curInn.currentBatsmenIdx && typeof curInn.strikerIdx !== 'undefined'
            ? curInn.currentBatsmenIdx[curInn.strikerIdx === 0 ? 1 : 0]
            : null;
    const striker =
        typeof siIdx === 'number' && curInn.batsmen?.[siIdx]
            ? curInn.batsmen[siIdx]
            : { name: 'Batter', runs: 0, balls: 0 };
    const nonStriker =
        typeof nsiIdx === 'number' && curInn.batsmen?.[nsiIdx]
            ? curInn.batsmen[nsiIdx]
            : { name: 'Batter', runs: 0, balls: 0 };
    const bowler =
        curInn.bowlers && curInn.currentBowlerIdx != null
            ? curInn.bowlers[curInn.currentBowlerIdx]
            : { name: 'Bowler', wickets: 0, runs: 0, balls: 0 };

    const bpo = m.ballsPerOver || 6;
    const ovCur = formatOvers(curInn.balls, bpo);
    const ovMax = m.overs || 20;
    const innLabel = (m.currentInnings === 0 ? '1st' : '2nd') + ' Inning';
    const scoreMain = `${curInn.runs} - ${curInn.wickets}`;
    const crrVal = formatCRR(curInn.runs, curInn.balls, bpo);
    const projected = overlayProjectedScore(curInn, m);

    const sPhoto = overlayResolvePlayerPhoto(striker, 'striker', m);
    const nsPhoto = overlayResolvePlayerPhoto(nonStriker, 'nonstriker', m);
    const bowlPhoto = overlayResolvePlayerPhoto(bowler, 'bowler', m);
    const defPhoto = overlayEscapeHtml(OVERLAY_DEFAULT_PLAYER_PHOTO);

    const batterCell = (pl, photo, isStriker) => `
        <div class="m2-batter-cell ${isStriker ? 'm2-batter-cell--on' : ''}">
            <div class="m2-player-text">
                <div class="m2-batter-line">
                    <span class="m2-batter-name" title="${overlayEscapeHtml(pl.name || '')}">${overlayEscapeHtml(overlayDisplayName(pl.name))}</span>
                    <span class="m2-batter-score">${pl.runs ?? 0}<span class="m2-batter-balls">(${pl.balls ?? 0})</span></span>
                </div>
            </div>
            <div class="m2-photo-ring">
                <img class="m2-photo" src="${overlayEscapeHtml(photo)}" alt="" loading="eager" decoding="async" onerror="this.onerror=null;this.src='${defPhoto}'">
            </div>
        </div>`;

    container.innerHTML = `
        <div class="m2-shell">
            <div class="m2-pro-bar">
                <div class="m2-brand m2-brand--bat">
                    <div class="m2-brand-logo">
                        <img src="${overlayEscapeHtml(batLogo)}" alt="" onerror="this.style.display='none'">
                        <span class="m2-logo-fallback">${overlayEscapeHtml(batShort)}</span>
                    </div>
                </div>
                <div class="m2-panel m2-panel--bat">
                    <div class="m2-batter-row">
                        ${batterCell(striker, sPhoto, true)}
                        ${batterCell(nonStriker, nsPhoto, false)}
                    </div>
                </div>
                <div class="m2-core">
                    <div class="m2-innings-tab">${overlayEscapeHtml(innLabel)}</div>
                    <div class="m2-teams-line">${overlayEscapeHtml(String(batTeam).toUpperCase())} <span class="m2-teams-vs">vs</span> ${overlayEscapeHtml(String(bowlTeam).toUpperCase())}</div>
                    <div class="m2-score-panel">
                        <span class="m2-team-badge">${overlayEscapeHtml(batShort)}</span>
                        <span class="m2-live-score">${overlayEscapeHtml(scoreMain)}</span>
                        <span class="m2-live-overs">${overlayEscapeHtml(ovCur)} <span class="m2-ov-max">(${ovMax} ov)</span></span>
                    </div>
                    <div class="m2-stats-strip">
                        <span>Projected Score : <strong>${projected}</strong></span>
                        <span class="m2-stats-sep">·</span>
                        <span>CRR : <strong>${crrVal}</strong></span>
                    </div>
                </div>
                <div class="m2-panel m2-panel--bowl">
                    <div class="m2-bowler-row">
                        <div class="m2-bowler-block">
                            <div class="m2-player-text">
                                <div class="m2-bowler-line">
                                    <span class="m2-bowler-name" title="${overlayEscapeHtml(bowler.name || '')}">${overlayEscapeHtml(overlayDisplayName(bowler.name))}</span>
                                    <span class="m2-bowler-fig">${bowler.wickets ?? 0} - ${bowler.runs ?? 0} <span class="m2-bowler-ov">${formatOvers(bowler.balls ?? 0, bpo)}</span></span>
                                </div>
                            </div>
                            <div class="m2-photo-ring m2-photo-ring--bowl">
                                <img class="m2-photo" src="${overlayEscapeHtml(bowlPhoto)}" alt="" loading="eager" decoding="async" onerror="this.onerror=null;this.src='${defPhoto}'">
                            </div>
                        </div>
                    </div>
                    <div class="m2-ball-track">${overlayRenderBallTrackerHtml(curInn, bpo)}</div>
                </div>
                <div class="m2-brand m2-brand--bowl">
                    <div class="m2-brand-logo">
                        <img src="${overlayEscapeHtml(bowlLogo)}" alt="" onerror="this.style.display='none'">
                        <span class="m2-logo-fallback">${overlayEscapeHtml(bowlShort)}</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.style.display = 'flex';
    container.style.visibility = 'visible';
    container.style.opacity = '1';
    if (document.body.classList.contains('obs-strip-only')) {
        document.body.classList.add('mode-2-active');
    }
}

/** Manual / detailed scorebar (theme 3) */
function _renderOverlayMode3(m) {
    const container = document.getElementById('overlay-container');
    if (!container) return;
    container.className = 'mode-3';

    let t1Short = 'T1';
    let t2Short = 'T2';
    let runs = 0;
    let wkts = 0;
    let overs = '0.0';
    let b1Name = 'Striker';
    let b1Runs = '0';
    let b1Balls = '0';
    let b2Name = 'Non-Striker';
    let b2Runs = '0';
    let b2Balls = '0';
    let bowlName = 'Bowler';
    let bowlWkts = '0';
    let bowlRuns = '0';
    let bowlOvers = '0.0';
    let crr = '0.0';
    let recent = [];

    if (m.isManual && m.manualData) {
        const d = m.manualData;
        t1Short = getShortName(d.team1 || 'TEAM A');
        t2Short = getShortName(d.team2 || 'TEAM B');
        runs = d.runs || 0;
        wkts = d.wickets || 0;
        overs = d.overs || '0.0';
        crr = d.target || '0.0';
        const parseBat = (raw, fallbackName) => {
            const m1 = String(raw || '').match(/^(.*?)\s*\((\d+)\/(\d+)\)$/);
            if (m1) return { name: m1[1], runs: m1[2], balls: m1[3] };
            return { name: raw || fallbackName, runs: '0', balls: '0' };
        };
        const b1 = parseBat(d.striker, 'Striker');
        const b2 = parseBat(d.nonStriker, 'Non-Striker');
        b1Name = b1.name;
        b1Runs = b1.runs;
        b1Balls = b1.balls;
        b2Name = b2.name;
        b2Runs = b2.runs;
        b2Balls = b2.balls;
        const mb = String(d.bowler || '').match(/^(.*?)\s*\((\d+\.?\d*)\/(\d+)\/(\d+)\)$/);
        if (mb) {
            bowlName = mb[1];
            bowlOvers = mb[2];
            bowlRuns = mb[3];
            bowlWkts = mb[4];
        } else {
            bowlName = d.bowler || 'Bowler';
        }
    } else {
        const curInn = m.innings?.[m.currentInnings];
        if (!curInn) {
            container.innerHTML = '<div class="obs-waiting">No innings data</div>';
            return;
        }
        const bpo = m.ballsPerOver || 6;
        t1Short = getShortName(curInn.battingTeam);
        t2Short = getShortName(curInn.bowlingTeam);
        runs = curInn.runs;
        wkts = curInn.wickets;
        overs = formatOvers(curInn.balls, bpo);
        const siIdx =
            curInn.currentBatsmenIdx && typeof curInn.strikerIdx !== 'undefined'
                ? curInn.currentBatsmenIdx[curInn.strikerIdx]
                : null;
        const b1 = typeof siIdx === 'number' && curInn.batsmen?.[siIdx] ? curInn.batsmen[siIdx] : null;
        if (b1) {
            b1Name = b1.name;
            b1Runs = b1.runs;
            b1Balls = b1.balls;
        }
        const bowl =
            curInn.bowlers && curInn.currentBowlerIdx != null
                ? curInn.bowlers[curInn.currentBowlerIdx]
                : null;
        if (bowl) {
            bowlName = bowl.name;
            bowlRuns = bowl.runs;
            bowlWkts = bowl.wickets;
            bowlOvers = formatOvers(bowl.balls, bpo);
        }
        crr = formatCRR(curInn.runs, curInn.balls, bpo);
        recent = (curInn.currentOver || []).slice(-8);
    }

    const recentHtml =
        recent.length > 0
            ? recent
                  .map((b) => {
                      const cls = b.wicket ? 'w' : b.runs >= 4 ? 'b' : '';
                      return `<span class="${cls}">${b.wicket ? 'W' : b.runs}</span>`;
                  })
                  .join('')
            : '<span class="m3-empty"></span>';

    container.innerHTML = `
        <div class="m3-left">
            <div class="m3-score">${runs}-${wkts} <small>${overs}</small></div>
            <div class="m3-teams">${overlayEscapeHtml(t1Short)} v ${overlayEscapeHtml(t2Short)}</div>
        </div>
        <div class="m3-center">
            <div class="m3-row">
                <span class="lbl">STR:</span> <span class="val">${overlayEscapeHtml(b1Name)}</span>
                <span class="lbl">RUNS:</span> <span class="val highlight">${b1Runs} (${b1Balls})</span>
            </div>
            <div class="m3-row">
                <span class="lbl">BWL:</span> <span class="val">${overlayEscapeHtml(bowlName)}</span>
                <span class="lbl">FIG:</span> <span class="val highlight">${bowlWkts}-${bowlRuns} (${bowlOvers})</span>
                <span class="lbl">CRR:</span> <span class="val" style="color:#fbbf24">${crr}</span>
            </div>
        </div>
        <div class="m3-right">
            <div class="m3-right-title">RECENT</div>
            <div class="m3-recent">${recentHtml}</div>
        </div>
    `;
}

function _renderOverlayMode4(m) {
    const container = document.getElementById('overlay-container');
    const curInn = m.innings[m.currentInnings];
    if (!curInn) return;
    
    container.className = 'mode-4';

    const t1Name = curInn.battingTeam || m.team1 || 'TEAM A';
    const t2Name = curInn.bowlingTeam || m.team2 || 'TEAM B';
    const t1Logo =
        (m.teamPhotos && m.teamPhotos[t1Name]) ||
        overlayTeamLogoUrl(t1Name, m.tournamentId);
    const t2Logo =
        (m.teamPhotos && m.teamPhotos[t2Name]) ||
        overlayTeamLogoUrl(t2Name, m.tournamentId);

    const strikerIdx = curInn.currentBatsmenIdx ? curInn.currentBatsmenIdx[curInn.strikerIdx] : null;
    const striker = (strikerIdx != null && curInn.batsmen[strikerIdx]) ? curInn.batsmen[strikerIdx] : { name: 'Batter', runs: 0, balls: 0 };
    
    const nonStrikerIdx = curInn.currentBatsmenIdx ? curInn.currentBatsmenIdx[curInn.strikerIdx === 0 ? 1 : 0] : null;
    const nonStriker = (nonStrikerIdx != null && curInn.batsmen[nonStrikerIdx]) ? curInn.batsmen[nonStrikerIdx] : { name: 'Batter', runs: 0, balls: 0 };
    
    const bowler = (curInn.bowlers && curInn.currentBowlerIdx != null) ? curInn.bowlers[curInn.currentBowlerIdx] : { name: 'Bowler', wickets: 0, runs: 0, balls: 0 };

    let effectiveSubMode = currentSubMode;
    if (m.currentInnings === 1 && effectiveSubMode === 1) effectiveSubMode = 3;

    let topText = `${curInn.wickets + 1}WKT PARTNERSHIP`;
    let botText = `TOSS: ${m.tossResult ? m.tossResult.toUpperCase() : 'N/A'}`;

    if (effectiveSubMode === 3) {
        if (m.currentInnings === 1 && m.innings[0]) {
            const target = m.innings[0].runs + 1;
            const needed = target - curInn.runs;
            const ballsLeft = (m.overs * m.ballsPerOver) - curInn.balls;
            topText = `TARGET: ${target}`;
            botText = `NEED ${needed} RUNS FROM ${ballsLeft} BALLS`;
        }
    } else if (effectiveSubMode === 2) {
        topText = `CURRENT RUN RATE`;
        botText = `CRR: ${crrVal}${rrrVal ? ` · REQ ${rrrVal}` : ''}`;
    }

    const recentBalls = (curInn.currentOver || []).slice(-6).map(b => {
        let cls = b.wicket ? 'w' : (b.runs >= 4 ? 'boundary' : 'run');
        if (b.runs === 6) cls = 'boundary six';
        return `<div class="m4-ball ${cls}">${b.wicket ? 'W' : b.runs}</div>`;
    }).join('');

    let flashClass = '';
    if (_m4PrevWickets !== -1 && curInn.wickets > _m4PrevWickets) {
        flashClass = 'm4-wicket-flash';
    }
    _m4PrevWickets = curInn.wickets;

    const bpo = m.ballsPerOver || 6;
    const crrVal = formatCRR(curInn.runs, curInn.balls, bpo);
    const rrrVal = formatRequiredRR(curInn, m);

    let wrapper = container.querySelector('.m4-bar-wrapper');
    if (!wrapper) {
        container.innerHTML = `
            <div class="m4-bar-wrapper">
                <aside class="m4-wing m4-wing--bat">
                    <div class="m4-logo-box">
                        <div class="m4-logo-circle m4-logo-circle--team">
                            <span id="m4-t1-short" class="m4-logo-fallback"></span>
                            <img id="m4-t1-logo" src="" alt="" onerror="this.style.display='none'">
                        </div>
                    </div>
                    <div class="m4-batsmen">
                        <div class="m4-player">
                            <span class="striker-mark" id="m4-s1-mark"></span>
                            <span class="m4-pname" id="m4-s1-name"></span>
                            <span class="m4-pruns" id="m4-s1-runs"></span>
                            <span class="m4-pballs" id="m4-s1-balls"></span>
                        </div>
                        <div class="m4-player">
                            <span class="striker-mark" id="m4-s2-mark"></span>
                            <span class="m4-pname" id="m4-s2-name"></span>
                            <span class="m4-pruns" id="m4-s2-runs"></span>
                            <span class="m4-pballs" id="m4-s2-balls"></span>
                        </div>
                    </div>
                </aside>
                <div class="m4-center-pill" id="m4-center-pill">
                    <div class="m4-pill-top" id="m4-pill-top"></div>
                    <div class="m4-pill-mid">
                        <span class="m4-teams" id="m4-teams-text"></span>
                        <span class="m4-score-box" id="m4-score-text"></span>
                        <span class="m4-phase-box">LIVE</span>
                        <span class="m4-overs" id="m4-overs-text"></span>
                    </div>
                    <div class="m4-pill-bot" id="m4-pill-bot"></div>
                </div>
                <aside class="m4-wing m4-wing--bowl">
                    <div class="m4-bowler-section">
                        <div class="m4-player m4-player--bowler">
                            <span class="striker-mark">▶</span>
                            <span class="m4-bname" id="m4-b-name"></span>
                            <span class="m4-bwickets" id="m4-b-wkts"></span>
                            <span class="m4-bovers" id="m4-b-overs"></span>
                        </div>
                    </div>
                    <div class="m4-recent-balls" id="m4-recent-balls" aria-hidden="true"></div>
                    <div class="m4-logo-box">
                        <div class="m4-logo-circle m4-logo-circle--team m4-logo-circle--dark">
                            <span id="m4-t2-short" class="m4-logo-fallback">${getShortName(t2Name)}</span>
                            <img id="m4-t2-logo" src="${t2Logo}" alt="" onerror="this.style.display='none'">
                        </div>
                    </div>
                </aside>
            </div>
        `;
    }

    // Update values only - no full innerHTML refresh
    const t1Short = document.getElementById('m4-t1-short');
    if (t1Short) t1Short.textContent = getShortName(t1Name);
    
    const t1Img = document.getElementById('m4-t1-logo');
    if (t1Img && t1Img.src !== new URL(t1Logo, document.baseURI).href) {
        t1Img.src = t1Logo;
        t1Img.style.display = 'block';
    }

    const s1Mark = document.getElementById('m4-s1-mark');
    if (s1Mark) s1Mark.textContent = curInn.strikerIdx === 0 ? '▶' : '';
    const s1Name = document.getElementById('m4-s1-name');
    if (s1Name) s1Name.textContent = (striker.name || 'Batter').toUpperCase();
    const s1Runs = document.getElementById('m4-s1-runs');
    if (s1Runs) s1Runs.textContent = striker.runs || 0;
    const s1Balls = document.getElementById('m4-s1-balls');
    if (s1Balls) s1Balls.textContent = striker.balls || 0;

    const s2Mark = document.getElementById('m4-s2-mark');
    if (s2Mark) s2Mark.textContent = curInn.strikerIdx === 1 ? '▶' : '';
    const s2Name = document.getElementById('m4-s2-name');
    if (s2Name) s2Name.textContent = (nonStriker.name || 'Batter').toUpperCase();
    const s2Runs = document.getElementById('m4-s2-runs');
    if (s2Runs) s2Runs.textContent = nonStriker.runs || 0;
    const s2Balls = document.getElementById('m4-s2-balls');
    if (s2Balls) s2Balls.textContent = nonStriker.balls || 0;

    const pTop = document.getElementById('m4-pill-top');
    if (pTop) pTop.textContent = topText;
    const tText = document.getElementById('m4-teams-text');
    if (tText) tText.innerHTML = `${t1Name || 'TEAM A'} <span class="v">v</span> ${t2Name || 'TEAM B'}`;
    const sText = document.getElementById('m4-score-text');
    if (sText) sText.textContent = `${curInn.runs}-${curInn.wickets}`;
    const oText = document.getElementById('m4-overs-text');
    if (oText) oText.textContent = formatOvers(curInn.balls, m.ballsPerOver);
    const pBot = document.getElementById('m4-pill-bot');
    if (pBot) pBot.textContent = botText;

    const bName = document.getElementById('m4-b-name');
    if (bName) bName.textContent = (bowler.name || 'Bowler').toUpperCase();
    const bWkts = document.getElementById('m4-b-wkts');
    if (bWkts) bWkts.textContent = `${bowler.wickets || 0}-${bowler.runs || 0}`;
    const bOvers = document.getElementById('m4-b-overs');
    if (bOvers) bOvers.textContent = formatOvers(bowler.balls, m.ballsPerOver);

    const rBalls = document.getElementById('m4-recent-balls');
    if (rBalls) rBalls.innerHTML = recentBalls;

    const t2Short = document.getElementById('m4-t2-short');
    if (t2Short) t2Short.textContent = getShortName(t2Name);
    const t2Img = document.getElementById('m4-t2-logo');
    if (t2Img && t2Img.src !== new URL(t2Logo, document.baseURI).href) {
        t2Img.src = t2Logo;
        t2Img.style.display = 'block';
    }

    if (flashClass) {
        const centerPill = document.getElementById('m4-center-pill');
        if (centerPill) {
            centerPill.classList.add('m4-wicket-flash');
            setTimeout(() => centerPill.classList.remove('m4-wicket-flash'), 1000);
        }
    }
}

function toggleBroadcastScorecard(mId) {
    const el = document.getElementById('broadcast-full-scorecard');
    if (!el) return;
    if (el.classList.contains('overlay-visible') || el.style.display === 'flex') {
        el.classList.remove('overlay-visible');
        gsap.to(el, { opacity: 0, scale: 0.95, duration: 0.5, onComplete: () => { el.style.display = 'none'; } });
    } else {
        const m = DB.getMatch(mId || matchId);
        if (m) {
            renderFullScorecardOverlay(m);
            el.classList.add('overlay-visible');
            el.style.display = 'flex';
            gsap.fromTo(el, { opacity: 0, scale: 0.95 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'expo.out' });
        }
    }
}

function renderFullScorecardOverlay(m) {
    const el = document.getElementById('fs-content');
    if (!el) return;
    
    const inn = m.innings[m.currentInnings] || m.innings[0];
    if (!inn) return;

    let batsHtml = (inn.batsmen || []).map(b => `
        <div style="display:grid; grid-template-columns: 1fr 60px 60px; padding:12px 20px; border-bottom:1px solid rgba(255,255,255,0.05); font-weight:700;">
            <div style="color:#fff;">${b.name.toUpperCase()} <small style="color:#aaa; font-weight:400; margin-left:10px;">${b.outDesc || 'not out'}</small></div>
            <div style="text-align:right; color:#ffd700;">${b.runs}</div>
            <div style="text-align:right; opacity:0.6;">${b.balls}</div>
        </div>
    `).join('');

    let bowlHtml = (inn.bowlers || []).map(b => `
        <div style="display:grid; grid-template-columns: 1fr 60px 60px 60px; padding:12px 20px; border-bottom:1px solid rgba(255,255,255,0.05); font-weight:700; opacity:0.9;">
            <div style="color:#fff;">${b.name.toUpperCase()}</div>
            <div style="text-align:right;">${formatOvers(b.balls)}</div>
            <div style="text-align:right; color:#38bdf8;">${b.runs}</div>
            <div style="text-align:right; color:#ff1744;">${b.wickets}</div>
        </div>
    `).join('');

    el.innerHTML = `
        <div style="background:rgba(26, 35, 126, 0.9); padding:25px; border-radius:15px; margin-bottom:20px; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <div style="font-size:14px; opacity:0.7; letter-spacing:2px;">NOW BATTING</div>
                <div style="font-size:36px; font-weight:950; color:#fff;">${inn.battingTeam.toUpperCase()}</div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:48px; font-weight:950; color:#ffd700;">${inn.runs}/${inn.wickets} <small style="font-size:24px; color:#fff; opacity:0.6;">(${formatOvers(inn.balls)})</small></div>
            </div>
        </div>
        <div class="fs-grid">
            <div class="fs-column" style="background:rgba(0,0,0,0.2); border-radius:15px; overflow:hidden;">
                <div style="background:rgba(255,255,255,0.1); padding:10px 20px; font-size:12px; font-weight:900; letter-spacing:2px; color:#aaa;">BATSMEN</div>
                ${batsHtml}
            </div>
            <div class="fs-column" style="background:rgba(0,0,0,0.2); border-radius:15px; overflow:hidden;">
                <div style="background:rgba(255,255,255,0.1); padding:10px 20px; font-size:12px; font-weight:900; letter-spacing:2px; color:#aaa;">BOWLERS</div>
                ${bowlHtml}
            </div>
        </div>
    `;
}

function showTeamCardGraphic(data) {
    if (!data || !data.teamName) return;
    document.querySelectorAll('.broadcast-team-squad, .broadcast-team-card').forEach((el) => el.remove());

    const players = (data.players || [])
        .slice(0, 11)
        .map((p, i) => {
            const name = (p.name || p.playerName || '').trim();
            if (!name) return null;
            const rawPhoto = p.photo || p.playerPhoto || '';
            const hasPhoto = overlaySquadHasCustomPhoto(rawPhoto);
            return {
                name,
                photo: hasPhoto ? rawPhoto : OVERLAY_DEFAULT_PLAYER_PHOTO,
                hasPhoto,
                initials: overlayPlayerInitials(name),
                isCaptain: !!(p.isCaptain || p.captain || (i === 0 && data.markFirstCaptain)),
                role: p.role || '',
            };
        })
        .filter(Boolean);
    if (players.length === 0) return;

    const [row1, row2] = overlaySplitSquadRows(players);
    const opponent = data.opponentName || data.opponent || 'OPPONENT';
    const teamName = data.teamName;
    const matchTitle = `${overlayEscapeHtml(teamName)} <span class="ts-vs">Vs</span> ${overlayEscapeHtml(opponent)}`;
    const subtitle = overlayEscapeHtml(data.subtitle || data.matchInfo || data.tournamentLine || 'Live Match');
    const tossLine = overlayEscapeHtml(overlayBuildTossLine(data));
    const formatLabel = overlayEscapeHtml((data.formatLabel || data.format || 'CRICKET').toUpperCase());
    const siteLabel = overlayEscapeHtml(data.siteLabel || 'SLCRICKPRO');
    const logoUrl = data.teamLogo && String(data.teamLogo).trim() ? data.teamLogo : '';
    const defaultPhotoEsc = overlayEscapeHtml(OVERLAY_DEFAULT_PLAYER_PHOTO);

    const playerCardHtml = (p) => `
        <div class="ts-player-card${p.isCaptain ? ' ts-player-card--captain' : ''}">
            ${p.isCaptain ? '<span class="ts-captain" title="Captain">C</span>' : ''}
            <div class="ts-photo-wrap${p.hasPhoto ? '' : ' ts-photo-wrap--default'}">
                <img class="ts-photo-img" src="${overlayEscapeHtml(p.photo)}" alt="" loading="eager"
                    onerror="this.onerror=null;this.src='${defaultPhotoEsc}';this.closest('.ts-photo-wrap')?.classList.add('ts-photo-wrap--default');">
                ${p.hasPhoto ? '' : `<span class="ts-initials" aria-hidden="true">${overlayEscapeHtml(p.initials)}</span>`}
            </div>
            <div class="ts-player-name">${overlayEscapeHtml(p.name)}</div>
        </div>`;

    const rowHtml = (row) => (row.length ? `<div class="ts-row">${row.map(playerCardHtml).join('')}</div>` : '');

    const el = document.createElement('div');
    el.className = 'broadcast-overlay broadcast-team-squad overlay-visible overlay-stay';
    el.setAttribute('data-stay', '1');
    el.innerHTML = `
        <div class="ts-backdrop" aria-hidden="true"></div>
        <div class="ts-wrap-outer">
            <div class="ts-format-badge" aria-hidden="true">
                <div class="ts-format-disc">${formatLabel.slice(0, 3)}</div>
            </div>
            <div class="ts-panel">
                <header class="ts-header">
                    <div class="ts-header-shine" aria-hidden="true"></div>
                    <div class="ts-header-logo">
                        ${logoUrl
                            ? `<img src="${overlayEscapeHtml(logoUrl)}" alt="" onerror="this.outerHTML='<span class=ts-fallback-odi>${formatLabel.slice(0, 3)}</span>'">`
                            : `<span class="ts-fallback-odi">${formatLabel.slice(0, 3)}</span>`}
                    </div>
                    <div class="ts-header-text">
                        <div class="ts-match-title">${matchTitle}</div>
                        <div class="ts-match-sub">${subtitle}</div>
                    </div>
                    <div class="ts-header-site">${siteLabel}</div>
                </header>
                <div class="ts-body">
                    ${rowHtml(row1)}
                    ${rowHtml(row2)}
                </div>
                <footer class="ts-footer"><span class="ts-footer-text">${tossLine}</span></footer>
            </div>
        </div>
    `;

    document.body.appendChild(stampBroadcastOverlay(el));

    const panel = el.querySelector('.ts-panel');
    const header = el.querySelector('.ts-header');
    const footer = el.querySelector('.ts-footer');
    const cards = el.querySelectorAll('.ts-player-card');
    const badge = el.querySelector('.ts-format-badge');
    const backdrop = el.querySelector('.ts-backdrop');
    const names = el.querySelectorAll('.ts-player-name');

    if (typeof gsap !== 'undefined' && gsap.timeline) {
        const tl = gsap.timeline();
        if (backdrop) {
            tl.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.35, ease: 'power2.out' });
        }
        tl.fromTo(
            panel,
            { opacity: 0, scale: 0.9, y: 48, filter: 'blur(10px)' },
            { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', duration: 0.9, ease: 'power3.out' },
            backdrop ? '-=0.15' : 0
        );
        if (badge) {
            tl.fromTo(
                badge,
                { y: -28, opacity: 0, scale: 0.5, rotation: -12 },
                { y: 0, opacity: 1, scale: 1, rotation: 0, duration: 0.65, ease: 'back.out(2)' },
                '-=0.65'
            );
        }
        if (header) {
            tl.fromTo(header, { opacity: 0, x: -36 }, { opacity: 1, x: 0, duration: 0.55, ease: 'power2.out' }, '-=0.55');
        }
        tl.fromTo(
            cards,
            { opacity: 0, y: 56, scale: 0.82, rotation: 2 },
            {
                opacity: 1,
                y: 0,
                scale: 1,
                rotation: 0,
                duration: 0.62,
                stagger: 0.065,
                ease: 'back.out(1.5)',
            },
            '-=0.4'
        );
        tl.fromTo(
            names,
            { opacity: 0, y: 12 },
            { opacity: 1, y: 0, duration: 0.35, stagger: 0.05, ease: 'power2.out' },
            '-=0.45'
        );
        tl.fromTo(footer, { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }, '-=0.25');
    } else {
        if (backdrop) backdrop.style.opacity = '1';
        panel.style.opacity = '1';
        panel.style.transform = 'none';
        panel.style.filter = 'none';
        cards.forEach((c) => {
            c.style.opacity = '1';
            c.style.transform = 'none';
        });
        names.forEach((n) => {
            n.style.opacity = '1';
        });
        if (footer) {
            footer.style.opacity = '1';
            footer.style.transform = 'none';
        }
    }
}

function showGuestGraphic(data) {
    const photo = data.playerPhoto || data.photo || OVERLAY_DEFAULT_PLAYER_PHOTO;
    const name = (data.playerName || data.name || 'GUEST').toUpperCase();
    const role = (data.title || 'SPECIAL GUEST').toUpperCase();

    const el = document.createElement('div');
    el.className = 'broadcast-overlay overlay-visible';
    el.style.display = 'block';
    el.style.left = '40px'; el.style.bottom = '130px';
    el.style.top = 'auto'; el.style.transform = 'none';

    el.innerHTML = `
        <div style="display:flex;align-items:flex-end;gap:0;overflow:hidden;border-radius:15px 15px 15px 0;box-shadow:0 20px 50px rgba(0,0,0,0.5);">
            <img src="${photo}" style="width:180px;height:220px;object-fit:cover;flex-shrink:0;" onerror="this.src='${OVERLAY_DEFAULT_PLAYER_PHOTO}'">
            <div style="background:linear-gradient(135deg,#0f172a,#1a2540);border-left:5px solid #ffd700;padding:20px 22px;min-width:240px;">
                <div style="font-size:10px;color:#ffd700;letter-spacing:3px;font-weight:900;margin-bottom:6px;">${role}</div>
                <div style="font-size:24px;font-weight:950;color:#fff;line-height:1.1;">${name}</div>
            </div>
        </div>
    `;
    document.body.appendChild(stampBroadcastOverlay(el));
    gsap.fromTo(el, { x: -500, opacity: 0 }, { x: 0, opacity: 1, duration: 0.8, ease: 'expo.out' });
    setTimeout(() => gsap.to(el, { x: -500, opacity: 0, duration: 0.6, onComplete: () => el.remove() }), 12000);
}

function toggleBroadcastSummary(tId) {
    const el = document.getElementById('broadcast-summary');
    if (!el) return;
    if (el.classList.contains('overlay-visible') || el.style.display === 'block') {
        el.classList.remove('overlay-visible');
        gsap.to(el, { opacity: 0, y: 100, duration: 0.5, onComplete: () => { el.style.display = 'none'; } });
    } else {
        el.classList.add('overlay-visible');
        el.style.display = 'block';
        gsap.fromTo(el, { opacity: 0, y: 100 }, { opacity: 1, y: 0, duration: 0.6 });
    }
}

function showRunsBallsGraphic(data) {
    const el = document.createElement('div');
    el.className = 'broadcast-overlay overlay-visible';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.inset = '0';
    el.innerHTML = `<div style="background:linear-gradient(135deg, #2a1458, #110524); border:2px solid #00e676; padding:40px; border-radius:30px; color:white; text-align:center; min-width:400px; box-shadow:0 20px 50px rgba(0,0,0,0.5);">
        <div style="font-size:14px; color:#00e676; letter-spacing:4px; margin-bottom:10px; font-weight:900;">RUNS NEEDED</div>
        <div style="font-size:72px; font-weight:950;">${data.runs}</div>
        <div style="font-size:24px; opacity:0.7; font-weight:700;">FROM ${data.balls} BALLS</div>
    </div>`;
    document.body.appendChild(stampBroadcastOverlay(el));
    gsap.fromTo(el, { y: 100, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, ease: 'back.out' });
    setTimeout(() => gsap.to(el, { y: 100, opacity: 0, duration: 0.6, onComplete: () => el.remove() }), 8000);
}

function normalizeLastWicketPayload(data) {
    if (!data) return null;
    let batters = Array.isArray(data.batters) ? data.batters : [];
    if (!batters.length && data.name) {
        batters = [
            {
                wicketNum: 1,
                name: String(data.name).toUpperCase(),
                runs: data.runs ?? 0,
                balls: data.balls ?? 0,
                dismissal: (data.dismissal || 'out').toLowerCase(),
                fours: data.fours ?? 0,
                sixes: data.sixes ?? 0,
                dots: data.dots ?? 0,
                strikeRate: data.strikeRate ?? 0,
                isLatest: true,
            },
        ];
    }
    if (!batters.length) return null;
    const focus = data.focus || batters.find((b) => b.isLatest) || batters[batters.length - 1];
    return {
        batters,
        focus,
        inningsLabel: data.inningsLabel || 'INNS',
        teamName: data.teamName || '',
        teamLogo: data.teamLogo || '../assets/default-team.svg',
    };
}

function renderWicketFallCardHtml(b, inningsLabel) {
    const dismiss = overlayEscapeHtml((b.dismissal || 'out').toUpperCase());
    const ballsLabel = (b.balls ?? 0) === 1 ? 'BALL' : 'BALLS';
    return `
        <div class="wf-card-wrap">
        <div class="wf-card">
            <div class="wf-top">
                <div class="wf-name-block">
                    <span class="wf-inns-tag">${overlayEscapeHtml(inningsLabel)}</span>
                    <span class="wf-name">${overlayEscapeHtml(b.name)}</span>
                </div>
                <div class="wf-score-block">
                    <span class="wf-runs">${b.runs ?? 0}</span>
                    <span class="wf-balls-wrap">
                        <span class="wf-balls-num">${b.balls ?? 0}</span>
                        <span class="wf-balls-lbl">${ballsLabel}</span>
                    </span>
                    <span class="wf-star" aria-hidden="true">★</span>
                </div>
            </div>
            <div class="wf-dismissal">${dismiss}</div>
            <div class="wf-stats">
                <div class="wf-stat"><span class="wf-stat-lbl">FOURS</span><span class="wf-stat-val">${b.fours ?? 0}</span></div>
                <div class="wf-stat"><span class="wf-stat-lbl">SIXES</span><span class="wf-stat-val">${b.sixes ?? 0}</span></div>
                <div class="wf-stat"><span class="wf-stat-lbl">DOTS</span><span class="wf-stat-val">${b.dots ?? 0}</span></div>
                <div class="wf-stat"><span class="wf-stat-lbl">STRIKE RATE</span><span class="wf-stat-val">${b.strikeRate ?? 0}</span></div>
            </div>
        </div>
        </div>
    `;
}

function renderLastWicketPanelHtml(payload) {
    const b = payload.focus;
    const chips =
        payload.batters.length > 1
            ? `<div class="wf-chips">${payload.batters
                  .map(
                      (x) =>
                          `<span class="wf-chip${x.isLatest ? ' wf-chip--on' : ''}">${overlayEscapeHtml(x.name)} ${x.runs}/${x.balls}</span>`
                  )
                  .join('')}</div>`
            : '';
    return `${chips}${renderWicketFallCardHtml(b, payload.inningsLabel)}`;
}

function showLastWicketGraphic(data) {
    const payload = normalizeLastWicketPayload(data);
    if (!payload) return;

    const el = document.getElementById('broadcast-last-wicket');
    const panel = document.getElementById('lw-panel');
    if (!el || !panel) return;

    panel.innerHTML = renderLastWicketPanelHtml(payload);
    stampBroadcastOverlay(el);
    el.style.display = 'flex';
    el.style.zIndex = '28600';

    const wrap = panel.querySelector('.wf-card-wrap');
    const card = panel.querySelector('.wf-card');
    if (wrap) {
        wrap.style.opacity = '0';
        wrap.style.transform = 'scale(0.88) translateY(12px)';
    }

    spawnMiniFireworks(el, 'WICKET_FALL', { count: 22, spread: 1.15, centerX: el.clientWidth / 2, centerY: 40 });

    if (typeof gsap !== 'undefined' && gsap.fromTo && wrap) {
        gsap.to(wrap, {
            opacity: 1,
            scale: 1,
            y: 0,
            duration: 0.7,
            delay: 0.28,
            ease: 'power3.out',
        });
        if (card) {
            gsap.fromTo(card.querySelector('.wf-top'), { opacity: 0 }, { opacity: 1, duration: 0.35, delay: 0.38 });
            const dismiss = card.querySelector('.wf-dismissal');
            const stats = card.querySelector('.wf-stats');
            if (dismiss) gsap.fromTo(dismiss, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4, delay: 0.48 });
            if (stats) gsap.fromTo(stats, { opacity: 0 }, { opacity: 1, duration: 0.45, delay: 0.55 });
        }
    } else if (wrap) {
        wrap.style.opacity = '1';
        wrap.style.transform = 'none';
    }

    const hideMs = 10000;
    clearTimeout(window._lastWicketHideTimer);
    window._lastWicketHideTimer = setTimeout(() => {
        const done = () => {
            el.classList.remove('overlay-visible');
            el.style.display = 'none';
            panel.innerHTML = '';
        };
        if (typeof gsap !== 'undefined' && gsap.to && card) {
            gsap.to(card, { opacity: 0, y: -16, duration: 0.55, ease: 'power2.in', onComplete: done });
        } else {
            done();
        }
    }, hideMs);
}

function showNextMatchGraphic(data) {
    const el = document.getElementById('broadcast-next-match');
    if (!el) return;

    const teamA = document.getElementById('nm-team-a');
    const teamB = document.getElementById('nm-team-b');
    if (teamA) teamA.textContent = (data.teamA || 'TEAM A').toUpperCase();
    if (teamB) teamB.textContent = (data.teamB || 'TEAM B').toUpperCase();

    stampBroadcastOverlay(el);
    el.style.display = 'flex';
    const art = el.querySelector('.nm-artwork');
    const tag = el.querySelector('.nm-tag');

    if (typeof gsap !== 'undefined' && gsap.fromTo && art) {
        gsap.set(el, { opacity: 1 });
        gsap.fromTo(
            art,
            { scale: 0.55, opacity: 0, y: 80, rotateX: 12 },
            { scale: 1, opacity: 1, y: 0, rotateX: 0, duration: 1.05, ease: 'expo.out' }
        );
        if (tag) {
            gsap.fromTo(tag, { letterSpacing: '0px', opacity: 0 }, { letterSpacing: '4px', opacity: 1, duration: 0.8, delay: 0.15 });
        }
        gsap.fromTo(teamA, { x: -120, opacity: 0 }, { x: 0, opacity: 1, duration: 0.85, ease: 'power3.out', delay: 0.2 });
        gsap.fromTo(teamB, { x: 120, opacity: 0 }, { x: 0, opacity: 1, duration: 0.85, ease: 'power3.out', delay: 0.2 });
    }

    clearTimeout(window._nextMatchHideTimer);
    window._nextMatchHideTimer = setTimeout(() => {
        const done = () => {
            el.classList.remove('overlay-visible');
            el.style.display = 'none';
        };
        if (typeof gsap !== 'undefined' && gsap.to && art) {
            gsap.to(art, {
                scale: 0.88,
                opacity: 0,
                y: -40,
                duration: 0.65,
                ease: 'power2.in',
                onComplete: done,
            });
        } else {
            done();
        }
    }, 8500);
}

function showCRRGraphic(data) {
    const el = document.getElementById('broadcast-crr-float');
    if (!el) return;

    const val = document.getElementById('crr-float-val');
    const rrr = document.getElementById('crr-float-rrr');
    if (val) val.textContent = data.crr || '0.00';
    if (rrr) {
        if (data.rrr) {
            rrr.textContent = `REQ ${data.rrr}`;
            rrr.style.display = '';
        } else {
            rrr.textContent = '';
            rrr.style.display = 'none';
        }
    }

    clearTimeout(window._crrHideTimer);
    stampBroadcastOverlay(el);
    el.style.display = 'flex';
    const box = el.querySelector('.crr-float-box');

    if (typeof gsap !== 'undefined' && gsap.fromTo && box) {
        if (typeof gsap.killTweensOf === 'function') gsap.killTweensOf(box);
        gsap.fromTo(box, { opacity: 0, x: -40, scale: 0.9 }, { opacity: 1, x: 0, scale: 1, duration: 0.45, ease: 'power3.out' });
    }

    window._crrHideTimer = setTimeout(() => {
        const done = () => {
            el.classList.remove('overlay-visible');
            el.style.display = 'none';
        };
        if (typeof gsap !== 'undefined' && gsap.to && box) {
            gsap.to(box, { opacity: 0, x: -30, duration: 0.35, ease: 'power2.in', onComplete: done });
        } else {
            done();
        }
    }, 5000);
}

function fireworkPalette(type) {
    if (type === 'FOUR') return ['#93c5fd', '#60a5fa', '#bfdbfe', '#ffffff'];
    if (type === 'SIX') return ['#e9d5ff', '#a78bfa', '#fbbf24', '#ffffff'];
    if (type === 'WICKET') return ['#fecaca', '#f87171', '#e2e8f0', '#ffffff'];
    return ['#94a3b8', '#7dd3fc', '#cbd5e1', '#f8fafc'];
}

/** Small malwedi-style burst (sparks + ring), then caller reveals content */
function spawnMiniFireworks(anchorEl, typeOrColors, opts = {}) {
    if (!anchorEl) return null;
    const colors = Array.isArray(typeOrColors) ? typeOrColors : fireworkPalette(typeOrColors);
    const count = opts.count ?? 16;
    const spread = opts.spread ?? 1;

    const layer = document.createElement('div');
    layer.className = 'fx-fireworks-layer';
    anchorEl.appendChild(layer);

    const cx = opts.centerX ?? anchorEl.clientWidth / 2;
    const cy = opts.centerY ?? anchorEl.clientHeight / 2;

    const ring = document.createElement('div');
    ring.className = 'fx-burst-ring';
    ring.style.left = `${cx}px`;
    ring.style.top = `${cy}px`;
    layer.appendChild(ring);

    for (let i = 0; i < count; i++) {
        const spark = document.createElement('span');
        spark.className = 'fx-spark';
        const c = colors[i % colors.length];
        spark.style.background = c;
        spark.style.color = c;
        spark.style.left = `${cx}px`;
        spark.style.top = `${cy}px`;
        layer.appendChild(spark);

        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
        const dist = (28 + Math.random() * 42) * spread;
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist * 0.55 - 12;
        const dur = 0.45 + Math.random() * 0.4;

        if (typeof gsap !== 'undefined') {
            gsap.set(spark, { x: 0, y: 0, scale: 0, opacity: 1 });
            gsap.to(spark, {
                x: dx,
                y: dy,
                scale: 0.15,
                opacity: 0,
                duration: dur,
                ease: 'power2.out',
                delay: Math.random() * 0.08,
            });
        } else {
            spark.style.setProperty('--fx-dx', dx + 'px');
            spark.style.setProperty('--fx-dy', dy + 'px');
            spark.classList.add('fx-css-animate');
        }
    }

    if (typeof gsap !== 'undefined') {
        gsap.fromTo(
            ring,
            { scale: 0.2, opacity: 0.9 },
            { scale: 2.2, opacity: 0, duration: 0.65, ease: 'power2.out' }
        );
    }

    setTimeout(() => {
        if (layer.parentNode) layer.remove();
    }, 1100);
    return layer;
}

function bigEventIconLabel(type) {
    if (type === 'FOUR') return { icon: '4', cls: 'be-four', anim: 'be-anim-four' };
    if (type === 'SIX') return { icon: '6', cls: 'be-six', anim: 'be-anim-six' };
    if (type === 'WICKET') return { icon: 'W', cls: 'be-wicket', anim: 'be-anim-wicket' };
    return { icon: '!', cls: 'be-four', anim: 'be-anim-four' };
}

function showBigEventGraphic(data) {
    if (!data) return;
    const type = (data.type || data.event || 'EVENT').toUpperCase();
    const host = document.getElementById('broadcast-big-event');
    if (!host) return;

    const { icon: beIcon, cls, anim } = bigEventIconLabel(type);
    const player = overlayEscapeHtml((data.playerName || '').toUpperCase());
    const score = data.matchScore ? overlayEscapeHtml(String(data.matchScore)) : '';

    clearTimeout(window._bigEventHideTimer);
    stampBroadcastOverlay(host);
    host.style.display = 'flex';
    host.innerHTML = `
        <div class="be-dock ${cls} ${anim}">
            <div class="be-dock-glow"></div>
            <div class="be-dock-icon">${beIcon}</div>
            <div class="be-dock-text">
                <span class="be-dock-type">${type}</span>
                ${player ? `<span class="be-dock-player">${player}</span>` : ''}
                ${score ? `<span class="be-dock-score">${score}</span>` : ''}
            </div>
        </div>
    `;

    const dock = host.querySelector('.be-dock');
    if (dock) {
        dock.style.opacity = '0';
        dock.style.transform = 'scale(0.7)';
    }

    spawnMiniFireworks(host, type, { count: 8, spread: 0.85, centerX: host.clientWidth * 0.55, centerY: 30 });

    const iconEl = dock?.querySelector('.be-dock-icon');
    const glow = dock?.querySelector('.be-dock-glow');
    if (typeof gsap !== 'undefined' && gsap.fromTo && dock) {
        gsap.to(dock, { opacity: 1, scale: 1, duration: 0.32, delay: 0.06, ease: 'back.out(1.7)' });
        if (type === 'FOUR') {
            gsap.fromTo(dock, { x: 40 }, { x: 0, duration: 0.3, delay: 0.06, ease: 'power3.out' });
            if (glow) gsap.fromTo(glow, { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 0.85, duration: 0.3, delay: 0.08 });
            if (iconEl) gsap.fromTo(iconEl, { scale: 0, rotate: -25 }, { scale: 1, rotate: 0, duration: 0.28, delay: 0.1, ease: 'back.out(2.5)' });
        } else if (type === 'SIX') {
            if (iconEl) gsap.fromTo(iconEl, { y: 16, scale: 0 }, { y: 0, scale: 1, duration: 0.32, delay: 0.12, ease: 'back.out(2)' });
            gsap.to(dock, { boxShadow: '0 0 28px rgba(167,139,250,0.75)', duration: 0.15, yoyo: true, repeat: 2, delay: 0.25 });
        } else if (type === 'WICKET') {
            gsap.to(dock, { x: '+=4', duration: 0.04, repeat: 4, yoyo: true, ease: 'power1.inOut', delay: 0.15 });
            if (iconEl) gsap.fromTo(iconEl, { scale: 1.5 }, { scale: 1, duration: 0.28, delay: 0.12, ease: 'elastic.out(1, 0.55)' });
        }
    } else if (dock) {
        dock.style.opacity = '1';
        dock.style.transform = 'scale(1)';
    }

    window._bigEventHideTimer = setTimeout(() => {
        const done = () => {
            host.classList.remove('overlay-visible');
            host.style.display = 'none';
            host.innerHTML = '';
        };
        if (typeof gsap !== 'undefined' && gsap.to && dock) {
            gsap.to(dock, { x: 60, opacity: 0, duration: 0.4, ease: 'power2.in', onComplete: done });
        } else {
            done();
        }
    }, 4200);
}

function overlayResolveProfileTeamName(data, label) {
    if (data.teamName) return String(data.teamName).trim();
    if (data.battingTeam && !String(label).toUpperCase().includes('BOWL')) {
        return String(data.battingTeam).trim();
    }
    const m = latestSocketScore?.fullMatch;
    const inn = m?.innings?.[m?.currentInnings || 0];
    if (!inn) return '';
    if (String(label).toUpperCase().includes('BOWL')) return inn.bowlingTeam || '';
    return inn.battingTeam || '';
}

function overlayProfileAccentClass(label, data) {
    const role = (data.roleLabel || label || '').toUpperCase();
    if (role.includes('BOWL')) return 'pp-accent-bowler';
    if (role.includes('NON')) return 'pp-accent-nonstriker';
    return 'pp-accent-striker';
}

function overlayProfileWithDataEnabled(data) {
    if (data && data.profileWithData === false) return false;
    if (data && data.profileWithData === true) return true;
    try {
        return localStorage.getItem('cricpro_profile_with_data') !== 'false';
    } catch (_) {
        return true;
    }
}

function overlayProfileStatRows(data, label) {
    const isBowler = String(data.roleLabel || label || '')
        .toUpperCase()
        .includes('BOWL');
    if (isBowler) {
        const econ =
            data.economy != null && data.economy !== '—'
                ? data.economy
                : data.playerBalls && data.playerSixes
                  ? '—'
                  : '0';
        return [
            { lbl: 'Matches', val: data.careerMatches ?? 0 },
            { lbl: 'Wickets', val: data.careerWickets ?? data.playerRuns ?? 0 },
            { lbl: 'Economy', val: econ },
            { lbl: 'Overs', val: data.playerSixes ?? '0' },
        ];
    }
    return [
        { lbl: 'Matches', val: data.careerMatches ?? 0 },
        { lbl: 'Runs', val: data.careerRuns ?? 0 },
        { lbl: 'This Inn', val: data.playerRuns ?? 0 },
        { lbl: 'Balls', val: data.playerBalls ?? 0 },
    ];
}

function renderPlayerProfileCardHtml(data, label = 'STRIKER', compact = false) {
    const rawPhoto = data.playerPhoto || data.profile?.photo || '';
    const hasPhoto = overlaySquadHasCustomPhoto(rawPhoto);
    const photo = hasPhoto ? rawPhoto : OVERLAY_DEFAULT_PLAYER_PHOTO;
    const nameStr = (data.playerName || data.name || 'PLAYER').trim();
    const fullName = nameStr.toUpperCase();
    const teamName = (overlayResolveProfileTeamName(data, label) || 'TEAM').toUpperCase();
    const roleLabel = (data.roleLabel || label || 'PLAYER').toUpperCase();
    const accent = overlayProfileAccentClass(label, data);
    const withData = overlayProfileWithDataEnabled(data);
    const tournament = overlayEscapeHtml(data.tournamentName || '');
    const initials = overlayPlayerInitials(nameStr);
    const defaultPhotoEsc = overlayEscapeHtml(OVERLAY_DEFAULT_PLAYER_PHOTO);

    const stats = overlayProfileStatRows(data, label);
    const statHtml = withData
        ? `<div class="pp-v-stats-grid">${stats
              .map(
                  (s) => `
            <div class="pp-v-stat-box">
                <span class="pp-v-stat-h">${overlayEscapeHtml(s.lbl)}</span>
                <span class="pp-v-stat-n">${overlayEscapeHtml(String(s.val))}</span>
            </div>`
              )
              .join('')}</div>`
        : '';

    const sizeClass = withData
        ? compact
            ? ' pp-card--with-data'
            : ' pp-card--with-data'
        : ' pp-card--mini';

    return `
        <div class="pp-card pp-card--vertical ${accent}${sizeClass}">
            ${tournament ? `<div class="pp-tournament-mark">${tournament}</div>` : ''}
            <div class="pp-v-burst" aria-hidden="true"></div>
            <div class="pp-deco-br" aria-hidden="true"></div>
            <div class="pp-v-photo-zone${hasPhoto ? '' : ' pp-v-photo-zone--default'}">
                ${hasPhoto ? '' : `<span class="pp-v-initials" aria-hidden="true">${overlayEscapeHtml(initials)}</span>`}
                <img class="pp-v-photo-img" src="${overlayEscapeHtml(photo)}" alt=""
                    onerror="this.onerror=null;this.src='${defaultPhotoEsc}';this.closest('.pp-v-photo-zone')?.classList.add('pp-v-photo-zone--default');">
            </div>
            <div class="pp-v-body">
                <div class="pp-v-label">PLAYER <em>Profile</em></div>
                <div class="pp-v-name">${overlayEscapeHtml(fullName)}</div>
                <div class="pp-v-team">${overlayEscapeHtml(teamName)}</div>
                <span class="pp-v-role">${overlayEscapeHtml(roleLabel)}</span>
                ${statHtml}
            </div>
        </div>`;
}

function mountPlayerProfileOverlay(cardHtml, options = {}) {
    const { dual = false, duration = 5500 } = options;
    const el = document.createElement('div');
    const obsGraphic = document.body.classList.contains('obs-capture-mode');
    el.className = obsGraphic
        ? `broadcast-overlay pp-overlay overlay-visible bo-graphic-bl${dual ? ' bo-graphic-row' : ''}`
        : 'broadcast-overlay pp-overlay overlay-visible';
    el.style.display = 'block';
    el.style.left = '40px';
    if (obsGraphic) {
        el.style.top = 'auto';
        el.style.bottom = '118px';
        el.style.transform = 'none';
    } else {
        el.style.top = '50%';
        el.style.bottom = 'auto';
        el.style.transform = 'translateY(-50%)';
    }
    el.innerHTML = dual ? `<div class="pp-dual-row">${cardHtml}</div>` : cardHtml;
    document.body.appendChild(stampBroadcastOverlay(el));

    const card = el.querySelector('.pp-card');
    const photo = el.querySelector('.pp-v-photo-img');

    if (typeof gsap !== 'undefined' && gsap.timeline) {
        const tl = gsap.timeline();
        tl.fromTo(el, { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.35, ease: 'power2.out' });
        if (card) {
            tl.fromTo(
                card,
                { opacity: 0, scale: 0.92, filter: 'blur(6px)' },
                { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.75, ease: 'power3.out' },
                '-=0.2'
            );
        }
        const vBody = el.querySelector('.pp-v-body');
        if (vBody) {
            tl.fromTo(vBody, { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'power2.out' }, '-=0.5');
        }
        if (photo) {
            tl.fromTo(
                photo,
                { x: 60, opacity: 0, scale: 0.9 },
                { x: 0, opacity: 1, scale: 1, duration: 0.7, ease: 'power2.out' },
                '-=0.5'
            );
        }
        const statBoxes = el.querySelectorAll('.pp-v-stat-box');
        if (statBoxes.length) {
            tl.fromTo(
                statBoxes,
                { y: 16, opacity: 0 },
                { y: 0, opacity: 1, duration: 0.35, stagger: 0.06, ease: 'power2.out' },
                '-=0.4'
            );
        }
        setTimeout(() => {
            if (typeof gsap !== 'undefined' && gsap.to) {
                gsap.to(el, {
                    x: -120,
                    opacity: 0,
                    duration: 0.55,
                    ease: 'power2.in',
                    onComplete: () => el.remove(),
                });
            } else {
                el.remove();
            }
        }, duration);
    } else {
        setTimeout(() => el.remove(), duration);
    }
}

function showStrikerProfileLeft(data, label = 'STRIKER') {
    mountPlayerProfileOverlay(renderPlayerProfileCardHtml(data, label, false));
}

function showBowlerProfileGraphic(data) {
    // Stats are now sent as flat fields: playerRuns=wickets, playerBalls=runsGiven, playerSixes=overs
    showStrikerProfileLeft(data, 'BOWLER');
}

function showPartnershipGraphicCinema(data) {
    const el = document.createElement('div');
    el.className = 'broadcast-overlay overlay-visible';
    
    // Fallbacks — support both old and new data shape
    const p1Photo = (data.p1Profile && data.p1Profile.photo) || data.player1Photo || OVERLAY_DEFAULT_PLAYER_PHOTO;
    const p2Photo = (data.p2Profile && data.p2Profile.photo) || data.player2Photo || OVERLAY_DEFAULT_PLAYER_PHOTO;
    const p1Name = (data.player1 || 'BATSMAN 1').toUpperCase();
    const p2Name = (data.player2 || 'BATSMAN 2').toUpperCase();
    const runs = data.runs || 0;
    const balls = data.balls || 0;
    const wicketNum = data.wicketNumber || data.wicketNum || 1;
    const teamName = (data.battingTeam || data.teamName || 'TBD').toUpperCase();

    // Suffix logic (1st, 2nd, 3rd, etc)
    let suffix = 'TH';
    if (wicketNum % 10 === 1 && wicketNum !== 11) suffix = 'ST';
    if (wicketNum % 10 === 2 && wicketNum !== 12) suffix = 'ND';
    if (wicketNum % 10 === 3 && wicketNum !== 13) suffix = 'RD';
    const wicketLabel = `${wicketNum}${suffix} WICKET PARTNERSHIP`;

    el.style.inset = '0';
    el.style.display = 'flex';
    el.style.alignItems = 'flex-end';
    el.style.justifyContent = 'center';
    el.style.paddingBottom = '100px';

    el.innerHTML = `
        <div style="display:flex; align-items:flex-end; gap:20px;">
            <!-- Player 1 (Left) -->
            <div class="partnership-player-card" style="width:240px; background:#1a202c; border-radius:15px; overflow:hidden; border-left:6px solid #00e676; box-shadow:0 15px 35px rgba(0,0,0,0.4);">
                <div style="height:220px; background:#2d3748; display:flex; justify-content:center; align-items:flex-end;">
                    <img src="${p1Photo}" style="width:100%; height:100%; object-fit:cover;">
                </div>
                <div style="background:#0f172a; padding:15px; text-align:center;">
                    <div style="font-weight:900; font-size:18px; color:#fff; letter-spacing:1px;">${p1Name}</div>
                </div>
            </div>

            <!-- Partnership Stats (Center) -->
            <div class="partnership-center-card" style="background:linear-gradient(to right, rgba(15,23,42,0) 0%, rgba(15,23,42,0.95) 20%, rgba(15,23,42,0.95) 80%, rgba(15,23,42,0) 100%); padding:30px 60px; min-width:500px; text-align:center; position:relative;">
                <div style="position:absolute; top:0; left:20%; right:20%; height:4px; background:#00e676;"></div>
                <div style="position:absolute; bottom:0; left:20%; right:20%; height:4px; background:#00e676;"></div>
                <div style="color:#00e676; font-weight:900; font-size:14px; letter-spacing:4px; margin-bottom:15px;">${wicketLabel}</div>
                <div style="display:flex; align-items:center; justify-content:center; gap:25px;">
                    <div style="font-size:70px; font-weight:950; color:#fff; line-height:1;">${runs}</div>
                    <div style="width:2px; height:60px; background:rgba(255,255,255,0.2);"></div>
                    <div style="text-align:left;">
                        <div style="font-size:24px; font-weight:950; color:#fff; line-height:1;">${balls} <span style="font-size:14px; color:#aaa;">BALLS</span></div>
                        <div style="font-size:16px; font-weight:900; color:#00e676; margin-top:5px;">${teamName}</div>
                    </div>
                </div>
            </div>

            <!-- Player 2 (Right) -->
            <div class="partnership-player-card" style="width:240px; background:#1a202c; border-radius:15px; overflow:hidden; border-right:6px solid #00e676; box-shadow:0 15px 35px rgba(0,0,0,0.4);">
                <div style="height:220px; background:#2d3748; display:flex; justify-content:center; align-items:flex-end;">
                    <img src="${p2Photo}" style="width:100%; height:100%; object-fit:cover;">
                </div>
                <div style="background:#0f172a; padding:15px; text-align:center;">
                    <div style="font-weight:900; font-size:18px; color:#fff; letter-spacing:1px;">${p2Name}</div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(stampBroadcastOverlay(el));

    const centerCard = el.querySelector('.partnership-center-card');
    const playerCards = el.querySelectorAll('.partnership-player-card');

    gsap.fromTo(centerCard, { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.7, ease: 'expo.out' });
    gsap.fromTo(playerCards[0], { x: -100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.7, delay: 0.2, ease: 'back.out' });
    gsap.fromTo(playerCards[1], { x: 100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.7, delay: 0.2, ease: 'back.out' });

    setTimeout(() => gsap.to(el, { y: 100, opacity: 0, duration: 0.6, onComplete: () => el.remove() }), 5000);
}

function showTeamRosterGraphic(data) {
    const players = (data.players || []).map((p) => {
        if (typeof p === 'string') {
            return { name: p, photo: '', role: 'Player' };
        }
        const name = p.name || p.playerName || 'Player';
        const photo = p.photo || (p.id && typeof DB !== 'undefined' ? DB.getPlayerPhoto(p.id) : '') || '';
        return { name, photo, role: p.role || 'Player', isCaptain: !!p.isCaptain };
    });
    showTeamCardGraphic({
        ...data,
        players,
    });
}



function showBatterProfilesGraphic(data) {
    const profiles = data.profiles || [];
    if (!profiles.length) return;

    const html = profiles
        .map((p, idx) => {
            const label = p.roleLabel || (idx === 1 ? 'NON-STRIKER' : 'STRIKER');
            const merged = {
                ...p,
                playerName: p.playerName || p.name,
                playerRuns: p.playerRuns ?? p.stats?.runs ?? 0,
                playerBalls: p.playerBalls ?? p.stats?.balls ?? 0,
                playerSixes: p.playerSixes ?? p.stats?.sixes ?? 0,
                playerPhoto: p.playerPhoto || p.profile?.photo || '',
                roleLabel: label,
            };
            return renderPlayerProfileCardHtml(merged, label, true);
        })
        .join('');

    mountPlayerProfileOverlay(html, { dual: true, duration: 6000 });
}

