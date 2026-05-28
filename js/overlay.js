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
/** Back off cloud GET when match is not on server (stops 404 spam). */
let _cloudMatchMissUntil = 0;
let _lastRenderedScoreKey = '';
let _lastOverlayFingerprint = '';
let _lastCloudMatchUpdated = 0;
let _lastOverlayPollOkAt = Date.now();
let _localOverlayEventSource = null;
/** Match draw full-screen — cleared by STOP ALL / STOP_MATCH_DRAW / other hotkeys */
let _matchDrawOnAir = false;
let _obsOverlaySettings = {
    autoBigEvents: false,
    timerDurationSec: 0,
    timerRunning: false,
    timerEndAt: 0,
    timerRemainingSec: 0,
};
let _obsTimerTick = null;

/** Measure live scorebar height so hotkey graphics sit flush above it (OBS). */
function overlaySyncScorebarInset() {
    const root = document.documentElement;
    if (!document.body.classList.contains('obs-capture-mode')) {
        root.style.removeProperty('--obs-scorebar-h');
        return;
    }
    const bar = document.getElementById('overlay-container');
    if (!bar || bar.style.display === 'none' || !isScorebarVisible) {
        root.style.setProperty('--obs-scorebar-h', '48px');
        return;
    }
    const h = Math.ceil(bar.getBoundingClientRect().height);
    root.style.setProperty('--obs-scorebar-h', `${Math.max(h, 36)}px`);
}

function overlayPositionAboveScorebar(el) {
    if (!el) return;
    el.classList.add('bo-graphic-bl');
    el.style.top = 'auto';
    el.style.removeProperty('bottom');
    el.style.removeProperty('transform');
    overlaySyncScorebarInset();
}

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
            el.classList.contains('partnership-overlay') ||
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

/** Stable id for deduping SYNC_SCORE — must not reuse cmd|timestamp (same‑ms collisions). */
function broadcastDedupeSig(payload) {
    const cmd = payload?.cmd || '';
    const ts = payload.timestamp || payload.relayTs || 0;
    if ((cmd === 'SYNC_SCORE' || cmd === 'SYNC_MATCH') && payload.data?.match) {
        const m = payload.data.match;
        if (m?.id) {
            const inn = m.innings?.[m.currentInnings || 0];
            let sk = '';
            if (inn) {
                const overLen = (inn.currentOver || []).length;
                sk = `${m.currentInnings}|${inn.runs}|${inn.wickets}|${inn.balls}|${inn.strikerIdx}|${inn.currentBowlerIdx}|${overLen}`;
            }
            return `${cmd}:${m.id}|${sk}|${String(m.lastUpdated ?? '')}`;
        }
    }
    return `${cmd}|${ts}`;
}

function applyBroadcastPayload(payload) {
    if (!payload || !payload.cmd) return;
    const ts = payload.timestamp || payload.relayTs || Date.now();
    const sig = broadcastDedupeSig(payload);

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
    const syncCmd = payload.cmd === 'SYNC_SCORE' || payload.cmd === 'SYNC_MATCH';
    if (!syncCmd && ts && ts < _lastBroadcastCmdTs) return;
    _lastBroadcastCmdTs = syncCmd ? Math.max(_lastBroadcastCmdTs || 0, ts) : ts;
    _lastBroadcastCmdSig = sig;
    handleBroadcastCommand(payload.cmd, payload.data || {});
}

function pollBroadcastCommands() {
    try {
        const raw = localStorage.getItem('cricpro_broadcast_cmd');
        if (raw) applyBroadcastPayload(JSON.parse(raw));
    } catch (_) {}
}

function normalizeObsOverlaySettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const duration = Math.max(0, parseInt(src.timerDurationSec ?? src.timerSeconds ?? 0, 10) || 0);
    const running = !!src.timerRunning;
    let remaining = Math.max(
        0,
        parseInt(src.timerRemainingSec ?? src.remainingSec ?? duration, 10) || 0
    );
    let endAt = parseInt(src.timerEndAt || 0, 10) || 0;
    if (running && endAt > Date.now()) {
        remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    } else if (running && remaining > 0) {
        endAt = Date.now() + remaining * 1000;
    } else if (running && remaining <= 0) {
        endAt = 0;
    }
    return {
        autoBigEvents: !!src.autoBigEvents,
        timerDurationSec: duration,
        timerRunning: running && remaining > 0,
        timerEndAt: running && remaining > 0 ? endAt : 0,
        timerRemainingSec: running && remaining > 0 ? remaining : Math.max(0, remaining || duration),
    };
}

function formatObsTimer(sec) {
    const s = Math.max(0, parseInt(sec, 10) || 0);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function currentObsTimerRemaining(settings = _obsOverlaySettings) {
    if (!settings?.timerRunning) return Math.max(0, settings?.timerRemainingSec || settings?.timerDurationSec || 0);
    return Math.max(0, Math.ceil(((settings.timerEndAt || 0) - Date.now()) / 1000));
}

function ensureObsTimerBadge() {
    let el = document.getElementById('obs-match-timer');
    if (!el) {
        el = document.createElement('div');
        el.id = 'obs-match-timer';
        el.className = 'obs-match-timer';
        el.innerHTML = '<span class="obs-match-timer-label">TIMER</span><span class="obs-match-timer-value">00:00</span>';
        document.body.appendChild(el);
    }
    return el;
}

function updateObsTimerBadge() {
    const el = ensureObsTimerBadge();
    const val = el.querySelector('.obs-match-timer-value');
    const rem = currentObsTimerRemaining(_obsOverlaySettings);
    if (val) val.textContent = formatObsTimer(rem);
    if (!_obsOverlaySettings.timerRunning && rem <= 0) {
        el.classList.remove('visible', 'running');
        return;
    }
    el.classList.add('visible');
    if (_obsOverlaySettings.timerRunning) el.classList.add('running');
    else el.classList.remove('running');
}

function startObsTimerTicker() {
    if (_obsTimerTick) return;
    _obsTimerTick = setInterval(() => {
        const rem = currentObsTimerRemaining(_obsOverlaySettings);
        if (_obsOverlaySettings.timerRunning && rem <= 0) {
            _obsOverlaySettings.timerRunning = false;
            _obsOverlaySettings.timerRemainingSec = 0;
            _obsOverlaySettings.timerEndAt = 0;
        }
        updateObsTimerBadge();
    }, 500);
}

function applyObsOverlaySettings(settings) {
    _obsOverlaySettings = normalizeObsOverlaySettings(settings);
    startObsTimerTicker();
    updateObsTimerBadge();
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
    if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (/^192\.168\./.test(h)) return false;
    if (/^10\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return false;
    return true;
}

/** localhost / 127.0.0.1 / LAN — use local server API + SSE (not cloud). */
function useLocalMatchFeed() {
    return !shouldUseCloudLive();
}

function shouldPollLocalMatchApi() {
    if (!useLocalMatchFeed()) return false;
    return !!(matchId || isMasterOverlay);
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

/** Single number for current innings — never accept a payload that regresses this. */
function overlayInningsProgress(m) {
    const inn = m?.innings?.[m?.currentInnings ?? 0];
    if (!inn) return 0;
    return (inn.runs || 0) * 100000 + (inn.wickets || 0) * 1000 + (inn.balls || 0);
}

function overlayAcceptIncomingMatch(incoming, existing, options = {}) {
    if (!incoming?.id) return false;
    if (!existing) return true;
    if (incoming.id !== existing.id) return false;

    const inProg = overlayInningsProgress(incoming);
    const exProg = overlayInningsProgress(existing);
    if (inProg < exProg) return false;

    if (options.trustIncoming) return true;

    const inTs = Number(incoming.lastUpdated || incoming.cloudUpdatedAt || 0);
    const exTs = Number(existing.lastUpdated || existing.cloudUpdatedAt || 0);

    if (inProg > exProg) return true;

    if (options.allowLocalPoll) {
        if (!inTs && !exTs) return inProg >= exProg;
        if (inTs && exTs && inTs >= exTs - 1500) return true;
        return inProg === exProg && inTs >= exTs;
    }

    if (inTs && exTs > inTs + 1200) return false;
    if (!inTs && exTs > 0) return false;
    return inTs >= exTs;
}

function getOverlayDetailSettings(m) {
    const src = m?.obsOverlaySettings && typeof m.obsOverlaySettings === 'object' ? m.obsOverlaySettings : {};
    const detailMode = src.detailMode === 'match' ? 'match' : 'balls';
    const groundName = String(src.groundName || m?.venue || '').trim();
    const organizedBy = String(src.organizedBy || m?.scorer || '').trim();
    return { detailMode, groundName, organizedBy };
}

function overlayBallHistoryText(curInn) {
    const balls = (curInn?.currentOver || []).slice(-6);
    if (!balls.length) return 'BALLS: -';
    const text = balls
        .map((b) => {
            if (b?.wicket) return 'W';
            if (b?.isWide) return `Wd${b.runs || ''}`;
            if (b?.isNoBall) return `Nb${b.runs || ''}`;
            if (b?.isBye) return `B${b.runs || ''}`;
            if (b?.isLegBye) return `Lb${b.runs || ''}`;
            return String(b?.runs ?? 0);
        })
        .join('  ');
    return `BALLS: ${text}`;
}

function overlayBottomInsightText(m, curInn, bpo) {
  if (!m || !curInn) return '';
  if (m.currentInnings === 1 && m.innings?.[0]) {
    const target = (m.innings[0].runs || 0) + 1;
    const need = Math.max(0, target - (curInn.runs || 0));
    return `TO WIN: ${need} RUNS`;
  }
  return `PROJECTED: ${overlayProjectedScore(curInn, m)}`;
}

/** Prefer freshest match for overlay (LAN poll vs stale browser DB). */
function resolveOverlayMatch() {
    const fromDb = matchId && typeof DB !== 'undefined' && DB.getMatch ? DB.getMatch(matchId) : null;
    const fromLive = latestSocketScore?.fullMatch || null;
    if (!fromLive?.id) return fromDb;
    if (matchId && fromLive.id !== matchId) return fromDb || null;
    if (!fromDb) return fromLive;
    const dbTs = Number(fromDb.lastUpdated || fromDb.cloudUpdatedAt || 0);
    const liveTs = Number(fromLive.lastUpdated || fromLive.cloudUpdatedAt || 0);
    if (liveTs > dbTs) return fromLive;
    if (dbTs > liveTs) return fromDb;
    const dbProg = overlayInningsProgress(fromDb);
    const liveProg = overlayInningsProgress(fromLive);
    return liveProg >= dbProg ? fromLive : fromDb;
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
            if (!photo) return;
            const normalized = DB.resolveAssetUrl ? DB.resolveAssetUrl(photo) : photo;
            if (normalized && !String(normalized).includes('default-team')) {
                DB.saveTeamPhoto(teamName, normalized, m.tournamentId);
            }
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

function applyCloudScorePayload(data, options = {}) {
    if (!data) return;
    const m = data.fullMatch || (data.id ? data : null);
    if (!m || !m.id) return;
    const existing =
        latestSocketScore?.fullMatch?.id === m.id
            ? latestSocketScore.fullMatch
            : (typeof DB !== 'undefined' && DB.getMatch ? DB.getMatch(m.id) : null);
    if (existing?.teamPhotos && typeof existing.teamPhotos === 'object') {
        m.teamPhotos = { ...existing.teamPhotos, ...(m.teamPhotos || {}) };
    }
    if (existing?.broadcastLivePhotos && !m.broadcastLivePhotos) {
        m.broadcastLivePhotos = { ...existing.broadcastLivePhotos };
    }
    if (existing && !overlayAcceptIncomingMatch(m, existing, options)) return;
    if (tournId && m.tournamentId && m.tournamentId !== tournId) return;
    if (matchId && !isMasterOverlay && m.id !== matchId) return;
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
        try {
            DB.saveMatch(m, true, { skipPublish: true, skipForceUpdate: true });
        } catch (_) {}
        window._desktopApplyingRemoteMatch = false;
    }
    const ts = m.lastUpdated || Date.now();
    _lastOverlayFingerprint = '';
    _lastRenderedScoreKey = '';
    _lastCloudMatchUpdated = Math.max(_lastCloudMatchUpdated, ts);
    renderOverlay();
}

async function fetchCloudMatchSnapshot() {
    if (!matchId || !shouldUseCloudLive()) return;
    if (Date.now() < _cloudMatchMissUntil) return;
    const api = cloudBackendUrl();
    if (!api) return;
    try {
        const qs = `_=${Date.now()}`;
        const r = await fetch(
            `${api}/tv/matches/${encodeURIComponent(matchId)}/light?${qs}`,
            { cache: 'no-store' }
        );
        if (!r.ok) {
            if (r.status === 404) _cloudMatchMissUntil = Date.now() + 60000;
            return;
        }
        _cloudMatchMissUntil = 0;
        const body = await r.json();
        if (body?.error) return;
        const m = body.fullMatch || body.match;
        if (m?.id) applyCloudScorePayload({ fullMatch: m, score: body.score });
    } catch (e) {
        console.warn('[overlay] cloud match fetch failed', e);
    }
}

async function pollMatchApi() {
    if (!matchId && !isMasterOverlay) return;
    if (overlayLayer === 'hotkeys') return;
    const now = Date.now();
    const minGap = shouldUseCloudLive() ? 120 : useLocalMatchFeed() ? 50 : 500;
    if (_pollMatchInFlight || now - _lastPollMatchTs < minGap) return;
    if (shouldUseCloudLive() && matchId && now < _cloudMatchMissUntil) return;
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
        } else if (matchId && !isMasterOverlay) {
            url =
                base +
                '/api/match/' +
                encodeURIComponent(matchId) +
                '?' +
                qs.join('&');
        } else {
            url = base + '/api/live-match';
            if (tournId) qs.push('tournament=' + encodeURIComponent(tournId));
            url = url + '?' + qs.join('&');
        }

        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
            if (useCloud && res.status === 404 && matchId) {
                _cloudMatchMissUntil = Date.now() + 60000;
            }
            return;
        }
        _cloudMatchMissUntil = 0;
        const data = await res.json();
        _lastOverlayPollOkAt = Date.now();
        if (useCloud) {
            if (data?.error) return;
            applyCloudScorePayload(data);
            return;
        }
        const m = data;
        if (!m || !m.id) return;
        if (tournId && m.tournamentId && m.tournamentId !== tournId) return;
        if (!matchId || isMasterOverlay) matchId = m.id;
        applyCloudScorePayload(
            {
                fullMatch: m,
                score: m.innings?.[m.currentInnings || 0],
            },
            { allowLocalPoll: true }
        );
    } catch (_) {
    } finally {
        _pollMatchInFlight = false;
    }
}

function pollServerScore() {
    /* OBS Browser Source has its own IndexedDB — never read it (stale vs scorer). */
    if (!window.desktopAPI) return;
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
        _lastOverlayPollOkAt = Date.now();
        _lastOverlayFingerprint = '';
        _lastRenderedScoreKey = '';
        applyCloudScorePayload(
            {
                fullMatch: localMatch,
                score: localMatch.innings?.[localMatch.currentInnings],
            },
            { allowLocalPoll: true }
        );
    }
}

function installLocalOverlayStream() {
    if (!useLocalMatchFeed()) return;
    if (typeof EventSource === 'undefined') return;
    if (_localOverlayEventSource) return;
    const base = window.location.origin || '';
    if (!base) return;
    const qs = [];
    if (matchId) qs.push(`matchId=${encodeURIComponent(matchId)}`);
    if (tournId) qs.push(`tournamentId=${encodeURIComponent(tournId)}`);
    qs.push(`_=${Date.now()}`);
    const url = `${base}/api/stream?${qs.join('&')}`;
    try {
        const es = new EventSource(url);
        _localOverlayEventSource = es;
        es.addEventListener('match', (ev) => {
            _lastOverlayPollOkAt = Date.now();
            let body = null;
            try {
                body = JSON.parse(ev.data || '{}');
            } catch (_) {}
            const m = body?.match;
            if (m?.id) {
                applyCloudScorePayload(
                    {
                        fullMatch: m,
                        score: m.innings?.[m.currentInnings || 0],
                    },
                    { trustIncoming: true }
                );
            }
        });
        es.addEventListener('broadcast', (ev) => {
            let body = null;
            try {
                body = JSON.parse(ev.data || '{}');
            } catch (_) {}
            const payload = body?.payload || body;
            if (payload?.cmd) applyBroadcastPayload(payload);
        });
        es.onerror = () => {
            try {
                es.close();
            } catch (_) {}
            _localOverlayEventSource = null;
            setTimeout(() => installLocalOverlayStream(), 600);
        };
    } catch (_) {}
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

    if (window.SLCRICK_SYNC?.isEnabled?.() && window.SLCRICK_SYNC?.syncCloudData) {
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

    const cloudPollMs = document.body.classList.contains('obs-capture-mode') ? 200 : 800;
    setInterval(() => {
        if (matchId) fetchCloudMatchSnapshot();
        else if (tournId) pollMatchApi();
    }, cloudPollMs);
}

try {
    const searchStr = window.location.search || '';
    if (searchStr.includes('?')) {
        const urlParams = new URLSearchParams(searchStr);
        const explicitMatch = urlParams.get('match') || urlParams.get('matchId') || null;
        matchId = explicitMatch;
        tournId = urlParams.get('tournament') || urlParams.get('tournamentId') || null;

        // Safety clean up to avoid any hashes breaking the ID
        if (matchId && matchId.includes('#')) matchId = matchId.split('#')[0];
        if (tournId && tournId.includes('#')) tournId = tournId.split('#')[0];
        const obsFlag = urlParams.get('obs') === '1';
        const previewFlag = urlParams.get('preview') === '1' || urlParams.get('preview') === 'true';
        // Tournament-only OBS URL (no matchId) → auto-follow live match in that tournament.
        // Keep explicit matchId when both are present (site + desktop must target same match).
        if (tournId && obsFlag && !previewFlag && !explicitMatch) {
            matchId = null;
        }
    }
} catch (e) {
    console.error("URL Params Error safely caught:", e);
}

// No match id in URL → follow live match (optionally scoped by tournament)
if (!matchId) isMasterOverlay = true;

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
    var OVERLAY_DEFAULT_PLAYER_PHOTO =
        (typeof DB !== 'undefined' && DB.defaultPlayerPhotoUrl)
            ? DB.defaultPlayerPhotoUrl()
            : '/assets/default-player.svg';
}

function overlayDefaultTeamPhoto() {
    return typeof DB !== 'undefined' && DB.defaultTeamPhotoUrl
        ? DB.defaultTeamPhotoUrl()
        : '/assets/default-team.svg';
}

function overlayResolveTeamLogo(raw) {
    const resolved =
        typeof DB !== 'undefined' && DB.resolveAssetUrl
            ? DB.resolveAssetUrl(raw)
            : raw;
    if (resolved && !String(resolved).includes('default-team')) return resolved;
    return '';
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
    if (p && p.length > 10) {
        const resolved =
            typeof DB !== 'undefined' && DB.resolveAssetUrl ? DB.resolveAssetUrl(p) : p;
        if (resolved && !String(resolved).includes('default-player')) return resolved;
    }
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

// Backward-compatible alias for older scorebar templates.
function overlayShortName(fullName) {
    return getShortName(fullName);
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
    if (!teamName) return overlayDefaultTeamPhoto();
    if (typeof DB !== 'undefined' && DB.getTeamPhoto) {
        const fromDb = DB.getTeamPhoto(teamName, tournamentId);
        if (fromDb && !String(fromDb).includes('default-team')) {
            return typeof DB.resolveAssetUrl === 'function'
                ? DB.resolveAssetUrl(fromDb) || fromDb
                : fromDb;
        }
    }
    return overlayTeamInitialAvatar(teamName);
}

/** Team logo for scorebar — match.teamPhotos first (LAN/OBS), then local DB. */
function overlayTeamLogoForMatch(teamName, m) {
    if (!teamName) return overlayDefaultTeamPhoto();
    const tid = m?.tournamentId;
    const photos = m?.teamPhotos;
    if (photos && typeof photos === 'object') {
        const direct = overlayResolveTeamLogo(photos[teamName]);
        if (direct) return direct;
        const want = String(teamName).trim().toLowerCase();
        for (const [key, raw] of Object.entries(photos)) {
            if (String(key).trim().toLowerCase() === want) {
                const hit = overlayResolveTeamLogo(raw);
                if (hit) return hit;
            }
        }
    }
    if (m?.team1 && teamName === m.team1 && m.team1Photo) {
        const t1 = overlayResolveTeamLogo(m.team1Photo);
        if (t1) return t1;
    }
    if (m?.team2 && teamName === m.team2 && m.team2Photo) {
        const t2 = overlayResolveTeamLogo(m.team2Photo);
        if (t2) return t2;
    }
    return overlayTeamLogoUrl(teamName, tid);
}

function overlayBrandLogoOnError() {
    return "this.onerror=null;this.style.display='none';var f=this.parentElement&&this.parentElement.querySelector('.m2-logo-fallback');if(f)f.style.display='flex';";
}

function overlayTeamInitialAvatar(teamName) {
    const initials = overlayShortName(teamName || 'TEAM') || 'TM';
    const safeText = overlayEscapeHtml(initials);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1b41"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="96" height="96" rx="48" fill="url(#g)"/>
  <circle cx="48" cy="48" r="45" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>
  <text x="50%" y="56%" text-anchor="middle" fill="#ffffff" font-family="Outfit,Arial,sans-serif" font-size="36" font-weight="900" letter-spacing="2">${safeText}</text>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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

function formatEconomy(runs, balls, bpo = 6) {
    if (!balls) return '0.00';
    return (runs / (balls / bpo)).toFixed(2);
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
    const pollFast = urlParamsInit.get('poll') === 'fast';
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
        const scorebarEl = document.getElementById('overlay-container');
        if (scorebarEl && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => overlaySyncScorebarInset());
            ro.observe(scorebarEl);
            window._overlayScorebarRo = ro;
        }
        requestAnimationFrame(overlaySyncScorebarInset);
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
        applyCloudScorePayload(
            { fullMatch: match, score: match.innings?.[match.currentInnings] },
            { trustIncoming: true }
        );
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
        installLocalOverlayStream();
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

    const inPreviewIframe = isPreview && window.parent !== window;
    const onDesktop = !!window.desktopAPI;
    const pollTick = () => {
        pollBroadcastCommands();
        if (!inPreviewIframe && (!onDesktop || useLocalMatchFeed())) pollBroadcastApi();
        if (currentPopupView) return;
        if (!inPreviewIframe && shouldPollLocalMatchApi()) pollMatchApi();
        if (!inPreviewIframe && onDesktop) pollServerScore();
    };
    if (!inPreviewIframe) {
        pollTick();
        const pollMs = useLocalMatchFeed()
            ? pollFast
                ? 50
                : isObsMode
                  ? 80
                  : 120
            : shouldUseCloudLive()
              ? isObsMode
                ? 200
                : 400
              : isObsMode
                ? 100
                : 220;
        setInterval(pollTick, pollMs);
        setInterval(() => {
            if (inPreviewIframe || currentPopupView) return;
            if (onDesktop && !useLocalMatchFeed()) return;
            if (document.hidden) return;
            const staleFor = Date.now() - (_lastOverlayPollOkAt || 0);
            if (staleFor < 15000) return;
            _cloudMatchMissUntil = 0;
            _pollMatchInFlight = false;
            pollMatchApi();
        }, 5000);
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
                    pollMatchApi();
                }
            }, 0);
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
        'SHOW_LAST_WICKET', 'SHOW_BIG_EVENT', 'SHOW_CRR', 'SET_OBS_SETTINGS',
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
                let syncMatch = data.match;
                if (data.match.obsOverlaySettings) {
                    applyObsOverlaySettings(data.match.obsOverlaySettings);
                }
                if (data.match.isManual && data.match.manualData) {
                    const manual = data.match.manualData;
                    syncMatch = JSON.parse(JSON.stringify(data.match));
                    syncMatch.currentInnings = 0;
                    syncMatch.overs = parseInt(manual.overs, 10) || syncMatch.overs || 0;
                    syncMatch.ballsPerOver = 6;
                    syncMatch.innings = syncMatch.innings || [{
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
                        currentBatsmenIdx: [0, 1],
                        strikerIdx: 0,
                        currentBowlerIdx: 0
                    }];
                }
                _lastOverlayFingerprint = '';
                _lastRenderedScoreKey = '';
                applyCloudScorePayload({ fullMatch: syncMatch }, { trustIncoming: true });
            }
            break;
        case 'SET_OBS_SETTINGS':
            if (data.settings) applyObsOverlaySettings(data.settings);
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
        case 'SHOW_GUEST':
            if (String(data.title || '').toUpperCase() === 'NEXT BATSMAN') {
                showNextBatsmanGraphic(data);
            } else {
                showGuestGraphic(data);
            }
            break;
        case 'SHOW_NEXT_BATSMAN': showNextBatsmanGraphic(data); break;
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

    let m = resolveOverlayMatch();
    if (!m && latestSocketScore?.fullMatch) {
        m = latestSocketScore.fullMatch;
    }
    if (m?.id && (!matchId || isMasterOverlay)) {
        matchId = m.id;
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
    if (document.body.classList.contains('obs-capture-mode')) {
        requestAnimationFrame(() => {
            overlaySyncScorebarInset();
            requestAnimationFrame(overlaySyncScorebarInset);
        });
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
    const batLogo = overlayTeamLogoForMatch(batTeam, m);
    const bowlLogo = overlayTeamLogoForMatch(bowlTeam, m);

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
    const bottomInsight = overlayBottomInsightText(m, curInn, bpo);
    const detailCfg = getOverlayDetailSettings(m);
    const detailText = `${detailCfg.groundName ? `GROUND: ${detailCfg.groundName}` : 'GROUND: -'}${
        detailCfg.organizedBy ? ` · ORGANIZED: ${detailCfg.organizedBy}` : ''
    }`;

    const sPhoto = overlayResolvePlayerPhoto(striker, 'striker', m);
    const nsPhoto = overlayResolvePlayerPhoto(nonStriker, 'nonstriker', m);
    const bowlPhoto = overlayResolvePlayerPhoto(bowler, 'bowler', m);
    const defPhoto = overlayEscapeHtml(OVERLAY_DEFAULT_PLAYER_PHOTO);

    const bowlOv = formatOvers(bowler.balls || 0, bpo);
    const bowlerFig = `${bowler.wickets ?? 0}-${bowler.runs ?? 0}`;

    const batterCell = (pl, photo, isStriker) => `
        <div class="m2-batter-cell ${isStriker ? 'm2-batter-cell--on' : ''}">
            <div class="m2-player-text">
                <div class="m2-batter-line">
                    <span class="m2-batter-name" title="${overlayEscapeHtml(pl.name || '')}">${overlayEscapeHtml(overlayDisplayName(pl.name))}</span>
                    <span class="m2-batter-score">${pl.runs ?? 0}<span class="m2-batter-balls">(${pl.balls ?? 0})</span></span>
                </div>
            </div>
            <div class="m2-photo-ring m2-photo-ring--batter">
                <img class="m2-photo" src="${overlayEscapeHtml(photo)}" alt="" loading="eager" decoding="async" onerror="this.onerror=null;this.src='${defPhoto}'">
            </div>
        </div>`;

    const bowlerRightBlock = `
        <div class="m2-bowler-block m2-bowler-block--right">
            <div class="m2-player-text m2-player-text--bowl">
                <span class="m2-bowler-label">BOWLER</span>
                <div class="m2-bowler-line">
                    <span class="m2-bowler-name" title="${overlayEscapeHtml(bowler.name || '')}">${overlayEscapeHtml(overlayDisplayName(bowler.name))}</span>
                </div>
                <div class="m2-bowler-line m2-bowler-line--stats">
                    <span class="m2-bowler-fig">${overlayEscapeHtml(bowlerFig)}</span>
                    <span class="m2-bowler-ov">${overlayEscapeHtml(bowlOv)}</span>
                    <span class="m2-bowler-econ">ECO ${overlayEscapeHtml(formatEconomy(bowler.runs, bowler.balls, bpo))}</span>
                </div>
            </div>
            <div class="m2-photo-ring m2-photo-ring--bowl-lg">
                <img class="m2-photo" src="${overlayEscapeHtml(bowlPhoto)}" alt="" loading="eager" decoding="async" onerror="this.onerror=null;this.src='${defPhoto}'">
            </div>
        </div>`;

    const bowlPanelHtml =
        detailCfg.detailMode === 'balls'
            ? `<div class="m2-bowl-right-col m2-bowl-right-col--balls">
                    ${bowlerRightBlock}
                    <div class="m2-ball-track">${overlayRenderBallTrackerHtml(curInn, bpo)}</div>
               </div>`
            : `<div class="m2-bowl-right-col m2-bowl-right-col--solo">${bowlerRightBlock}</div>`;

    container.innerHTML = `
        <div class="m2-shell">
            <div class="m2-pro-bar">
                <div class="m2-brand m2-brand--bat">
                    <div class="m2-brand-logo">
                        <img src="${overlayEscapeHtml(batLogo)}" alt="" loading="eager" decoding="async" onerror="${overlayBrandLogoOnError()}">
                        <span class="m2-logo-fallback" style="display:none">${overlayEscapeHtml(batShort)}</span>
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
                        ${
                            detailCfg.detailMode === 'match'
                                ? `<span class="m2-center-meta-main">${overlayEscapeHtml(detailText)}</span>
                                   <span class="m2-center-meta-sub">${overlayEscapeHtml(bottomInsight)}</span>`
                                : `<span>Projected Score : <strong>${projected}</strong></span>
                                   <span class="m2-stats-sep">·</span>
                                   <span>CRR : <strong>${crrVal}</strong></span>`
                        }
                    </div>
                </div>
                <div class="m2-panel m2-panel--bowl">
                    ${bowlPanelHtml}
                </div>
                <div class="m2-brand m2-brand--bowl">
                    <div class="m2-brand-logo">
                        <img src="${overlayEscapeHtml(bowlLogo)}" alt="" loading="eager" decoding="async" onerror="${overlayBrandLogoOnError()}">
                        <span class="m2-logo-fallback" style="display:none">${overlayEscapeHtml(bowlShort)}</span>
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
    const t1Logo = overlayTeamLogoForMatch(t1Name, m);
    const t2Logo = overlayTeamLogoForMatch(t2Name, m);

    const strikerIdx = curInn.currentBatsmenIdx ? curInn.currentBatsmenIdx[curInn.strikerIdx] : null;
    const striker = (strikerIdx != null && curInn.batsmen[strikerIdx]) ? curInn.batsmen[strikerIdx] : { name: 'Batter', runs: 0, balls: 0 };
    
    const nonStrikerIdx = curInn.currentBatsmenIdx ? curInn.currentBatsmenIdx[curInn.strikerIdx === 0 ? 1 : 0] : null;
    const nonStriker = (nonStrikerIdx != null && curInn.batsmen[nonStrikerIdx]) ? curInn.batsmen[nonStrikerIdx] : { name: 'Batter', runs: 0, balls: 0 };
    
    const bowler = (curInn.bowlers && curInn.currentBowlerIdx != null) ? curInn.bowlers[curInn.currentBowlerIdx] : { name: 'Bowler', wickets: 0, runs: 0, balls: 0 };
    const detailCfg = getOverlayDetailSettings(m);
    const venueLabel = detailCfg.groundName ? `GROUND: ${detailCfg.groundName}` : 'GROUND: -';
    const orgLabel = detailCfg.organizedBy ? `ORGANIZED: ${detailCfg.organizedBy}` : 'ORGANIZED: -';
    const bowlerName = String(bowler?.name || '').trim();
    const hasRealBowler = !!bowlerName && bowlerName.toLowerCase() !== 'bowler';
    const showRightMeta = true;
    const rightMetaPhoto = overlayResolvePlayerPhoto(bowler, 'bowler', m) || OVERLAY_DEFAULT_PLAYER_PHOTO;
    const rightMetaFallback = getShortName(hasRealBowler ? bowlerName : t2Name || 'TEAM');
    const bpo = m.ballsPerOver || 6;
    const crrVal = formatCRR(curInn.runs, curInn.balls, bpo);
    const rrrVal = formatRequiredRR(curInn, m);

    let effectiveSubMode = currentSubMode;
    if (m.currentInnings === 1 && effectiveSubMode === 1) effectiveSubMode = 3;

    let topText =
        detailCfg.detailMode === 'match'
            ? `${detailCfg.groundName ? `GROUND: ${detailCfg.groundName}` : 'GROUND: -'}${
                  detailCfg.organizedBy ? ` · ORGANIZED: ${detailCfg.organizedBy}` : ''
              }`
            : overlayBallHistoryText(curInn);
    let botText = overlayBottomInsightText(m, curInn, bpo);

    if (detailCfg.detailMode !== 'match' && effectiveSubMode === 3) {
        if (m.currentInnings === 1 && m.innings[0]) {
            const target = m.innings[0].runs + 1;
            const needed = target - curInn.runs;
            const ballsLeft = (m.overs * m.ballsPerOver) - curInn.balls;
            topText = `TARGET: ${target}`;
            botText = `NEED ${needed} RUNS FROM ${ballsLeft} BALLS`;
        }
    } else if (detailCfg.detailMode !== 'match' && effectiveSubMode === 2) {
        topText = `CURRENT RUN RATE`;
        botText = `CRR: ${crrVal}${rrrVal ? ` · REQ ${rrrVal}` : ''}`;
    }
    const projectedTotal = overlayProjectedScore(curInn, m);
    if ((m.currentInnings || 0) === 0) {
        botText = `PROJECTED: ${projectedTotal}`;
    } else if (m.innings && m.innings[0]) {
        const target = (m.innings[0].runs || 0) + 1;
        const needed = target - (curInn.runs || 0);
        botText = needed > 0 ? `TO WIN: ${needed} RUNS` : 'TARGET ACHIEVED';
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
                    <span class="m4-live-corner">LIVE</span>
                    <div class="m4-pill-top" id="m4-pill-top"></div>
                    <div class="m4-pill-mid">
                        <div class="m4-teams-row">
                            <span class="m4-teams" id="m4-teams-text"></span>
                        </div>
                        <div class="m4-score-row">
                            <span class="m4-score-box" id="m4-score-text"></span>
                        </div>
                        <div class="m4-overs-row">
                            <span class="m4-overs" id="m4-overs-text"></span>
                        </div>
                    </div>
                    <div class="m4-pill-bot" id="m4-pill-bot"></div>
                </div>
                <aside class="m4-wing m4-wing--bowl">
                    <div class="m4-bowler-section m4-bowler-section--meta" id="m4-right-meta">
                        <div class="m4-meta-wrap">
                            <div class="m4-meta-photo-ring">
                                <span class="m4-meta-photo-fallback" id="m4-meta-photo-fallback"></span>
                                <img id="m4-meta-photo" src="" alt="" onerror="this.style.display='none'">
                            </div>
                            <div class="m4-meta-line" id="m4-meta-venue"></div>
                            <div class="m4-meta-line" id="m4-meta-org"></div>
                            <div class="m4-meta-line m4-meta-line--accent" id="m4-meta-extra"></div>
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
    if (oText) oText.textContent = `OVERS: ${formatOvers(curInn.balls, m.ballsPerOver)}`;
    const pBot = document.getElementById('m4-pill-bot');
    if (pBot) pBot.textContent = botText;

    const m4Meta = document.getElementById('m4-right-meta');
    if (m4Meta) {
        m4Meta.classList.toggle('is-active', showRightMeta);
    }
    const m4Venue = document.getElementById('m4-meta-venue');
    if (m4Venue) {
        m4Venue.textContent = showRightMeta
            ? `BOWLER: ${overlayDisplayName(bowlerName || 'Bowler')}`
            : '';
    }
    const m4Org = document.getElementById('m4-meta-org');
    if (m4Org) {
        m4Org.textContent = showRightMeta
            ? `OVERS: ${formatOvers(bowler.balls || 0, bpo)}`
            : '';
    }
    const m4Extra = document.getElementById('m4-meta-extra');
    if (m4Extra) {
        m4Extra.textContent = showRightMeta
            ? `FIG: ${bowler.wickets || 0}-${bowler.runs || 0}`
            : '';
    }
    const m4MetaFallback = document.getElementById('m4-meta-photo-fallback');
    if (m4MetaFallback) m4MetaFallback.textContent = rightMetaFallback || 'TM';
    const m4MetaPhoto = document.getElementById('m4-meta-photo');
    if (m4MetaPhoto) {
        m4MetaPhoto.src = rightMetaPhoto;
        m4MetaPhoto.style.display = rightMetaPhoto ? 'block' : 'none';
    }

    const rBalls = document.getElementById('m4-recent-balls');
    if (rBalls) {
        if (detailCfg.detailMode === 'balls') {
            rBalls.innerHTML = recentBalls;
            rBalls.style.visibility = 'visible';
        } else {
            rBalls.innerHTML = '';
            rBalls.style.visibility = 'hidden';
        }
    }

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
    if (document.body.classList.contains('obs-capture-mode')) {
        requestAnimationFrame(() => {
            overlaySyncScorebarInset();
            requestAnimationFrame(overlaySyncScorebarInset);
        });
    }

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

function showNextBatsmanGraphic(data) {
    if (!data) return;
    const photo = data.playerPhoto || data.photo || OVERLAY_DEFAULT_PLAYER_PHOTO;
    const hasPhoto = overlaySquadHasCustomPhoto(photo);
    const name = overlayDisplayName(data.playerName || data.name || 'BATTER');
    const team = String(data.teamName || data.battingTeam || 'TEAM').toUpperCase();
    const initials = overlayPlayerInitials(data.playerName || data.name || 'NB');
    const defPhoto = overlayEscapeHtml(OVERLAY_DEFAULT_PLAYER_PHOTO);

    const el = document.createElement('div');
    el.className =
        'broadcast-overlay nb-overlay overlay-visible bo-graphic-bl pp-overlay';
    el.style.display = 'block';
    el.style.left = '40px';
    overlayPositionAboveScorebar(el);

    el.innerHTML = `
        <div class="nb-card">
            <div class="nb-accent" aria-hidden="true"></div>
            <div class="nb-photo-wrap${hasPhoto ? '' : ' nb-photo-wrap--default'}">
                ${hasPhoto ? '' : `<span class="nb-initials" aria-hidden="true">${overlayEscapeHtml(initials)}</span>`}
                <img class="nb-photo" src="${overlayEscapeHtml(photo)}" alt="" loading="eager" decoding="async"
                    onerror="this.onerror=null;this.src='${defPhoto}';this.closest('.nb-photo-wrap')?.classList.add('nb-photo-wrap--default');">
            </div>
            <div class="nb-body">
                <div class="nb-label">NEXT <em>Batsman</em></div>
                <div class="nb-name">${overlayEscapeHtml(name)}</div>
                <div class="nb-team">${overlayEscapeHtml(team)}</div>
            </div>
            <span class="nb-pulse-ring" aria-hidden="true"></span>
            <span class="nb-badge" aria-hidden="true">🏏</span>
        </div>`;

    document.body.appendChild(stampBroadcastOverlay(el));

    const card = el.querySelector('.nb-card');
    const img = el.querySelector('.nb-photo');
    const label = el.querySelector('.nb-label');
    const nm = el.querySelector('.nb-name');
    const badge = el.querySelector('.nb-badge');

    const hideMs = 6500;
    if (typeof gsap !== 'undefined' && gsap.timeline) {
        const tl = gsap.timeline();
        tl.fromTo(el, { x: -120, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: 'power3.out' });
        if (card) {
            tl.fromTo(
                card,
                { scale: 0.88, opacity: 0, filter: 'blur(8px)' },
                { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 0.65, ease: 'power3.out' },
                '-=0.25'
            );
        }
        if (img) {
            tl.fromTo(
                img,
                { x: 40, opacity: 0, scale: 0.85 },
                { x: 0, opacity: 1, scale: 1, duration: 0.55, ease: 'power2.out' },
                '-=0.45'
            );
        }
        if (label) {
            tl.fromTo(label, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.4');
        }
        if (nm) {
            tl.fromTo(nm, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: 'power2.out' }, '-=0.32');
        }
        if (badge) {
            tl.fromTo(
                badge,
                { scale: 0, rotation: -30 },
                { scale: 1, rotation: 0, duration: 0.5, ease: 'back.out(2.2)' },
                '-=0.35'
            );
        }
        setTimeout(() => {
            gsap.to(el, {
                x: -100,
                opacity: 0,
                duration: 0.5,
                ease: 'power2.in',
                onComplete: () => el.remove(),
            });
        }, hideMs);
    } else {
        setTimeout(() => el.remove(), hideMs);
    }
}

function showGuestGraphic(data) {
    const photo = data.playerPhoto || data.photo || OVERLAY_DEFAULT_PLAYER_PHOTO;
    const name = (data.playerName || data.name || 'GUEST').toUpperCase();
    const role = (data.title || 'SPECIAL GUEST').toUpperCase();
    if (role === 'NEXT BATSMAN') {
        showNextBatsmanGraphic(data);
        return;
    }

    const el = document.createElement('div');
    el.className = 'broadcast-overlay overlay-visible';
    el.style.display = 'block';
    el.style.left = '40px';
    el.style.top = 'auto';
    overlayPositionAboveScorebar(el);

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

function getOverlayCurrentMatchForSummary() {
    if (matchId && typeof DB !== 'undefined' && DB.getMatch) {
        const byId = DB.getMatch(matchId);
        if (byId) return byId;
    }
    if (latestSocketScore?.fullMatch) return latestSocketScore.fullMatch;
    return null;
}

function renderBroadcastSummarySheet() {
    const host = document.getElementById('sm-content');
    if (!host) return;
    const m = getOverlayCurrentMatchForSummary();
    if (!m) {
        host.innerHTML = '<div class="sm-empty">NO LIVE MATCH DATA</div>';
        return;
    }
    const inn0 = Array.isArray(m.innings) ? m.innings[0] : null;
    const inn1 = Array.isArray(m.innings) ? m.innings[1] : null;
    const bpo = m.ballsPerOver || 6;
    const scoreLine = (inn) =>
        inn ? `${inn.runs || 0}/${inn.wickets || 0} (${formatOvers(inn.balls || 0, bpo)})` : '—';
    const target = inn0 ? (inn0.runs || 0) + 1 : 0;
    const toWin = inn1 ? Math.max(0, target - (inn1.runs || 0)) : target;
    const t1Runs =
        (inn0?.battingTeam === m.team1 ? inn0?.runs : inn1?.battingTeam === m.team1 ? inn1?.runs : 0) || 0;
    const t2Runs =
        (inn0?.battingTeam === m.team2 ? inn0?.runs : inn1?.battingTeam === m.team2 ? inn1?.runs : 0) || 0;
    let resultLine = 'LIVE MATCH';
    if (m.status === 'completed') {
        if (t1Runs > t2Runs) resultLine = `${overlayEscapeHtml((m.team1 || 'TEAM A').toUpperCase())} WON BY ${t1Runs - t2Runs} RUNS`;
        else if (t2Runs > t1Runs) resultLine = `${overlayEscapeHtml((m.team2 || 'TEAM B').toUpperCase())} WON BY ${t2Runs - t1Runs} RUNS`;
        else resultLine = 'MATCH TIED';
    } else if (target) {
        resultLine = toWin > 0 ? `${toWin} RUNS NEEDED TO WIN` : 'TARGET ACHIEVED';
    }
    const title = overlayEscapeHtml((m.tournamentName || m.team1 || 'MATCH SUMMARY').toUpperCase());
    const t1 = overlayEscapeHtml((m.team1 || 'TEAM A').toUpperCase());
    const t2 = overlayEscapeHtml((m.team2 || 'TEAM B').toUpperCase());

    host.innerHTML = `
      <div class="sm-card">
        <div class="sm-header">
          <h2 class="sm-title">MATCH SUMMARY</h2>
          <div class="sm-subtitle">${title}</div>
        </div>
        <div class="sm-result-line">${resultLine}</div>
        <div class="sm-innings-grid">
          <div class="sm-inn-card">
            <div class="sm-inn-title">${t1}</div>
            <div class="sm-inn-score">${scoreLine(inn0?.battingTeam === m.team1 ? inn0 : inn1)}</div>
          </div>
          <div class="sm-inn-card">
            <div class="sm-inn-title">${t2}</div>
            <div class="sm-inn-score">${scoreLine(inn0?.battingTeam === m.team2 ? inn0 : inn1)}</div>
          </div>
        </div>
        <div class="sm-grid">
          <div class="sm-row"><span class="k">STATUS</span><span class="v">${overlayEscapeHtml((m.status || 'LIVE').toUpperCase())}</span></div>
          <div class="sm-row"><span class="k">TARGET</span><span class="v">${target || '—'}</span></div>
          <div class="sm-row"><span class="k">TO WIN</span><span class="v">${target ? `${toWin} RUNS` : '—'}</span></div>
          <div class="sm-row"><span class="k">OVERS LIMIT</span><span class="v">${m.overs || '—'} OV</span></div>
          <div class="sm-row"><span class="k">LAST UPDATE</span><span class="v">${new Date(m.lastUpdated || Date.now()).toLocaleTimeString()}</span></div>
        </div>
      </div>
    `;
}

function toggleBroadcastSummary(tId) {
    const el = document.getElementById('broadcast-summary');
    if (!el) return;
    if (el.classList.contains('overlay-visible') || el.style.display === 'block') {
        el.classList.remove('overlay-visible');
        gsap.to(el, { opacity: 0, y: 100, duration: 0.5, onComplete: () => { el.style.display = 'none'; } });
    } else {
        renderBroadcastSummarySheet();
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
        teamLogo: overlayResolveTeamLogo(data.teamLogo) || overlayDefaultTeamPhoto(),
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
    el.style.top = 'auto';
    el.style.bottom = '';
    el.style.transform = 'translateX(-50%)';
    if (document.body.classList.contains('obs-capture-mode')) {
        requestAnimationFrame(() => {
            overlaySyncScorebarInset();
            requestAnimationFrame(overlaySyncScorebarInset);
        });
    }

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
        overlayPositionAboveScorebar(el);
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
    document.querySelectorAll('.partnership-overlay').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 'broadcast-overlay overlay-visible partnership-overlay';
    
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

    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    overlaySyncScorebarInset();
    el.style.display = 'flex';
    el.style.alignItems = 'flex-end';
    el.style.justifyContent = 'center';
    el.style.zIndex = '28620';

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
    requestAnimationFrame(overlaySyncScorebarInset);

    const centerCard = el.querySelector('.partnership-center-card');
    const playerCards = el.querySelectorAll('.partnership-player-card');

    gsap.fromTo(centerCard, { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.7, ease: 'expo.out' });
    gsap.fromTo(playerCards[0], { x: -100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.7, delay: 0.2, ease: 'back.out' });
    gsap.fromTo(playerCards[1], { x: 100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.7, delay: 0.2, ease: 'back.out' });

    setTimeout(() => gsap.to(el, { opacity: 0, duration: 0.45, onComplete: () => el.remove() }), 5000);
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

