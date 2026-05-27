// ================================================
//  SLCRICKPRO – Scorer Engine v2 (FIXED)
//  Bugs fixed: wicket fall, leg bye, partnership
// ================================================

// ── Shared Utility: also defined in overlay.js for TV page ──
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

let currentMatch = null;
let currentMatchType = 'single';
let wicketRuns = 0;
let byeExtraType = 'bye';
let byeRuns = 1;
let currentPendingWicket = 0;
let pendingBallEvent = null;
let pendingExtraType = null;
let _innings_ending = false; // guard to prevent double-modal
/** 4/6/W TV graphics — hotkeys only unless user enables auto in settings */
let autoAnimationsEnabled = localStorage.getItem('cricpro_auto_anim') === 'true';

function updateAutoAnimation(enabled) {
    autoAnimationsEnabled = enabled;
    localStorage.setItem('cricpro_auto_anim', enabled);
    showToast(enabled ? '🚀 Auto-Animations Enabled' : '⏸ Auto-Animations Disabled', 'default');
}

function getBroadcastProfileSettings() {
    try {
        return {
            withData: localStorage.getItem('cricpro_profile_with_data') !== 'false',
            autoBatsman: localStorage.getItem('cricpro_auto_profile_bat') !== 'false',
            autoBowler: localStorage.getItem('cricpro_auto_profile_bowl') !== 'false',
        };
    } catch (_) {
        return { withData: true, autoBatsman: true, autoBowler: true };
    }
}

function loadBroadcastProfileOptions() {
    const s = getBroadcastProfileSettings();
    const wd = document.getElementById('opt-profile-with-data');
    const ab = document.getElementById('opt-profile-auto-bat');
    const abl = document.getElementById('opt-profile-auto-bowl');
    if (wd) wd.checked = s.withData;
    if (ab) ab.checked = s.autoBatsman;
    if (abl) abl.checked = s.autoBowler;
}

function saveBroadcastProfileOptions() {
    const withData = document.getElementById('opt-profile-with-data')?.checked !== false;
    const autoBatsman = document.getElementById('opt-profile-auto-bat')?.checked !== false;
    const autoBowler = document.getElementById('opt-profile-auto-bowl')?.checked !== false;
    localStorage.setItem('cricpro_profile_with_data', withData ? 'true' : 'false');
    localStorage.setItem('cricpro_auto_profile_bat', autoBatsman ? 'true' : 'false');
    localStorage.setItem('cricpro_auto_profile_bowl', autoBowler ? 'true' : 'false');
    showToast('Profile options saved', 'success');
}

function maybeAutoBroadcastPlayerProfile(role) {
    const s = getBroadcastProfileSettings();
    if (role === 'bowler') {
        if (!s.autoBowler) return;
        setTimeout(() => broadcastBowlerProfile(), 900);
        return;
    }
    if (!s.autoBatsman) return;
    setTimeout(() => broadcastStrikerProfile(), 900);
}

let currentTournament = null;
let _pendingTournPayload = null;
let _fsrCurrentTeamIndex = 0;
let _fsrActivePhotoTarget = null;
const SCORING_AUTH_KEY = 'cricpro_scoring_auth';
let currentOverlayTeam = null;
let currentOverlayPlayer = null;
let activeOverlayId = null;
const DEFAULT_PLAYER_PHOTO = '../assets/default-player.svg';
const DEFAULT_TEAM_PHOTO = '../assets/default-team.svg';

function getOnCreaseBatterNames(inn) {
    if (!inn || !Array.isArray(inn.batsmen) || !Array.isArray(inn.currentBatsmenIdx)) return [];
    const names = [];
    for (const slot of [0, 1]) {
        const idx = inn.currentBatsmenIdx[slot];
        if (idx != null && inn.batsmen[idx]) names.push(inn.batsmen[idx].name);
    }
    return names.filter(Boolean);
}

function getStrikerBatterName(inn) {
    if (!inn || !Array.isArray(inn.batsmen) || !Array.isArray(inn.currentBatsmenIdx)) return null;
    const slot = inn.strikerIdx === 1 ? 1 : 0;
    const idx = inn.currentBatsmenIdx[slot];
    return idx != null && inn.batsmen[idx] ? inn.batsmen[idx].name : null;
}


function calculateAge(dob) {
    if (!dob) return "";
    try {
        const birthDate = new Date(dob);
        if (isNaN(birthDate.getTime())) return "";
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }
        return age > 0 ? age : "";
    } catch(e) { return ""; }
}

function resolvePlayerProfileForBatter(inn, bName) {
    if (!bName || !inn || !Array.isArray(inn.batsmen)) return null;
    const bRec = inn.batsmen.find(x => x.name === bName);
    if (bRec && bRec.playerId) {
        const byId = DB.getPlayerById(bRec.playerId);
        if (byId) return byId;
    }
    return DB.getPlayers().find(x => x.name.toLowerCase().trim() === bName.toLowerCase().trim()) || null;
}

function playerPhotoSrc(p) {
    if (p && p.photo && String(p.photo).trim()) return p.photo;
    if (p && p.playerId) {
        const cached = localStorage.getItem('cricpro_photo_' + p.playerId);
        if (cached) return cached;
    }
    return DEFAULT_PLAYER_PHOTO;
}

const BROADCAST_PHOTO_DEFAULT = '../assets/default-player.svg';

function bindPhotoSlotToPlayer(role, player) {
    const pid = String(player?.playerId || player?.name || '');
    const boundKey = `__photo_bound_${role}`;
    if (window[boundKey] !== pid) {
        window[boundKey] = pid;
        window[`__photo_cleared_${role}`] = false;
        if (role === 'striker') window.__photo_striker = null;
        else if (role === 'nonstriker') window.__photo_nonstriker = null;
        else if (role === 'bowler') window.__photo_bowler = null;
    }
}

function setBroadcastPhotoPreviewEl(elId, src) {
    const el = document.getElementById(elId);
    if (!el) return;
    const isDefault = !src || src === BROADCAST_PHOTO_DEFAULT;
    if (el.tagName === 'IMG') {
        el.src = isDefault ? BROADCAST_PHOTO_DEFAULT : src;
        return;
    }
    el.innerHTML = isDefault
        ? '📷'
        : `<img src="${src}" style="width:100%;height:100%;object-fit:contain;border-radius:10px" alt="">`;
}

function syncLivePlayerPhotoSlots(m) {
    if (!m || !m.innings) return;
    const inn = m.innings[m.currentInnings ?? 0];
    if (!inn) return;

    const slots =
        typeof getInningsPlayersForPhotoSlots === 'function'
            ? getInningsPlayersForPhotoSlots(m)
            : (() => {
                  const sIdx = inn.currentBatsmenIdx?.[inn.strikerIdx ?? 0];
                  const nsIdx = inn.currentBatsmenIdx?.[inn.strikerIdx === 0 ? 1 : 0];
                  return {
                      striker: sIdx != null ? inn.batsmen?.[sIdx] : null,
                      nonstriker: nsIdx != null ? inn.batsmen?.[nsIdx] : null,
                      bowler:
                          inn.currentBowlerIdx != null
                              ? inn.bowlers?.[inn.currentBowlerIdx]
                              : null,
                  };
              })();

    const uiMap = {
        striker: {
            imgs: ['bm-photo-striker', 'preview_striker'],
            names: ['bm-name-striker', 'bm-label-striker'],
        },
        nonstriker: {
            imgs: ['bm-photo-nonstriker', 'preview_nonstriker'],
            names: ['bm-name-nonstriker', 'bm-label-nonstriker'],
        },
        bowler: {
            imgs: ['bm-photo-bowler', 'preview_bowler'],
            names: ['bm-name-bowler', 'bm-label-bowler'],
        },
    };

    Object.keys(uiMap).forEach((role) => {
        const player = slots[role];
        if (player) bindPhotoSlotToPlayer(role, player);
        const src =
            typeof getBroadcastPhotoForRole === 'function'
                ? getBroadcastPhotoForRole(role, player) || BROADCAST_PHOTO_DEFAULT
                : player?.playerId && DB.getPlayerPhoto
                  ? DB.getPlayerPhoto(player.playerId) || BROADCAST_PHOTO_DEFAULT
                  : BROADCAST_PHOTO_DEFAULT;
        uiMap[role].imgs.forEach((id) => setBroadcastPhotoPreviewEl(id, src));
        const label = player?.name || (role === 'bowler' ? 'NO BOWLER' : 'NO PLAYER');
        uiMap[role].names.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = label;
        });
        if (role === 'striker' || role === 'nonstriker') {
            if (!window[`__photo_cleared_${role}`] && src !== BROADCAST_PHOTO_DEFAULT) {
                if (role === 'striker') window.__photo_striker = src;
                else window.__photo_nonstriker = src;
            }
        } else if (role === 'bowler' && !window.__photo_cleared_bowler && src !== BROADCAST_PHOTO_DEFAULT) {
            window.__photo_bowler = src;
        }
    });

    if (inn.currentPartnership || (inn.partnerships && inn.partnerships.length)) {
        const p = inn.currentPartnership || inn.partnerships[inn.partnerships.length - 1];
        const el = document.getElementById('bm-label-partner');
        if (el) el.textContent = `${p.runs || 0} off ${p.balls || 0}`;
    }

    const t1Logo = DB.getTeamPhoto(m.team1, m.tournamentId);
    const t2Logo = DB.getTeamPhoto(m.team2, m.tournamentId);
    const t1Img = document.getElementById('bm-photo-team1');
    const t2Img = document.getElementById('bm-photo-team2');
    if (t1Img) t1Img.src = t1Logo || '../assets/default-team.svg';
    if (t2Img) t2Img.src = t2Logo || '../assets/default-team.svg';

    const setTeamLbl = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setTeamLbl('btn-team1-label-photo', m.team1 || 'TEAM 1');
    setTeamLbl('btn-team2-label-photo', m.team2 || 'TEAM 2');
    setTeamLbl('btn-team1-label', m.team1 || 'TEAM A');
    setTeamLbl('btn-team2-label', m.team2 || 'TEAM 2');
    const vsEl = document.getElementById('bm-vs-indicator');
    if (vsEl) vsEl.textContent = 'Overlay linked';
    const scoreEl = document.getElementById('bm-score-indicator');
    if (scoreEl) {
        scoreEl.textContent = `${inn.runs || 0}/${inn.wickets || 0}`;
    }
    const crr = inn.balls ? ((inn.runs / inn.balls) * 6).toFixed(2) : '0.00';
    const crrEl = document.getElementById('bm-crr-val');
    if (crrEl) crrEl.textContent = `CRR: ${crr}`;

    if (typeof enrichMatchBroadcastMedia === 'function') enrichMatchBroadcastMedia(m);
}

function clearPlayerPhotoSlot(role) {
    if (!['striker', 'nonstriker', 'bowler'].includes(role)) return;
    window[`__photo_cleared_${role}`] = true;
    if (role === 'striker') window.__photo_striker = null;
    else if (role === 'nonstriker') window.__photo_nonstriker = null;
    else window.__photo_bowler = null;
    const m = currentMatch || window.currentMatch;
    if (m) syncLivePlayerPhotoSlots(m);
    if (typeof showToast === 'function') {
        showToast('Photo hidden on overlay only (database unchanged)', 'default');
    }
}

window.syncLivePlayerPhotoSlots = syncLivePlayerPhotoSlots;
window.syncBroadcastMasterPhotos = syncLivePlayerPhotoSlots;
window.clearPlayerPhotoSlot = clearPlayerPhotoSlot;

document.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const mId = urlParams.get('matchId');
    const tId = urlParams.get('tournamentId');

    if (urlParams.get('obsPopup') === '1') {
        document.documentElement.classList.add('obs-popup-mode');
        wireDesktopMatchSyncFromPopups();
    }

    if (urlParams.get('popupScore') === '1') {
        document.documentElement.classList.add('popup-score-mode');
        document.title = 'Popup Score — SLCRICKPRO';
        if (localStorage.getItem('theme') !== 'dark') {
            document.body.classList.add('light-mode');
        }
        wireDesktopMatchSyncFromPopups();
    }

    if (window.SLCRICK_DESKTOP) {
        if (localStorage.getItem('cricpro_auto_popup_scorecard') !== 'true') {
            localStorage.setItem('cricpro_auto_popup_scorecard', 'false');
        }
        if (localStorage.getItem('cricpro_auto_popup_obs') !== 'true') {
            localStorage.setItem('cricpro_auto_popup_obs', 'false');
        }
        wireDesktopMatchSyncFromPopups();
    }

    // ISOLATE BROADCAST CONTROLLER IMMEDIATELY
    if (urlParams.get('hotkey') === 'true' && (mId || tId)) {
        document.body.classList.add('broadcast-controller-active');
        const wrapper = document.querySelector('.page-wrapper');
        if (wrapper) wrapper.innerHTML = '<div style="text-align:center; padding:100px; color:#ffc107; font-size:24px">📡 Broadcast Remote Connecting...</div>';
        
        if (typeof window.pullGlobalData === 'function') {
            await window.pullGlobalData();
        }

        let m = null;
        if (mId) m = DB.getMatch(mId);
        else if (tId) {
            currentTournament = DB.getTournament(tId);
            m = DB.getMatches().find(mx => mx.tournamentId === tId && (mx.status === 'live' || mx.status === 'paused'));
        }
        
        if (m) {
            currentMatch = m;
            renderBroadcastController(m);
        } else if (tId) {
            if (wrapper) wrapper.innerHTML = `
                <div style="text-align:center; padding:100px; color:#fff;">
                    <div style="font-size:48px; margin-bottom:20px">⏳</div>
                    <div style="font-size:24px; font-weight:800; color:#ffc107; margin-bottom:10px">Waiting for Live Match</div>
                    <div style="font-size:14px; opacity:0.6; margin-bottom: 30px">Tournament Broadcast Station is active and waiting for the next match to start.</div>
                    <button class="btn btn-ghost" onclick="window.close()">Close</button>
                </div>
            `;
            const waitInterval = setInterval(async () => {
                if (typeof window.pullGlobalData === 'function') await window.pullGlobalData();
                const liveMatch = DB.getMatches().find(mx => mx.tournamentId === tId && (mx.status === 'live' || mx.status === 'paused'));
                if (liveMatch) {
                    clearInterval(waitInterval);
                    currentMatch = liveMatch;
                    renderBroadcastController(liveMatch);
                }
            }, 5000);
            window._broadcastWaitInterval = waitInterval;
        }
        return; // STOP HERE
    }

    // Sync in background — do not block scheduling UI
    if (typeof window.pullGlobalData === 'function') {
        window.pullGlobalData().catch(() => {});
    }

    const tf = document.getElementById('tourn-format');
    if (tf) {
        tf.addEventListener('change', (e) => {
            const kg = document.getElementById('knockout-team-count-group');
            if (kg) kg.style.display = e.target.value === 'knockout' ? 'block' : 'none';
        });
    }

    const bootSetup = () => {
        if (!mId && !tId) selectMatchType('tournament');
        else selectMatchType('single');
        renderResumeMatches();
    };
    bootSetup();
    if (window.SLCRICK_DESKTOP) {
        window.addEventListener('slcrick-db-ready', () => renderResumeMatches());
    }

    // Auto-refresh Open Match list every 10 seconds (slightly slower to avoid spamming)
    setInterval(() => {
        if (document.getElementById('screen-setup') &&
            document.getElementById('screen-setup').style.display !== 'none') {
            renderResumeMatches();
        }
    }, 10000);
    
    // Check for matchId parameter for direct scoring access
    if (mId) {
        let m = DB.getMatch(mId);
        // If not found, try one more sync just in case
        if (!m && typeof window.pullGlobalData === 'function') {
            await window.pullGlobalData();
            m = DB.getMatch(mId);
        }

        if (m) {
            if (m.status === 'scheduled') {
                startOfficialMatch(mId);
            } else if (m.status === 'live' || m.status === 'paused') {
                resumeMatch(mId);
            }
        } else {
            console.warn('Match not found even after sync:', mId);
        }
    } else if (tId) {
        showScreen('setup'); 
        // Ensure hub is opened only after ensuring we have the tournament in DB
        let t = DB.getTournament(tId);
        if (!t && typeof window.pullGlobalData === 'function') {
            await window.pullGlobalData();
        }
        openTournamentHub(tId);
    } else {
        showScreen('setup');
    }
});

function getScoringAuthMap() {
    try {
        return JSON.parse(localStorage.getItem(SCORING_AUTH_KEY) || '{}');
    } catch {
        return {};
    }
}

function saveScoringAuthMap(map) {
    localStorage.setItem(SCORING_AUTH_KEY, JSON.stringify(map || {}));
}

function setTournamentAuthorized(tournamentId, token, expiresInMs) {
    if (!tournamentId || !token) return;
    const map = getScoringAuthMap();
    map[tournamentId] = {
        token,
        exp: Date.now() + (Number(expiresInMs) || (2 * 60 * 60 * 1000))
    };
    saveScoringAuthMap(map);
}
window.setTournamentAuthorized = setTournamentAuthorized;

function getTournamentToken(tournamentId) {
    if (!tournamentId) return null;
    const map = getScoringAuthMap();
    const auth = map[tournamentId];
    if (!auth || !auth.token || !auth.exp || auth.exp < Date.now()) return null;
    return auth.token;
}

function isTournamentAuthorized(tournamentId) {
    return !!getTournamentToken(tournamentId);
}
window.isTournamentAuthorized = isTournamentAuthorized;

/** In-hub session only (cleared when tournament dashboard closes). */
const TOURNAMENT_SESSION_AUTH_MS = 1000 * 60 * 60 * 4;

function clearTournamentAuthorization(tournamentId) {
    if (!tournamentId) return;
    const map = getScoringAuthMap();
    if (map[tournamentId]) {
        delete map[tournamentId];
        saveScoringAuthMap(map);
    }
}
window.clearTournamentAuthorization = clearTournamentAuthorization;

function isTournamentHubSessionActive(tournamentId) {
    return _tournamentUnlockedThisVisit === tournamentId;
}

function markTournamentSessionUnlocked(tournamentId) {
    if (!tournamentId) return;
    _tournamentUnlockedThisVisit = tournamentId;
    setTournamentAuthorized(tournamentId, 'session', TOURNAMENT_SESSION_AUTH_MS);
}

function closeTournamentHub() {
    if (currentTournament?.id) {
        clearTournamentAuthorization(currentTournament.id);
        if (_tournamentUnlockedThisVisit === currentTournament.id) _tournamentUnlockedThisVisit = null;
    }
    currentTournament = null;
    closeModal('modal-tournament-matches');
}
window.closeTournamentHub = closeTournamentHub;

let _loginPendingAction = null;
/** Set after password OK; cleared when tournament dashboard is closed. */
let _tournamentUnlockedThisVisit = null;

function tournamentHasPassword(t) {
    if (!t) return false;
    return !!(t.scoringPassword || t.password || t.isLocked);
}
window.tournamentHasPassword = tournamentHasPassword;

function matchNeedsPassword(m, t) {
    if (!m) return false;
    if (m.scoringPassword || m.password || m.isLocked) return true;
    if (m.tournamentId && t) return tournamentHasPassword(t);
    return false;
}
window.matchNeedsPassword = matchNeedsPassword;

function repairTournamentPasswordCache(t) {
    if (!t?.id || !window.DB) return t;
    const stored = localStorage.getItem(`tourn_pw_${t.id}`);
    if (stored && !t.scoringPassword && !t.password) {
        t.scoringPassword = stored;
        try {
            DB.saveTournament(t, true, { skipPublish: true, skipForceUpdate: true });
        } catch (_) {}
    }
    return t;
}

function showTournamentLoginScreen(t, pending) {
    if (!t) return;
    t = repairTournamentPasswordCache(t);
    _loginPendingAction = pending || { type: 'hub' };
    currentTournament = t;
    const titleEl = document.getElementById('login-match-title');
    const subEl = document.getElementById('login-match-sub');
    if (titleEl) titleEl.textContent = t.name || 'Tournament';
    if (subEl) {
        subEl.textContent = pending?.type === 'match'
            ? 'Enter the tournament scoring password to start or resume this match.'
            : 'Enter the tournament scoring password every time you open this dashboard.';
    }
    const pwEl = document.getElementById('login-password');
    if (pwEl) pwEl.value = '';
    const hint = document.getElementById('login-desktop-hint');
    if (hint) hint.style.display = window.SLCRICK_DESKTOP ? 'block' : 'none';
    showScreen('login');
    setTimeout(() => pwEl?.focus(), 80);
}
window.showTournamentLoginScreen = showTournamentLoginScreen;

function showMatchLoginScreen(m, pending) {
    if (!m) return;
    _loginPendingAction = pending || { type: 'match', matchId: m.id };
    currentMatch = m;
    currentTournament = m.tournamentId ? DB.getTournament(m.tournamentId) : null;
    const titleEl = document.getElementById('login-match-title');
    const subEl = document.getElementById('login-match-sub');
    if (titleEl) titleEl.textContent = `${m.team1 || 'Team A'} vs ${m.team2 || 'Team B'}`;
    if (subEl) subEl.textContent = 'Enter the scoring password for this match.';
    const pwEl = document.getElementById('login-password');
    if (pwEl) pwEl.value = '';
    showScreen('login');
    setTimeout(() => pwEl?.focus(), 80);
}
window.showMatchLoginScreen = showMatchLoginScreen;

function openTournamentHubAfterAuth(t) {
    if (!t) return;
    currentTournament = t;
    const title = document.getElementById('tm-title');
    if (title) title.textContent = currentTournament.name;
    const modal = document.getElementById('modal-tournament-matches');
    if (modal) modal.style.display = 'flex';
    switchTournamentTab('matches');
}

async function ensureTournamentAccess(tournamentId, pending) {
    if (!tournamentId) return true;
    let t = DB.getTournament(tournamentId);
    if (!t && typeof window.pullGlobalData === 'function') {
        await window.pullGlobalData();
        t = DB.getTournament(tournamentId);
    }
    if (!t || !tournamentHasPassword(t)) return true;
    if (isTournamentHubSessionActive(tournamentId) || isTournamentAuthorized(tournamentId)) return true;
    showTournamentLoginScreen(t, pending || { type: 'hub' });
    return false;
}
window.ensureTournamentAccess = ensureTournamentAccess;

async function completeLoginSuccess(actionIn) {
    const action = actionIn || _loginPendingAction;
    _loginPendingAction = null;
    const t = currentTournament;
    const m = currentMatch;

    try {
        if (action?.type === 'match' && action.matchId) {
            showScreen('setup');
            currentTournament = null;
            if (typeof onResumeOrStart === 'function') {
                await onResumeOrStart(action.matchId, action.tournamentId || t?.id || '', !!action.isStart);
            }
            return;
        }

        if (t) {
            showScreen('setup');
            openTournamentHubAfterAuth(t);
            return;
        }

        if (m) {
            showScreen('setup');
            if (typeof loadMatch === 'function') loadMatch(m);
        }
    } catch (e) {
        console.error('[Login] completeLoginSuccess failed', e);
        showScreen('setup');
        if (t) {
            try {
                openTournamentHubAfterAuth(t);
            } catch (e2) {
                console.error('[Login] hub open failed', e2);
            }
        }
        showToast('Opened dashboard — if blank, click Dashboard again', 'default');
    }
}

// ========== SCREEN ==========
function showScreen(name) {
    document.querySelectorAll('.scorer-screen').forEach((s) => {
        s.style.display = 'none';
        s.classList.remove('active');
    });
    const el = document.getElementById('screen-' + name);
    if (el) {
        el.style.display = 'block';
        el.classList.add('active');
    }
    if (name !== 'login') {
        const login = document.getElementById('screen-login');
        if (login) {
            login.style.display = 'none';
            login.classList.remove('active');
        }
    }
}

function handleBack() {
    if (currentMatch && (currentMatch.status === 'live' || currentMatch.status === 'paused')) {
        if (confirm('Match is in progress. It will be saved. Go back?')) pauseAndExit(true);
    } else if (currentMatch && currentMatch.tournamentId) {
        openTournamentHub(currentMatch.tournamentId);
        currentMatch = null;
    } else if (currentTournament) {
        openTournamentHub(currentTournament.id);
        currentTournament = null;
    } else { location.href = '../index.html'; }
}

// ========== EVENT LISTENERS & INITIALIZATION ==========


// ========== SETUP ==========
function selectMatchType(type) {
    currentMatchType = type;
    const btnSingle = document.getElementById('type-single');
    const btnTourn = document.getElementById('type-tournament');
    const btnNRR = document.getElementById('type-instant-nrr');
    
    if (btnSingle) btnSingle.classList.toggle('active', type === 'single');
    if (btnTourn) btnTourn.classList.toggle('active', type === 'tournament');
    if (btnNRR) btnNRR.classList.toggle('active', type === 'instant-nrr');
    
    const tournSection = document.getElementById('tournament-setup-section');
    if (tournSection) {
        tournSection.style.display = type === 'tournament' ? 'block' : 'none';
    }
    
    const matchConfigCard = document.getElementById('match-config-card');
    if (matchConfigCard) {
        matchConfigCard.style.display = type === 'tournament' ? 'none' : '';
    }

    if (type === 'tournament') {
        onTournamentSelect('new');
        showTossConfig(false); 
        toggleMatchConfig(false);
    } else if (type === 'instant-nrr') {
        showScreen('instant-nrr');
    } else {
        toggleMatchConfig(true);
        showTossConfig(false); 
    }
}


function toggleOfficialSettings(val) {
    const el = document.getElementById('official-settings');
    if (el) el.style.display = val === 'official' ? '' : 'none';
}

function onTournamentSelect(val) {
    const form = document.getElementById('new-tournament-form');
    if (form) form.style.display = val === 'new' ? 'block' : 'none';
    toggleMatchConfig(val !== 'new');
}

let selectedFormat = 't20';
window.setMatchFormat = function(fmt) {
    selectedFormat = fmt;
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('format-' + fmt).classList.add('active');
    
    const oversGrid = document.getElementById('overs-grid');
    const testGrid = document.getElementById('test-settings-grid');
    const setupOvers = document.getElementById('setup-overs');
    
    if (fmt === 't20') {
        if (oversGrid) oversGrid.style.display = 'none';
        if (testGrid) testGrid.style.display = 'none';
        setupOvers.value = 20;
    } else if (fmt === 'custom') {
        if (oversGrid) oversGrid.style.display = 'grid';
        if (testGrid) testGrid.style.display = 'none';
    } else if (fmt === 'test') {
        if (oversGrid) oversGrid.style.display = 'none';
        if (testGrid) testGrid.style.display = 'block';
        setupOvers.value = 2000; // Large number for Test
    }
}

function toggleMatchConfig(show) {
    const teams = document.getElementById('teams-grid');
    const toss = document.getElementById('toss-grid');
    const startBtn = document.getElementById('start-btn');
    const schedBtn = document.getElementById('schedule-btn');
    const head = document.getElementById('match-config-head');

    if (teams) teams.style.display = show ? '' : 'none';
    if (toss) toss.style.display = 'none'; // ALWAYS HIDE ON INITIAL LOAD/TOGGLE
    if (schedBtn) schedBtn.style.display = show ? '' : 'none';

    if (head) head.textContent = show ? 'Match Configuration' : 'Tournament Base Settings';
    if (startBtn) startBtn.innerHTML = show ? '▶ Start Match' : '🏆 Create Tournament';
}


function showTossConfig(show) {
    const toss = document.getElementById('toss-grid');
    if (toss) toss.style.display = show ? '' : 'none';
}


function renderResumeMatchesImpl() {
    const container = document.getElementById('resume-matches-list');
    if (!container) return;

    const db = window.DB;
    if (!db?.getMatches) {
        if (typeof window.SLCRICK_renderResumeList === 'function') {
            window.SLCRICK_renderResumeList();
            return;
        }
    }

    // 1. Get ALL matches and filter for displayable ones
    const allMatches = db ? db.getMatches() : [];
    const pausedMatches = allMatches.filter(m => m.status === 'paused' || m.status === 'live');
    const scheduledMatches = allMatches.filter(m => (!m.tournamentId) && (m.status === 'scheduled' || m.status === 'setup')).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));

    const tourns = (db ? db.getTournaments() : []).filter((t) => t && t.id && t.status !== 'completed' && t.status !== 'cancelled');
    
    const requests = db ? db.getRequests().filter(r => r.type === 'tournament' && r.status === 'pending') : [];

    if (!pausedMatches.length && !tourns.length && !requests.length && !scheduledMatches.length) {
        const isSyncing =
            !window.SLCRICK_DESKTOP &&
            window.SLCRICK_SYNC?.isEnabled?.() &&
            !window._isGlobalSyncCompleted;
        container.innerHTML = `
            <div style="color:var(--c-muted);font-size:14px;padding:32px 20px;text-align:center;background:rgba(255,255,255,0.015);border-radius:18px;border:1px dashed rgba(255,255,255,0.1); margin-bottom:15px">
                ${isSyncing ? 
                    '<span class="syncing-animate" style="display:inline-block;margin-bottom:12px;font-size:28px">🔄</span><br><b style="color:#fff">Synchronizing with Cloud...</b>' : 
                    '<div style="font-size:24px;margin-bottom:8px">📭</div><b>No Active Tournaments or Matches</b><p style="font-size:12px;opacity:0.6;margin-top:4px">Select <b>Tournament Match</b>, add teams, then Schedule — matches appear here</p>'}
            </div>`;
        return;
    }

    let html = '';

    // --- TOURNAMENTS SECTION ---
    if (tourns.length) {
        // Sort by creation date descending
        const sortedTourns = tourns.sort((a, b) => b.createdAt - a.createdAt);
        
        html += `<div style="font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:2px; color:var(--c-primary); margin:20px 0 12px 10px; opacity:0.8">🏆 YOUR TOURNAMENTS</div>`;
        
        sortedTourns.forEach(t => {
            const hasPw = !!(t.scoringPassword || t.password || t.isLocked);
            let statusBadge = '';

            if (t.status === 'requested') {
                statusBadge = `<span style="font-size:10px; background:rgba(255,193,7,0.2); color:#ffc107; padding:2px 8px; border-radius:100px; font-weight:800">PENDING APPROVAL</span>`;
            } else if (t.status === 'completed') {
                statusBadge = `<span style="font-size:10px; background:rgba(0,230,118,0.2); color:#00e676; padding:2px 8px; border-radius:100px; font-weight:800">COMPLETED</span>`;
            } else {
                statusBadge = `<span style="font-size:10px; background:rgba(var(--c-primary-rgb),0.15); color:var(--c-primary); padding:2px 8px; border-radius:100px; font-weight:800">READY TO SCORE</span>`;
            }

            const matchTotal = t.matches ? t.matches.length : 0;
            const fmtLabel = capitalize((t.format || 'league').replace(/_/g, ' '));

            html += `
                <div class="resume-card resume-card-tournament" style="border-left:4px solid var(--c-primary); margin-bottom:0; padding:18px 20px">
                    <div class="resume-card-info" style="flex:1; min-width:0">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap">
                            ${statusBadge}
                            ${hasPw ? `<span style="font-size:10px; background:#fef3c7; color:#92400e; padding:2px 8px; border-radius:100px; font-weight:800">🔒 SECURE</span>` : ''}
                        </div>
                        <h4 style="font-size:20px; font-weight:950; letter-spacing:-0.5px; margin:0 0 6px; line-height:1.2">${typeof escapeHTML === 'function' ? escapeHTML(t.name) : t.name}</h4>
                        <div style="font-size:12px; color:var(--c-muted); display:flex; gap:14px; flex-wrap:wrap">
                            <span>Format: ${typeof escapeHTML === 'function' ? escapeHTML(fmtLabel) : fmtLabel}</span>
                            <span>Matches: ${matchTotal}</span>
                        </div>
                    </div>
                    <button type="button" class="btn btn-primary btn-sm" style="font-weight:800; border-radius:10px; flex-shrink:0" onclick="openTournamentHub('${t.id}')">Dashboard</button>
                </div>
            `;
        });
    }

    // --- PENDING REQUESTS SECTION ---
    if (requests && requests.length) {
        html += `<div style="font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:2px; color:#ffc107; margin:24px 0 12px 10px; opacity:0.8">⏳ PENDING APPROVAL</div>`;
        requests.forEach(r => {
            html += `
                <div class="resume-card" style="border-left: 4px solid #ffc107; background:linear-gradient(90deg, rgba(255,193,7,0.05), transparent)">
                    <div class="resume-card-info">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px">
                            <span style="font-size:10px; background:rgba(255,193,7,0.15); color:#ffc107; padding:2px 8px; border-radius:100px; font-weight:800">PENDING</span>
                        </div>
                        <h4 style="font-size:18px; font-weight:800">${r.tournamentName || r.matchName || 'Tournament Request'}</h4>
                        <p style="opacity:0.7">Scheduled by ${r.requesterName} · Waiting for Admin approval</p>
                    </div>
                </div>
            `;
        });
    }

    // --- PAUSED OR LIVE MATCHES SECTION ---
    if (pausedMatches.length) {
        html += `<div style="font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:2px; color:#ffc107; margin:24px 0 12px 10px; opacity:0.8">⏸ IN PROGRESS / PAUSED</div>`;
        pausedMatches.forEach(m => {
            const inn = m.innings ? m.innings[m.currentInnings] : null;
            const score = inn ? `${inn.runs}/${inn.wickets} (${formatOvers(inn.balls, m.ballsPerOver)})` : 'Match paused';
            const hasPw = (m.scoringPassword || m.password || m.isLocked);

            html += `
                <div class="resume-card" style="border-left: 4px solid #ffc107; background:linear-gradient(90deg, rgba(255,193,7,0.05), transparent)">
                    <div class="resume-card-info">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px">
                            <span style="font-size:10px; background:rgba(255,193,7,0.15); color:#ffc107; padding:2px 8px; border-radius:100px; font-weight:800">PAUSED</span>
                            ${hasPw ? `<span style="font-size:10px; background:rgba(0,0,0,0.3); color:#ffc107; padding:2px 8px; border-radius:100px; font-weight:800">🔒 LOCKED</span>` : ''}
                        </div>
                        <h4 style="font-size:18px; font-weight:800">${m.team1} vs ${m.team2}</h4>
                        <p style="opacity:0.7">${score} · ${m.type === 'tournament' ? (m.tournamentName || 'Tournament') : 'Single Match'}</p>
                    </div>
                    <button class="btn btn-green btn-sm" onclick="onResumeOrStart('${m.id}', '${m.tournamentId || ''}', false)">🔁 Resume</button>
                </div>
            `;
        });
    }

    // --- SCHEDULED MATCHES SECTION ---
    if (scheduledMatches.length) {
        html += `<div style="font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:2px; color:#00e676; margin:24px 0 12px 10px; opacity:0.8">📅 SCHEDULED MATCHES</div>`;
        scheduledMatches.forEach(m => {
            const hasPw = (m.scoringPassword || m.password || m.isLocked);
            html += `
                <div class="resume-card" style="border-left: 4px solid #00e676; background:linear-gradient(90deg, rgba(0,230,118,0.05), transparent)">
                    <div class="resume-card-info">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px">
                            <span style="font-size:10px; background:rgba(0,230,118,0.15); color:#00e676; padding:2px 8px; border-radius:100px; font-weight:800">READY</span>
                            ${hasPw ? `<span style="font-size:10px; background:rgba(0,0,0,0.3); color:#ffc107; padding:2px 8px; border-radius:100px; font-weight:800">🔒 LOCKED</span>` : ''}
                        </div>
                        <h4 style="font-size:18px; font-weight:800">${m.team1 || 'Team A'} vs ${m.team2 || 'Team B'}</h4>
                        <p style="opacity:0.7">${m.scheduledName || (m.type === 'tournament' ? (m.tournamentName || 'Tournament Match') : 'Single Match')}</p>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="onResumeOrStart('${m.id}', '${m.tournamentId || ''}', false)">▶ Start Match</button>
                </div>
            `;
        });
    }

    container.innerHTML = html;
}

window.renderResumeMatches = function () {
    if (typeof window.SLCRICK_renderResumeList === 'function') {
        window.SLCRICK_renderResumeList();
    } else {
        renderResumeMatchesImpl();
    }
};

async function submitMatchRequest() {
    const name = document.getElementById('req-name').value.trim();
    const pw = document.getElementById('req-password').value.trim();
    const phone = document.getElementById('req-phone') ? document.getElementById('req-phone').value.trim() : '';
    if (!name || !pw) { showToast('Name and Password are required!', 'error'); return; }

    if (_pendingTournPayload) {
        _pendingTournPayload.scoringPassword = pw;
        const tourn = await DB.createTournament(_pendingTournPayload);
        tourn.status = 'requested';
        await DB.saveTournamentWithAuth(tourn);

        DB.addRequest({ tournamentId: tourn.id, requesterName: name, organizerPhone: phone, requestedPassword: pw, type: 'tournament' });

        setTournamentAuthorized(tourn.id, 'local-creator', 7200000);
        _pendingTournPayload = null;
        closeModal('modal-request');
        showToast('Tournament request sent to Admin!');
        
        // Open the tournament hub in a NEW TAB
        const hubUrl = `score-match.html?tournamentId=${tourn.id}`;
        window.open(hubUrl, '_blank');
        
        renderResumeMatches();
    }
}

function authorizeTournamentLocally(tournamentId) {
    if (!tournamentId) return false;
    if (isTournamentAuthorized(tournamentId)) return true;
    const t = DB.getTournament(tournamentId);
    if (!t) return false;
    if (!tournamentHasPassword(t)) {
        setTournamentAuthorized(tournamentId, 'open', TOURNAMENT_SESSION_AUTH_MS);
        return true;
    }
    return false;
}

async function openScorerDashboard(matchId) {
    let m = DB.getMatch(matchId);
    if (!m) {
        startOfficialMatch(matchId);
        return;
    }
    const tid = m.tournamentId || '';
    if (tid && typeof window.ensureTournamentAccess === 'function') {
        const allowed = await window.ensureTournamentAccess(tid, {
            type: 'match',
            matchId,
            tournamentId: tid
        });
        if (!allowed) return;
    } else if (matchNeedsPassword(m, tid ? DB.getTournament(tid) : null)) {
        showMatchLoginScreen(m, { type: 'match', matchId });
        return;
    }
    m.status = 'live';
    DB.saveMatch(m);
    loadMatch(m);
}

function resumeMatch(id) {
    const m = DB.getMatch(id);
    onResumeOrStart(id, m?.tournamentId || '', false);
}

let currentTournamentTab = 'matches';

function showModeSelectionModal(match) {
    const existing = document.getElementById('mode-selection-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'mode-selection-modal';
    modal.style = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.55);display:flex;justify-content:center;align-items:center;z-index:9999';
    modal.innerHTML = `
        <div style="background:#0f172a;padding:20px;border-radius:16px;max-width:360px;width:100%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.6);">
            <h3 style="margin:0 0 14px; color:#fff">Resume Match ${match.id}</h3>
            <button id="score-mode-btn" style="display:block;width:100%;margin:8px 0;padding:12px;font-weight:700;background:#0f766e;color:#fff;border:none;border-radius:10px;cursor:pointer;">Score Match (Scorer)</button>
            <button id="hotkey-mode-btn" style="display:block;width:100%;margin:8px 0;padding:12px;font-weight:700;background:#a855f7;color:#fff;border:none;border-radius:10px;cursor:pointer;">Hotkey Access (TV)</button>
            <button id="cancel-mode-btn" style="display:block;width:100%;margin:8px 0;padding:10px;font-weight:600;background:#1f2937;color:#fff;border:none;border-radius:10px;cursor:pointer;">Cancel</button>
        </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('score-mode-btn').onclick = () => {
        modal.remove();
        openScorerDashboard(match.id);
    };

    document.getElementById('hotkey-mode-btn').onclick = () => {
        modal.remove();
        openHotkeyPanel(match.id);
    };

    document.getElementById('cancel-mode-btn').onclick = () => modal.remove();
}

function openHotkeyPanel(matchId) {
    sessionStorage.setItem('hotkey_match_id', matchId);
    localStorage.setItem('hotkey_match_id', matchId); // robust fallback when session is lost
    sessionStorage.setItem('hotkey_mode', 'true');
    // Open hotkey mode in a NEW TAB for collaborative work
    window.open('score-match.html?matchId=' + encodeURIComponent(matchId) + '&hotkey=true', '_blank');
}

function switchTournamentTab(tab) {
    currentTournamentTab = tab;
    const pMatches = document.getElementById('tm-panel-matches');
    const pTeams = document.getElementById('tm-panel-teams');
    const pStandings = document.getElementById('tm-panel-standings');
    const btnMatches = document.getElementById('tm-tab-matches');
    const btnTeams = document.getElementById('tm-tab-teams');
    const btnStandings = document.getElementById('tm-tab-standings');

    if (btnMatches) btnMatches.classList.toggle('active', tab === 'matches');
    if (btnTeams) btnTeams.classList.toggle('active', tab === 'teams');
    if (btnStandings) btnStandings.classList.toggle('active', tab === 'standings');

    if (pMatches) pMatches.style.display = tab === 'matches' ? 'block' : 'none';
    if (pTeams) pTeams.style.display = tab === 'teams' ? 'block' : 'none';
    if (pStandings) pStandings.style.display = tab === 'standings' ? 'block' : 'none';

    if (tab === 'matches') renderTournamentMatches();
    else if (tab === 'standings') renderTournamentStandings();
    else renderTournamentTeams();
}

async function openTournamentHub(id) {
    if (!id) return;
    let t = window.DB.getTournament(id);
    if (!t) {
        if (typeof window.pullGlobalData === 'function') {
            await window.pullGlobalData();
            t = window.DB.getTournament(id);
        }
    }
    if (!t) {
        showToast('Tournament not found', 'error');
        return;
    }

    if (tournamentHasPassword(t)) {
        if (isTournamentHubSessionActive(id)) {
            openTournamentHubAfterAuth(t);
            return;
        }
        _tournamentUnlockedThisVisit = null;
        showTournamentLoginScreen(t, { type: 'hub' });
        return;
    }

    openTournamentHubAfterAuth(t);
}
window._openTournamentHubReal = openTournamentHub;
window.openTournamentHub = openTournamentHub;

async function promptTournamentLogin() {
    const tId = await showInputModal('Enter Tournament ID:', '');
    if (tId) openTournamentHub(tId.trim());
}

// Alias for button in tournament summary screen
function openTournamentMatchesModal(id) {
    openTournamentHub(id);
}

function renderTournamentMatches() {
    const t = currentTournament;
    if (!t) return;
    
    let html = `
    <div style="background:rgba(124,77,255,0.1); border:1px solid rgba(124,77,255,0.3); border-radius:12px; padding:16px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center">
        <div>
            <div style="font-size:11px; font-weight:900; color:#b39ddb; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px">📺 Tournament Broadcast Link</div>
            <div style="font-size:13px; opacity:0.8; color:#fff">Use this permanent link in OBS for the entire tournament.</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="border-color:#7c4dff; color:#b39ddb; flex-shrink:0" onclick="navigator.clipboard.writeText(window.location.origin + window.location.pathname.replace('score-match.html', 'overlay.html') + '?tournament=${t.id}'); showToast('✅ Overlay link copied!','success');">📋 Copy Link</button>
    </div>`;

    t.matches.forEach((mId, index) => {
        const m = DB.getMatch(mId);
        if (!m) return;

        let statusBadge = '';
        let btn = '';
        let matchName = m.scheduledName || `Match ${index + 1}`;
        let subInfo = 'Scheduled';
        let cardStyle = '';
        const pw = (m.scoringPassword || m.password || (t && t.scoringPassword));
        let locked = pw ? '🔒 ' : '';

        if (m.status === 'live' || m.status === 'paused') {
            statusBadge = `<span class="badge badge-green" style="font-size:10px">🔴 LIVE</span>`;
            btn = `<div style="display:flex; gap:6px">
                <button class="btn btn-primary btn-sm" style="flex:2" onclick="onResumeOrStart('${m.id}', '${m.tournamentId || ''}', false)">Resume</button>
                <button class="btn btn-red btn-sm" style="flex:1; background:rgba(211,47,47,0.1); color:#d32f2f; min-width:60px" onclick="forceEndMatchInHub('${m.id}')">🛑 End</button>
            </div>`;
            subInfo = `Match ${index + 1} · ${m.overs} ov`;
            cardStyle = 'border-left: 4px solid #00e676;';
        } else if (m.status === 'completed') {
            statusBadge = `<span class="badge badge-blue" style="font-size:10px">✅ Done</span>`;
            btn = `<button class="btn btn-ghost btn-sm" disabled>View Result</button>`;
            subInfo = `Match ${index + 1} · Completed`;
            cardStyle = 'opacity: 0.8;';
        } else {
            statusBadge = `<span class="badge badge-amber" style="font-size:10px">📅 Scheduled</span>`;
            btn = `<button class="btn btn-primary btn-sm" onclick="onResumeOrStart('${m.id}', '${m.tournamentId || ''}', true)">▶ Start Match</button>`;
        }

        html += `<div class="resume-card" style="margin-bottom:12px; align-items: center; ${cardStyle}; padding: 16px">
            <div class="resume-card-info" style="flex: 1">
                <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--c-muted); margin-bottom: 4px">${subInfo}</div>
                <h4 style="font-size: 17px; font-weight: 850; margin-bottom: 6px">${locked}${matchName}</h4>
                <div style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:13px; color:var(--c-primary)">
                    <span style="cursor:pointer; border-bottom:1px dashed rgba(255,255,255,0.2)" onclick="editMatchTeam('${m.id}', 1)">${m.team1 || 'TBD'}</span>
                    <span style="font-weight:400; opacity:0.4; font-size:10px">VS</span>
                    <span style="cursor:pointer; border-bottom:1px dashed rgba(255,255,255,0.2)" onclick="editMatchTeam('${m.id}', 2)">${m.team2 || 'TBD'}</span>
                </div>
            </div>
            <div style="text-align: right; display: flex; flex-direction: column; gap: 8px; align-items: flex-end">
                ${statusBadge}
                ${btn}
            </div>
        </div>`;
    });

    document.getElementById('tm-list').innerHTML = html || '<div style="padding:40px;text-align:center;opacity:0.5">No matches scheduled yet</div>';
    
    // Add Match listener
    const btnAdd = document.getElementById('btn-add-tourn-match');
    if (btnAdd) {
        btnAdd.onclick = () => {
            const count = t.matches.length + 1;
            const newM = DB.createMatch({
                type: 'tournament',
                tournamentId: t.id,
                tournamentName: t.name,
                scoringPassword: t.scoringPassword || t.password,
                team1: 'TBD',
                team2: 'TBD',
                overs: t.overs,
                ballsPerOver: t.ballsPerOver,
                playersPerSide: 11
            });
            newM.scheduledName = `Extra Match ${count}`;
            newM.status = 'scheduled';
            DB.saveMatch(newM);
            t.matches.push(newM.id);
            DB.saveTournament(t);
            renderTournamentMatches();
            showToast('New extra match added!', 'success');
        };
    }

    // End Tournament listener
    const btnEnd = document.getElementById('btn-end-tournament');
    if (btnEnd) {
        btnEnd.style.display = (t.status === 'active' || t.status === 'approved') ? 'block' : 'none';
        btnEnd.onclick = () => endTournamentManually(t.id);
    }
}

function editMatchTeam(matchId, teamSlot) {
    const m = DB.getMatch(matchId);
    if (!m) return;
    
    const t = currentTournament || (m.tournamentId ? DB.getTournament(m.tournamentId) : null);
    const existingTeams = (t && t.teams) ? t.teams : [];
    
    // Create a quick custom selection modal
    const modalId = 'match-team-select-modal';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();
    
    const modal = document.createElement('div');
    modal.id = modalId;
    modal.style = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);display:flex;justify-content:center;align-items:center;z-index:10001;padding:20px';
    
    let teamsHtml = existingTeams.map(team => `
        <button class="btn btn-ghost" style="width:100%; text-align:left; padding:15px; margin-bottom:8px; background:rgba(255,255,255,0.05); border-radius:12px; font-weight:700" onclick="confirmMatchTeamEdit('${matchId}', ${teamSlot}, '${escapeHTML(team)}')">
            ${team}
        </button>
    `).join('');
    
    modal.innerHTML = `
        <div style="background:#0f172a; width:100%; max-width:400px; border-radius:20px; padding:24px; box-shadow:0 20px 40px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.1)">
            <h3 style="margin:0 0 8px; color:#fff">Select Team ${teamSlot}</h3>
            <p style="margin:0 0 20px; font-size:13px; opacity:0.6">Choose a team from the tournament or enter a new name below.</p>
            
            <div style="max-height:300px; overflow-y:auto; margin-bottom:20px; padding-right:5px">
                ${teamsHtml || '<p style="text-align:center; padding:20px; opacity:0.5">No teams found in tournament</p>'}
            </div>
            
            <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:20px">
                <button class="btn btn-primary" style="width:100%; margin-bottom:10px" onclick="promptMatchTeamManual('${matchId}', ${teamSlot})">✎ Enter Name Manually</button>
                <button class="btn btn-ghost" style="width:100%" onclick="document.getElementById('${modalId}').remove()">Cancel</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

window.confirmMatchTeamEdit = function(matchId, teamSlot, newName) {
    const m = DB.getMatch(matchId);
    if (!m) return;
    if (teamSlot === 1) m.team1 = newName;
    else m.team2 = newName;
    DB.saveMatch(m);
    
    const modal = document.getElementById('match-team-select-modal');
    if (modal) modal.remove();
    
    renderTournamentMatches();
    showToast(`Team ${teamSlot} updated!`, 'success');
};

window.promptMatchTeamManual = async function(matchId, teamSlot) {
    document.getElementById('match-team-select-modal').remove();
    const m = DB.getMatch(matchId);
    if (!m) return;
    const oldName = teamSlot === 1 ? m.team1 : m.team2;
    const newName = await showInputModal(`Enter Team ${teamSlot} name:`, oldName === 'TBD' ? '' : oldName);
    if (newName !== null) {
        confirmMatchTeamEdit(matchId, teamSlot, newName.trim() || 'TBD');
    }
};

function endTournamentManually(tournId) {
    if (!confirm("Are you sure you want to end this tournament? This will finalize all standings and results.")) return;
    const t = DB.getTournament(tournId);
    if (t) {
        t.status = 'completed';
        DB.saveTournament(t);

        showToast('🏆 Tournament COMPLETED! Standings finalized.', 'success');
        closeModal('modal-tournament-matches');
        
        if (currentMatch && currentMatch.tournamentId === tournId) {
            openTournamentSummary();
        }
    }
}

function startOfficialMatch(mId) {
    const m = DB.getMatch(mId);
    if (!m) return;

    closeModal('modal-tournament-matches');

    // If this is a prepared schedule, we MUST ask for Toss results first
    if (m.status === 'scheduled') {
        currentMatch = m;
        document.getElementById('toss-match-teams').textContent = `${m.team1} vs ${m.team2}`;
        document.getElementById('toss-winner-t1').textContent = m.team1;
        document.getElementById('toss-winner-t2').textContent = m.team2;
        
        // Reset modal state
        _selectedTossWinner = null;
        _selectedTossDecision = null;
        document.querySelectorAll('.toss-team-btn, .toss-dec-btn').forEach(b => b.classList.remove('active', 'btn-primary'));
        
        openModal('modal-toss-result');
        return;
    }

    // Fallback: open setup for custom user input before starting
    showScreen('setup');
    document.getElementById('type-tournament').click();
    currentMatch = m; // Set it early to avoid null issues in other handlers
    setTimeout(() => {
        document.getElementById('tournament-setup-section').style.display = 'none';
        toggleMatchConfig(true); // Restore the teams input grid specifically for matches
        document.getElementById('team1-name').value = (m.team1 !== 'TBD' ? m.team1 : '');
        document.getElementById('team2-name').value = (m.team2 !== 'TBD' ? m.team2 : '');
        document.getElementById('setup-overs').value = m.overs;
        document.getElementById('setup-bpo').value = m.ballsPerOver;
        document.getElementById('setup-pps').value = m.playersPerSide || 11;
        
        const datalist = document.getElementById('team-suggestions');
        if (datalist && currentTournament && currentTournament.teams) {
            datalist.innerHTML = currentTournament.teams.map(t => `<option value="${t}"></option>`).join('');
        }
    }, 100);
}

async function loginToMatch() {
    const unlockBtn = document.getElementById('btn-login-unlock');
    if (unlockBtn?.disabled) return;
    const pw = document.getElementById('login-password').value.trim();
    if (!pw) { showToast('Password required!', 'error'); return; }
    if (unlockBtn) {
        unlockBtn.disabled = true;
        unlockBtn.textContent = 'Checking…';
    }

    const tournamentId = currentTournament?.id || currentMatch?.tournamentId || null;
    const matchId = currentMatch?.id || _loginPendingAction?.matchId || null;

    const pendingAction = _loginPendingAction || { type: 'hub' };

    const grantAccess = async (meta = {}) => {
        try {
            if (tournamentId) {
                try {
                    localStorage.setItem(`tourn_pw_${tournamentId}`, pw);
                } catch (_) {}
                const tRec = DB.getTournament(tournamentId);
                if (tRec) {
                    tRec.scoringPassword = pw;
                    DB.saveTournament(tRec, true, { skipPublish: true });
                    currentTournament = tRec;
                }
                markTournamentSessionUnlocked(tournamentId);
                if (meta.token) {
                    setTournamentAuthorized(tournamentId, meta.token, meta.expiresInMs || TOURNAMENT_SESSION_AUTH_MS);
                } else {
                    setTournamentAuthorized(tournamentId, 'session', TOURNAMENT_SESSION_AUTH_MS);
                }
            }
            showToast('✅ Password accepted', 'success');
            await completeLoginSuccess(pendingAction);
        } finally {
            if (unlockBtn) {
                unlockBtn.disabled = false;
                unlockBtn.textContent = '🔓 Unlock & Continue';
            }
        }
    };

    const tryIds = [];
    if (tournamentId) tryIds.push(tournamentId);
    if (matchId && !tryIds.includes(matchId)) tryIds.push(matchId);

    for (const id of tryIds) {
        if (window.SLCRICK_SYNC?.verifyLocalPassword) {
            const local = window.SLCRICK_SYNC.verifyLocalPassword(id, pw);
            if (local.ok) {
                await grantAccess({});
                if (tournamentId && window.SLCRICK_SYNC?.prefetchCloudToken) {
                    window.SLCRICK_SYNC.prefetchCloudToken(tournamentId, pw).catch(() => {});
                }
                return;
            }
        }
        const stored = localStorage.getItem(`tourn_pw_${id}`);
        if (stored && String(stored).trim() === pw) {
            await grantAccess({});
            if (tournamentId && window.SLCRICK_SYNC?.prefetchCloudToken) {
                window.SLCRICK_SYNC.prefetchCloudToken(tournamentId, pw).catch(() => {});
            }
            return;
        }
        const tObj = id.startsWith('MATCH') ? DB.getMatch(id) : DB.getTournament(id);
        const tPw = tObj?.scoringPassword || tObj?.password;
        if (tPw && String(tPw).trim() === pw) {
            await grantAccess({});
            if (tournamentId && window.SLCRICK_SYNC?.prefetchCloudToken) {
                window.SLCRICK_SYNC.prefetchCloudToken(tournamentId, pw).catch(() => {});
            }
            return;
        }
        if (window.SLCRICK_DESKTOP && !tPw && (tObj?.isLocked || tournamentHasPassword(tObj)) && pw === 'offline') {
            await grantAccess({});
            return;
        }
    }

    let lastHandshakeErr = '';
    for (const id of tryIds) {
        if (typeof DB.handshake !== 'function') continue;
        try {
            const res = await DB.handshake(id, pw);
            if (res?.ok) {
                await grantAccess({ token: res.token, expiresInMs: res.expiresInMs });
                if (tournamentId && window.SLCRICK_SYNC?.prefetchCloudToken && pw !== 'offline') {
                    window.SLCRICK_SYNC.prefetchCloudToken(tournamentId, pw).catch(() => {});
                }
                return;
            }
            if (res?.error) lastHandshakeErr = String(res.error);
        } catch (e) {
            console.warn('[Login] handshake error', id, e);
        }
    }

    if (window.SLCRICK_DESKTOP && tournamentId) {
        const tRec = DB.getTournament(tournamentId);
        if (tRec && tournamentHasPassword(tRec) && pw === 'offline') {
            await grantAccess({});
            showToast('Scoring unlocked (offline). Use your real password for live website sync.', 'default');
            return;
        }
    }

    const hint = window.SLCRICK_DESKTOP
        ? ' On desktop try the password from tournament setup, or offline if you never set one.'
        : ' Use the same scoring password as when you created the tournament.';
    const cloudBit = lastHandshakeErr ? ` Cloud: ${lastHandshakeErr}.` : '';
    showToast('Wrong password.' + cloudBit + hint, 'error');
    const pwEl = document.getElementById('login-password');
    if (pwEl) {
        pwEl.value = '';
        pwEl.focus();
    }
    if (unlockBtn) {
        unlockBtn.disabled = false;
        unlockBtn.textContent = '🔓 Unlock & Continue';
    }
}
window.loginToMatch = loginToMatch;


/**
 * Schedule tournament from the tournament form (site + desktop).
 * Ensures tournament mode even if user did not click "Tournament Match" tab first.
 */
async function scheduleTournamentFromForm() {
    if (window.SLCRICK_DESKTOP && typeof window.scheduleTournamentNow === 'function') {
        return window.scheduleTournamentNow();
    }
    try {
    selectMatchType('tournament');
    currentMatchType = 'tournament';

    const teamLines = (document.getElementById('tourn-teams')?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
    const uniqueTeams = [...new Set(teamLines)];
    let tName = document.getElementById('tourn-name')?.value.trim();
    let scoringPw = document.getElementById('tourn-scoring-password')?.value.trim();
    const overs = parseInt(document.getElementById('tourn-overs')?.value) || 20;
    const bpo = parseInt(document.getElementById('tourn-bpo')?.value) || 6;
    const tournType = document.getElementById('tourn-type')?.value || 'unofficial';
    const format = document.getElementById('tourn-format')?.value || 'league';

    if (!tName) {
        tName = uniqueTeams.length >= 2
            ? `${uniqueTeams.slice(0, 3).join(' · ')} League`
            : `Tournament ${new Date().toLocaleDateString()}`;
        const nameEl = document.getElementById('tourn-name');
        if (nameEl) nameEl.value = tName;
    }
    if (uniqueTeams.length < 2) {
        showToast('👥 Enter at least 2 different teams (one per line)', 'error');
        document.getElementById('tourn-teams')?.focus();
        return;
    }
    if (!scoringPw) {
        if (window.SLCRICK_DESKTOP) {
            scoringPw = 'offline';
            const pwEl = document.getElementById('tourn-scoring-password');
            if (pwEl) pwEl.value = scoringPw;
        } else {
            showToast('🔐 Set a Scoring Password to secure this tournament', 'error');
            document.getElementById('tourn-scoring-password')?.focus();
            return;
        }
    }

    if (tournType === 'official') {
        const matchCount = format === 'knockout'
            ? (parseInt(document.getElementById('tourn-team-count')?.value) - 1)
            : (parseInt(document.getElementById('tourn-match-count')?.value) || 10);
        _pendingTournPayload = {
            name: tName, format, overs, ballsPerOver: bpo, teams: teamLines, isOfficial: true,
            scoringPassword: scoringPw,
            totalTeams: format === 'knockout' ? parseInt(document.getElementById('tourn-team-count')?.value) : teamLines.length,
            matchCount,
            startDate: document.getElementById('tourn-start-date')?.value || '',
            prizes: {
                first: document.getElementById('tourn-prize-1')?.value || '',
                second: document.getElementById('tourn-prize-2')?.value || '',
                third: document.getElementById('tourn-prize-3')?.value || '',
            },
        };
        document.getElementById('req-name').value = '';
        document.getElementById('req-password').value = '';
        document.getElementById('request-match-title').textContent = tName;
        openModal('modal-request');
        return;
    }

    const matchCount = format === 'knockout'
        ? (parseInt(document.getElementById('tourn-team-count')?.value) - 1)
        : (parseInt(document.getElementById('tourn-match-count')?.value) || 10);

    const tourn = await DB.createTournament({
        name: tName,
        format,
        overs,
        ballsPerOver: bpo,
        scoringPassword: scoringPw,
        teams: uniqueTeams,
        isOfficial: false,
        totalTeams: format === 'knockout' ? parseInt(document.getElementById('tourn-team-count')?.value) : uniqueTeams.length,
        matchCount,
    });

    if (!tourn || !tourn.matches || tourn.matches.length === 0) {
        showToast('❌ Could not create matches. Check teams and try again.', 'error');
        return;
    }

    tourn.status = 'scheduled';
    DB.saveTournament(tourn);

    setTournamentAuthorized(tourn.id, 'local-creator', 7200000);
    localStorage.setItem(`tourn_pw_${tourn.id}`, scoringPw);

    if (window.desktopAPI) window.desktopAPI.requestPersist();

    renderResumeMatches();
    setTimeout(() => renderResumeMatches(), 100);

    showToast(`🏆 "${tName}" — ${tourn.matches.length} matches in RECENT list below`, 'success');

    document.getElementById('tourn-name').value = '';
    document.getElementById('tourn-teams').value = '';
    if (!window.SLCRICK_DESKTOP) {
        document.getElementById('tourn-scoring-password').value = '';
    }

    const list = document.getElementById('resume-matches-list');
    if (list) {
        list.scrollIntoView({ behavior: 'smooth', block: 'start' });
        list.style.outline = '2px solid var(--c-primary)';
        setTimeout(() => { list.style.outline = ''; }, 2500);
    }
    } catch (err) {
        console.error('scheduleTournamentFromForm', err);
        showToast('❌ Schedule failed: ' + (err.message || 'unknown error'), 'error');
    }
}
window.scheduleTournamentFromForm = scheduleTournamentFromForm;

async function scheduleNewMatch() {
    const t1 = document.getElementById('team1-name').value.trim();
    const t2 = document.getElementById('team2-name').value.trim();
    if (!t1 || !t2) { showToast('Please enter both team names!', 'error'); return; }

    const overs = parseInt(document.getElementById('setup-overs').value) || 20;
    const bpo = parseInt(document.getElementById('setup-bpo').value) || 6;
    const pps = parseInt(document.getElementById('setup-pps').value) || 11;
    const venue = document.getElementById('setup-venue').value.trim();
    const scorer = document.getElementById('setup-scorer').value.trim();

    // Check if we have a tournament selected or latest one
    let tournamentId = null, tournamentName = null;
    if (currentMatchType === 'tournament') {
        const allTourns = DB.getTournaments();
        if (allTourns.length) {
            const lastT = allTourns[allTourns.length - 1];
            tournamentId = lastT.id;
            tournamentName = lastT.name;
        }
    }

    const match = DB.createMatch({
        type: currentMatchType,
        tournamentId,
        tournamentName,
        team1: t1,
        team2: t2,
        overs: overs,
        ballsPerOver: bpo,
        playersPerSide: pps,
        venue: venue,
        scorer: scorer,
        scoringPassword: document.getElementById('match-scoring-password').value.trim()
    });
    match.status = 'scheduled';
    DB.saveMatch(match);
    
    if (tournamentId) {
        const t = DB.getTournament(tournamentId);
        if (t) {
            if (!t.matches) t.matches = [];
            t.matches.push(match.id);
            DB.saveTournament(t);
        }
    }

    showToast('Match scheduled successfully!', 'success');
    renderResumeMatches();
    setTimeout(() => {
        location.href = '../index.html';
    }, 1500);
}


async function startNewMatch() {
    let existingOfficialTournamentId = null;

    if (!currentMatch || !currentMatch.isScheduledTemplate) {
        if (currentMatchType === 'tournament') {
            const sel = 'new';
            if (sel === 'new') {
                const tName = document.getElementById('tourn-name').value.trim();
                const scoringPw = document.getElementById('tourn-scoring-password').value.trim();
                const teamLines = document.getElementById('tourn-teams').value.split('\n').map(l => l.trim()).filter(Boolean);
                const overs = parseInt(document.getElementById('tourn-overs').value) || 20;
                const bpo = parseInt(document.getElementById('tourn-bpo').value) || 6;
                const tournType = document.getElementById('tourn-type') ? document.getElementById('tourn-type').value : 'unofficial';
                const format = document.getElementById('tourn-format').value;

                if (!tName) {
                    showToast('🏆 Enter Tournament Name to continue', 'error');
                    document.getElementById('tourn-name').focus();
                    return;
                }
                if (teamLines.length < 2) {
                    showToast('👥 Enter at least 2 teams (one per line)', 'error');
                    document.getElementById('tourn-teams').focus();
                    return;
                }
                if (!scoringPw) {
                    showToast('🔐 Set a Scoring Password to secure this tournament', 'error');
                    document.getElementById('tourn-scoring-password').focus();
                    return;
                }

                if (tournType === 'official') {
                    const matchCount = format === 'knockout' 
                        ? (parseInt(document.getElementById('tourn-team-count').value) - 1)
                        : (parseInt(document.getElementById('tourn-match-count')?.value) || 10);
                    const startDate = document.getElementById('tourn-start-date')?.value || '';
                    const prize1 = document.getElementById('tourn-prize-1')?.value || '';
                    const prize2 = document.getElementById('tourn-prize-2')?.value || '';
                    const prize3 = document.getElementById('tourn-prize-3')?.value || '';

                    _pendingTournPayload = {
                        name: tName, format, overs, ballsPerOver: bpo, teams: teamLines, isOfficial: true, 
                        scoringPassword: scoringPw,
                        totalTeams: format === 'knockout' ? parseInt(document.getElementById('tourn-team-count').value) : teamLines.length,
                        matchCount,
                        startDate, prizes: { first: prize1, second: prize2, third: prize3 }
                    };

                    document.getElementById('req-name').value = '';
                    document.getElementById('req-password').value = '';
                    document.getElementById('request-match-title').textContent = tName;
                    openModal('modal-request');
                    return;
                } else {
                    const matchCount = format === 'knockout' 
                        ? (parseInt(document.getElementById('tourn-team-count').value) - 1)
                        : (parseInt(document.getElementById('tourn-match-count')?.value) || 10);
                    const tourn = await DB.createTournament({
                        name: tName, format, overs, ballsPerOver: bpo, 
                        scoringPassword: scoringPw,
                        teams: teamLines, isOfficial: false, 
                        totalTeams: format === 'knockout' ? parseInt(document.getElementById('tourn-team-count').value) : teamLines.length,
                        matchCount: matchCount 
                    });
                    setTournamentAuthorized(tourn.id, 'local-creator', 7200000);
                    showToast(`🏆 Tournament "${tName}" created & matches scheduled!`, 'success');
                    
                    // Force immediate UI refresh
                    renderResumeMatches();
                    
                    // Clear the form
                    document.getElementById('tourn-name').value = '';
                    document.getElementById('tourn-teams').value = '';
                    document.getElementById('tourn-scoring-password').value = '';
                    
                    // Scroll to recent matches
                    const matchesList = document.getElementById('resume-matches-list');
                    if (matchesList) {
                        matchesList.scrollIntoView({ behavior: 'smooth' });
                    }
                    return;
                }
            } else {
                const tourn = DB.getTournament(sel);
                if (tourn && tourn.isOfficial) {
                    existingOfficialTournamentId = tourn.id;
                }
            }
        }
    }

    if (existingOfficialTournamentId) {
        showToast('Official Tournament selected! Matches are already scheduled below. Please request to score them.', 'default');
        return;
    }

    const overs = parseInt(document.getElementById('setup-overs').value) || 20;
    const bpo = parseInt(document.getElementById('setup-bpo').value) || 6;

    const t1 = document.getElementById('team1-name').value.trim();
    const t2 = document.getElementById('team2-name').value.trim();
    if (!t1 || !t2) { showToast('Enter both team names', 'error'); return; }

    // If toss is hidden, show it and ask user to fill it before starting
    const tossGrid = document.getElementById('toss-grid');
    if (tossGrid && tossGrid.style.display === 'none' && currentMatchType === 'single') {
        showTossConfig(true);
        showToast('🎯 Please confirm Toss details to Start Match', 'default');
        tossGrid.scrollIntoView({ behavior: 'smooth' });
        return;
    }

    const pps = parseInt(document.getElementById('setup-pps').value) || 11;
    const venue = document.getElementById('setup-venue').value.trim();
    const tossWinner = document.getElementById('setup-toss').value === 'team1' ? t1 : t2;
    const dec = document.getElementById('setup-decision').value;
    const battingFirst = dec === 'bat' ? tossWinner : (tossWinner === t1 ? t2 : t1);
    const fieldingFirst = battingFirst === t1 ? t2 : t1;
    const scorerName = document.getElementById('setup-scorer') ? document.getElementById('setup-scorer').value.trim() : '';

    let match = null;

    if (currentMatch && currentMatch.isScheduledTemplate) {
        // We are starting an approved scheduled match
        match = currentMatch;
        match.team1 = t1;
        match.team2 = t2;
        match.overs = overs;
        match.ballsPerOver = bpo;
        match.playersPerSide = pps;
        match.venue = venue;
        match.scorerName = scorerName;
        match.tossWinner = tossWinner;
        match.tossDecision = dec;
        match.battingFirst = battingFirst;
        match.fieldingFirst = fieldingFirst;
        match.innings = [DB.createInnings(battingFirst, fieldingFirst), null];
        match.currentInnings = 0;
        match.history = [];
        match.redoStack = [];
        delete match.isScheduledTemplate;
    } else {
        if (!match) {
            let tournamentId = null, tournamentName = null;
            // Since tournament-select is gone, we check if we just created a tournament
            // or if we are in tournament mode (which now always creates a new one first).
            // Usually, this part of startNewMatch is only reached for SINGLE matches 
            // or if tournament creation happened and we are proceeding (though we use new tab now).
            
            if (currentMatchType === 'tournament') {
                // If we reach here in tournament mode, it's likely an error unless we handle it.
                // But for safety, we'll try to find the latest tournament.
                const allTourns = DB.getTournaments();
                if (allTourns.length) {
                    const lastT = allTourns[allTourns.length - 1];
                    tournamentId = lastT.id;
                    tournamentName = lastT.name;
                }
            }

             let scoringPassword = document.getElementById('match-scoring-password') ? document.getElementById('match-scoring-password').value.trim() : null;
             if (currentMatchType === 'tournament' && !scoringPassword && tournamentId) {
                 const t = DB.getTournament(tournamentId);
                 if (t && t.scoringPassword) scoringPassword = t.scoringPassword;
             }

             const testStructure = document.getElementById('setup-test-structure') ? parseInt(document.getElementById('setup-test-structure').value) : (selectedFormat === 'test' ? 4 : 2);
             const testMaxOvers = document.getElementById('setup-test-max-overs') ? parseInt(document.getElementById('setup-test-max-overs').value) : 1000;

             match = DB.createMatch({ 
                 type: currentMatchType, 
                 tournamentId, 
                 tournamentName, 
                 scoringPassword, 
                 team1: t1, 
                 team2: t2, 
                 overs, 
                 ballsPerOver: bpo, 
                 playersPerSide: pps, 
                 venue, 
                 scorerName, 
                 matchFormat: selectedFormat,
                 tossWinner, 
                 tossDecision: dec,
                 battingFirst, 
                 fieldingFirst,
                 totalInnings: testStructure,
                 maxInningsOvers: testMaxOvers
             });
             
             // Properly initialize all innings based on structure
             match.innings = Array(testStructure).fill(null);
             match.innings[0] = DB.createInnings(battingFirst, fieldingFirst);
        }
    }

    match.status = 'live';

    if (match.tournamentId) {
        const tourn = DB.getTournament(match.tournamentId);
        if (tourn && !tourn.matches.includes(match.id)) { tourn.matches.push(match.id); DB.saveTournament(tourn); }
    }

    DB.saveMatch(match);
    _innings_ending = false;
    loadMatch(match);
    setTimeout(() => openOpenBatsmenModal(), 300);
}

function loadMatch(m) {
    currentMatch = m;

    if (m.isScheduledTemplate) {
        showScreen('setup');
        // If it's a tournament match, pre-fill and possibly hide some parts
        if (m.tournamentId) {
            document.getElementById('type-tournament').click();
            setTimeout(() => {
                const tourneySetup = document.getElementById('tournament-setup-section');
                if (tourneySetup) tourneySetup.style.display = 'none';
                
                document.getElementById('team1-name').value = (m.team1 !== 'TBD' ? m.team1 : '');
                document.getElementById('team2-name').value = (m.team2 !== 'TBD' ? m.team2 : '');
                document.getElementById('setup-overs').value = m.overs;
                document.getElementById('setup-bpo').value = m.ballsPerOver;
                document.getElementById('setup-pps').value = m.playersPerSide || 11;
                
                const t = DB.getTournament(m.tournamentId);
                const dl = document.getElementById('team-suggestions');
                if (dl && t && t.teams) {
                    dl.innerHTML = t.teams.map(team => `<option value="${team}"></option>`).join('');
                }
            }, 100);
        } else {
            document.getElementById('type-single').click();
            setTimeout(() => {
                document.getElementById('team1-name').value = m.team1 || '';
                document.getElementById('team2-name').value = m.team2 || '';
                document.getElementById('setup-overs').value = m.overs || 20;
            }, 100);
        }
        return;
    }

    m.status = 'live';

    populateSquadDatalist('batting');
    _innings_ending = false;
    DB.saveMatch(m);
    showScreen('scoring');
    renderScoring();

    // AUTO-OPEN MODALS for new innings
    const inn = m.innings[m.currentInnings];
    if (m.status === 'live' && inn && inn.balls === 0 && inn.batsmen.length === 0) {
        setTimeout(() => openOpenBatsmenModal(), 500);
    }

    const pt = document.getElementById('publish-toggle');
    if (pt) pt.checked = m.publishLive;
    updateHeaderActions();
    primeCloudSyncForLiveMatch(m);

    if (
        window.SLCRICK_DESKTOP &&
        (localStorage.getItem('cricpro_auto_popup_scorecard') === 'true' ||
            localStorage.getItem('cricpro_auto_popup_obs') === 'true')
    ) {
        maybeAutoOpenDesktopPopups();
    }

    // WebSocket Room Join — use the global single socket instance
    const _activeSocket = window._cricproSocket || (typeof socket !== 'undefined' ? socket : null);
    if (_activeSocket && _activeSocket.connected) {
        _activeSocket.emit('join_match', m.id); // MUST match server: socket.on('join_match', ...)
        if (m.tournamentId) _activeSocket.emit('join_match', m.tournamentId);
    } else if (_activeSocket) {
        // Wait for connection if not yet connected
        _activeSocket.once('connect', () => {
            _activeSocket.emit('join_match', m.id);
            if (m.tournamentId) _activeSocket.emit('join_match', m.tournamentId);
        });
    }
}


function openPopupScorecardWindow() {
    if (!currentMatch?.id) {
        showToast('Start or resume a match first', 'error');
        return;
    }
    if (window.desktopAPI?.openPopupScorecard) {
        window.desktopAPI.openPopupScorecard({ matchId: currentMatch.id });
        showToast('🎛 Popup scorecard opened', 'success');
    } else {
        showToast('Popup scorecard — desktop app only', 'error');
    }
}
window.openPopupScorecardWindow = openPopupScorecardWindow;

function openObsPopupWindow() {
    if (!currentMatch?.id) {
        showToast('Start or resume a match first', 'error');
        return;
    }
    if (window.desktopAPI?.openObsPopup) {
        window.desktopAPI.openObsPopup({
            matchId: currentMatch.id,
            tournamentId: currentMatch.tournamentId || null,
        });
        showToast('📡 OBS / Hotkeys popup opened', 'success');
    } else {
        showToast('Pop-up OBS — desktop app only', 'error');
    }
}
window.openObsPopupWindow = openObsPopupWindow;

/** Optional: only if user enabled auto-open in Settings (default OFF). */
function maybeAutoOpenDesktopPopups() {
    if (!window.SLCRICK_DESKTOP || !currentMatch?.id) return;
    if (currentMatch.status !== 'live' && currentMatch.status !== 'paused') return;
    const mid = currentMatch.id;
    if (localStorage.getItem('cricpro_auto_popup_scorecard') === 'true') {
        if (window._slcrickPopupAutoOpened !== mid) {
            window._slcrickPopupAutoOpened = mid;
            window.desktopAPI?.openPopupScorecard?.({ matchId: mid }).catch(() => {});
        }
    }
    if (localStorage.getItem('cricpro_auto_popup_obs') === 'true') {
        if (window._slcrickObsPopupAutoOpened !== mid) {
            window._slcrickObsPopupAutoOpened = mid;
            setTimeout(() => {
                window.desktopAPI?.openObsPopup?.({
                    matchId: mid,
                    tournamentId: currentMatch.tournamentId || null,
                }).catch(() => {});
            }, 600);
        }
    }
}

function isPopupScoreSurface() {
    return document.documentElement.classList.contains('popup-score-mode');
}

function applyDesktopMatchSnapshot(match) {
    if (!match?.id) return;
    let m;
    try {
        m = JSON.parse(JSON.stringify(match));
    } catch (_) {
        m = match;
    }
    delete m._pendingUiConsumer;
    window._desktopApplyingRemoteMatch = true;
    try {
        currentMatch = m;
        window.currentMatch = m;
        if (typeof DB !== 'undefined' && DB.getMatches && DB.saveMatches) {
            const arr = DB.getMatches();
            const idx = arr.findIndex((x) => x.id === m.id);
            if (idx >= 0) arr[idx] = m;
            else arr.push(m);
            DB.saveMatches(arr);
        }
        const scoringEl = document.getElementById('screen-scoring');
        if (scoringEl && (m.status === 'live' || m.status === 'paused')) {
            if (isPopupScoreSurface()) {
                if (scoringEl.style.display === 'none') showScreen('scoring');
            } else {
                showScreen('scoring');
            }
        }
        renderScoring();
        if (typeof syncBroadcastMasterPhotos === 'function') syncBroadcastMasterPhotos(currentMatch);
    } finally {
        window._desktopApplyingRemoteMatch = false;
    }
}

function queueScoringUi(spec) {
    if (!currentMatch) return;
    currentMatch._scoringUi = {
        type: spec.type,
        slot: spec.slot,
        title: spec.title || 'New Batsman',
        delay: spec.delay != null ? spec.delay : 60,
        consumer: spec.consumer || (isPopupScoreSurface() ? 'popup' : 'main'),
        at: Date.now(),
    };
}

function runPendingScoringUi() {
    const ui = currentMatch?._scoringUi;
    if (!ui || ui._opened) return;
    if (ui.consumer === 'popup' && !isPopupScoreSurface()) return;
    if (ui.consumer === 'main' && isPopupScoreSurface()) return;
    clearTimeout(window._scoringUiTimer);
    const wait = Math.max(0, ui.delay || 0);
    window._scoringUiTimer = setTimeout(() => {
        const u = currentMatch?._scoringUi;
        if (!u || u.at !== ui.at || u._opened) return;
        u._opened = true;
        if (u.type === 'bowler') openNewBowlerModal();
        else if (u.type === 'batsman') openNewBatsmanModal(u.slot ?? 0, u.title || 'New Batsman');
    }, wait);
}

function requestBowlerModal(delay) {
    const consumer = currentMatch?._pendingUiConsumer || (isPopupScoreSurface() ? 'popup' : 'main');
    queueScoringUi({ type: 'bowler', delay: delay != null ? delay : 80, consumer });
    if (consumer === 'main') runPendingScoringUi();
}

function requestBatsmanModal(slot, title, delay) {
    const consumer = currentMatch?._pendingUiConsumer || (isPopupScoreSurface() ? 'popup' : 'main');
    queueScoringUi({ type: 'batsman', slot, title, delay: delay != null ? delay : 80, consumer });
    if (consumer === 'main') runPendingScoringUi();
}

function openBowlerPickerOrQueue() {
    if (currentMatch?._pendingUiConsumer === 'popup') requestBowlerModal(60);
    else openNewBowlerModal();
}

function openBatsmanPickerOrQueue(slot, title, delay) {
    if (currentMatch?._pendingUiConsumer === 'popup') requestBatsmanModal(slot, title, delay != null ? delay : 80);
    else setTimeout(() => openNewBatsmanModal(slot, title), delay || 0);
}

async function forwardPopupScoringCommand(action, payload = {}) {
    if (!isPopupScoreSurface() || !window.desktopAPI?.scoringCommand) return false;
    if (!currentMatch?.id) {
        showToast('No live match', 'error');
        return false;
    }
    try {
        currentMatch._pendingUiConsumer = 'popup';
        const r = await window.desktopAPI.scoringCommand({
            matchId: currentMatch.id,
            action,
            payload,
            uiConsumer: 'popup',
        });
        delete currentMatch._pendingUiConsumer;
        if (!r?.ok) {
            showToast(r?.error || 'Action failed', 'error');
            return false;
        }
        if (r.match) applyDesktopMatchSnapshot(r.match);
        runPendingScoringUi();
        scheduleCloudFlush(true);
        if (!r.match) flushOverlaySignal();
        return true;
    } catch (e) {
        delete currentMatch?._pendingUiConsumer;
        showToast(e?.message || 'Action failed', 'error');
        return false;
    }
}

let _cloudFlushTimer = null;
function primeCloudSyncForLiveMatch(m) {
    if (!m?.id) return;
    m.publishLive = m.publishLive !== false;
    const tid = m.tournamentId;
    if (tid && window.SLCRICK_SYNC?.prefetchCloudToken) {
        const stored = localStorage.getItem(`tourn_pw_${tid}`);
        window.SLCRICK_SYNC.prefetchCloudToken(tid, stored || '').catch(() => {});
    }
    window.SLCRICK_REALTIME?.joinMatch?.(m.id);
    if (tid) window.SLCRICK_REALTIME?.joinTournament?.(tid);
    if (window.SLCRICK_SYNC?.pushLiveMatchNow) {
        window.SLCRICK_SYNC.pushLiveMatchNow(m).catch(() => {});
    } else {
        scheduleCloudFlush(true);
    }
}

function scheduleCloudFlush(immediate) {
    if (!window.SLCRICK_DESKTOP || !window.SLCRICK_SYNC?.flushQueue) return;
    if (!currentMatch?.id) return;
    if (window.SLCRICK_SYNC.isUserSyncDisabled?.()) return;
    if (window.SLCRICK_SYNC.isNetworkOnline?.() === false) return;
    clearTimeout(_cloudFlushTimer);
    const run = () => {
        _cloudFlushTimer = null;
        if (!window.SLCRICK_SYNC?.isEnabled?.()) return;
        if (currentMatch?.id && window.SLCRICK_SYNC.pushLiveMatchNow) {
            window.SLCRICK_SYNC.pushLiveMatchNow(currentMatch)
                .catch(() => window.SLCRICK_SYNC.flushQueue().catch(() => {}));
        } else {
            window.SLCRICK_SYNC.flushQueue().catch(() => {});
        }
    };
    if (immediate) run();
    else _cloudFlushTimer = setTimeout(run, 40);
}

function wireDesktopMatchSyncFromPopups() {
    if (!window.desktopAPI?.onMatchUpdate || window._slcrickPopupSyncWired) return;
    window._slcrickPopupSyncWired = true;
    window.desktopAPI.onMatchUpdate((match) => {
        if (!match?.id) return;
        if (isPopupScoreSurface()) {
            if (currentMatch && match.id !== currentMatch.id) return;
        } else if (currentMatch && match.id !== currentMatch.id) {
            return;
        }
        applyDesktopMatchSnapshot(match);
        runPendingScoringUi();
        if (document.documentElement.classList.contains('popup-score-mode')) {
            scheduleCloudFlush(true);
        }
        const bm = document.getElementById('bm-score-indicator');
        if (bm && currentMatch?.innings) {
            const inn = currentMatch.innings[currentMatch.currentInnings];
            if (inn) {
                bm.textContent = `${inn.runs}/${inn.wickets}`;
            }
        }
        const vs = document.getElementById('bm-vs-indicator');
        if (vs && currentMatch) vs.textContent = 'Overlay linked';
    });
}

function updateHeaderActions() {
    const el = document.getElementById('header-actions');
    if (!el) return;
    const m = currentMatch;
    el.querySelectorAll('.hdr-dynamic').forEach((n) => n.remove());
    if (!m) return;

    const wrap = document.createElement('div');
    wrap.className = 'hdr-dynamic';
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    const desktopBtns = window.SLCRICK_DESKTOP
        ? `<button type="button" class="btn btn-ghost btn-sm" onclick="openPopupScorecardWindow()">🎛 Popup Score</button>
           <button type="button" class="btn btn-primary btn-sm" onclick="openObsPopupWindow()">📡 Pop-up OBS</button>`
        : '';
    wrap.innerHTML = `<span class="badge badge-${m.status === 'live' ? 'green' : 'amber'}">${m.status === 'live' ? 'LIVE' : 'Paused'}</span>${desktopBtns}`;
    const themeBtn = document.getElementById('theme-toggle-scorer');
    if (themeBtn) el.insertBefore(wrap, themeBtn);
    else el.appendChild(wrap);

    refreshDesktopPopupBar();
}

function refreshDesktopPopupBar() {
    const bar = document.getElementById('desktop-popup-bar');
    const m = currentMatch;
    if (!bar) return;
    bar.style.display =
        window.SLCRICK_DESKTOP && m && (m.status === 'live' || m.status === 'paused') ? 'flex' : 'none';
}

function startInlineNameEdit(elementId, onSave) {
    const el = document.getElementById(elementId);
    if (!el || el.querySelector('input')) return;
    const current = (el.textContent || '').trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input inline-name-input';
    input.value = current === '-' ? '' : current;
    input.maxLength = 25;
    input.setAttribute('list', 'db-players-list');

    const finish = (commit) => {
        const val = commit ? input.value.trim() : current;
        el.textContent = val || '-';
        if (commit && val && val !== current && typeof onSave === 'function') {
            onSave(val);
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
        }
    });
    input.addEventListener('blur', () => finish(true));

    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
}

function applyInningsPlayerNameChange(player, newName, side) {
    if (!player || !newName) return;
    const oldName = player.name;
    player.name = newName;
    if (player.playerId && typeof DB !== 'undefined' && DB.getPlayerById) {
        const dbp = DB.getPlayerById(player.playerId);
        if (dbp && typeof DB.updatePlayer === 'function') {
            DB.updatePlayer({ ...dbp, name: newName });
        }
    } else if (side) {
        const resolved = resolvePlayerIdForInnings(newName, side);
        if (resolved) player.playerId = resolved;
    }
    if (oldName !== newName) {
        showToast(`Name updated: ${newName}`, 'success');
    }
}

function editPlayerName(role, idx) {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;

    let p = null;
    let elementId = null;
    let side = null;

    if (role === 'batsman') {
        const batIdx = inn.currentBatsmenIdx[idx];
        if (batIdx === undefined || batIdx === null) {
            showToast('No batsman in this slot', 'error');
            return;
        }
        p = inn.batsmen[batIdx];
        const mobBar = document.getElementById('mobile-batter-bar');
        const useMob =
            mobBar && window.getComputedStyle(mobBar).display !== 'none';
        elementId = useMob ? `mob-bat-name-${idx}` : `bat${idx}-name`;
        side = 'batting';
    } else if (role === 'bowler') {
        if (inn.currentBowlerIdx === null) {
            showToast('No bowler selected', 'error');
            return;
        }
        p = inn.bowlers[inn.currentBowlerIdx];
        elementId = 'bowler-name';
        side = 'bowling';
    }

    if (!p || !elementId) return;

    startInlineNameEdit(elementId, (newName) => {
        applyInningsPlayerNameChange(p, newName, side);
        if (role === 'batsman') {
            [`bat${idx}-name`, `mob-bat-name-${idx}`].forEach((id) => {
                if (id === elementId) return;
                const el = document.getElementById(id);
                if (el && !el.querySelector('input')) el.textContent = newName;
            });
        }
        saveAndRender();
    });
}

/** Swap striker / non-striker ends (wrong batter at striker's end). */
async function swapBatsmenEnds() {
    if (isPopupScoreSurface()) {
        await forwardPopupScoringCommand('swapBatsmenEnds');
        return;
    }
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;

    const i0 = inn.currentBatsmenIdx[0];
    const i1 = inn.currentBatsmenIdx[1];
    if (
        i0 == null ||
        i1 == null ||
        !inn.batsmen[i0] ||
        !inn.batsmen[i1]
    ) {
        showToast('Both batters must be on crease to swap', 'error');
        return;
    }

    inn.strikerIdx = inn.strikerIdx === 0 ? 1 : 0;
    saveAndRender();
    const strikerBat = inn.batsmen[inn.currentBatsmenIdx[inn.strikerIdx]];
    showToast(`⇄ Ends swapped — ${strikerBat?.name || 'Striker'} on strike`, 'success');
}

window.swapBatsmenEnds = swapBatsmenEnds;

// ========== RENDER SCORING UI ==========
function renderScoring() {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;

    // Banner
    document.getElementById('sb-batting-team').textContent = inn.battingTeam || 'Team';
    document.getElementById('sb-bowling-team').textContent = inn.bowlingTeam || 'Team';
    document.getElementById('sb-score').textContent = `${inn.runs}/${inn.wickets}`;
    document.getElementById('sb-overs').textContent = `${formatOvers(inn.balls, m.ballsPerOver)} ov`;
    document.getElementById('sb-crr').textContent = formatCRR(inn.runs, inn.balls);

    // Target/Lead info
    const tbArea = document.getElementById('sb-target-area');
    const isTest = m.matchFormat === 'test';
    
    // Innings label
    const innsLabel = document.getElementById('sb-inns-label');
    if (innsLabel) {
        if (isTest) {
            innsLabel.textContent = `(Inn ${(m.currentInnings || 0) + 1}/${m.totalInnings || 4})`;
        } else {
            innsLabel.textContent = `(Inn ${(m.currentInnings || 0) + 1}/2)`;
        }
    }

    if (!isTest && m.currentInnings === 1 && m.innings[0]) {
        const target = m.innings[0].runs + 1;
        const need = target - inn.runs;
        const ballsLeft = (m.overs * m.ballsPerOver) - inn.balls;
        const rrr = ballsLeft > 0 ? ((need / ballsLeft) * m.ballsPerOver).toFixed(2) : '—';
        tbArea.innerHTML = `
      <div class="sb-target-text">Target: ${target}</div>
      <div class="sb-need-text">${need > 0 ? `Need ${need} off ${ballsLeft} balls` : '🎉 Won!'} · RRR: ${rrr}</div>`;
    } else if (isTest) {
        const totalA = (m.innings[0]?.runs || 0) + (m.innings[2]?.runs || 0);
        const totalB = (m.innings[1]?.runs || 0) + (m.innings[3]?.runs || 0);
        const diff = Math.abs(totalA - totalB);
        let leader = (totalA > totalB ? m.battingFirst : m.fieldingFirst) || '—';
        if (totalA === totalB) leader = 'Scores Level';
        else leader = leader + ' leads by ' + diff;
        
        let subText = '';
        if (m.currentInnings === 3) {
            const target = (m.innings[0]?.runs || 0) + (m.innings[2]?.runs || 0) - (m.innings[1]?.runs || 0) + 1;
            const need = target - (m.innings[3]?.runs || 0);
            subText = need > 0 ? `Target: ${target} (Need ${need})` : '🎉 Won!';
        }

        tbArea.innerHTML = `
            <div class="sb-target-text" style="font-size:12px; color:var(--c-amber)">${leader}</div>
            <div class="sb-need-text" style="font-size:11px">${subText}</div>
        `;
    } else { tbArea.innerHTML = ''; }

    // Current over balls strip
    const strip = document.getElementById('over-balls-strip');
    strip.innerHTML = inn.currentOver.map(b => {
        const cls = b.wicket ? 'wicket' : b.type === 'four' ? 'four' : b.type === 'six' ? 'six'
            : b.type === 'wide' ? 'wide' : b.type === 'noball' ? 'noball'
                : b.type === 'bye' ? 'bye' : b.type === 'legbye' ? 'legbye'
                    : b.runs === 0 ? 'dot' : '';
        const label = b.wicket ? 'W' : b.type === 'wide' ? 'Wd' : b.type === 'noball' ? 'Nb'
            : b.type === 'bye' ? `By${b.runs}` : b.type === 'legbye' ? `Lb${b.runs}` : (b.runs || '·');
        return `<div class="obs-chip ${cls}">${label}</div>`;
    }).join('');

    // Batting stats (desktop right col + mobile batter bar)
    [0, 1].forEach(i => {
        const batIdx = inn.currentBatsmenIdx ? inn.currentBatsmenIdx[i] : null;
        const bat = (batIdx !== undefined && batIdx !== null) ? (inn.batsmen ? inn.batsmen[batIdx] : null) : null;
        const batNameEl = document.getElementById(`bat${i}-name`);
        if (batNameEl) {
            batNameEl.textContent = bat ? (bat.name || '-') : '-';
            document.getElementById(`bat${i}-runs`).textContent = bat ? (bat.runs || 0) : 0;
            document.getElementById(`bat${i}-balls`).textContent = bat ? (bat.balls || 0) : 0;
            document.getElementById(`bat${i}-4s`).textContent = bat ? (bat.fours || 0) : 0;
            document.getElementById(`bat${i}-6s`).textContent = bat ? (bat.sixes || 0) : 0;
            document.getElementById(`bat${i}-sr`).textContent = bat ? formatSR(bat.runs || 0, bat.balls || 0) : '0.0';
            const rowEl = document.getElementById(`bat-row-${i}`);
            if (rowEl) rowEl.style.background = i === inn.strikerIdx ? 'rgba(124,77,255,0.12)' : 'transparent';
            batNameEl.className = i === inn.strikerIdx ? 'striker-name' : '';
        }

        // Mobile batter bar
        const mobName = document.getElementById(`mob-bat-name-${i}`);
        if (mobName) {
            mobName.textContent = bat ? (bat.name || `Batter ${i+1}`) : `Batter ${i+1}`;
            document.getElementById(`mob-bat-score-${i}`).textContent = bat ? (bat.runs || 0) : 0;
            document.getElementById(`mob-bat-balls-${i}`).textContent = `(${bat ? (bat.balls || 0) : 0}b)`;
            const cell = document.getElementById(`mob-bat-${i}`);
            if (cell) cell.classList.toggle('is-striker', i === inn.strikerIdx);
        }
    });

    // Bowling
    const bowler = inn.currentBowlerIdx !== null ? inn.bowlers[inn.currentBowlerIdx] : null;
    const bowlerNameEl = document.getElementById('bowler-name');
    if (bowlerNameEl) {
        bowlerNameEl.textContent = bowler ? bowler.name : '-';
        document.getElementById('bowler-overs').textContent = bowler ? formatOvers(bowler.balls || 0, m.ballsPerOver) : '0';
        document.getElementById('bowler-maidens').textContent = bowler ? (bowler.maidens || 0) : '0';
        document.getElementById('bowler-runs').textContent = bowler ? (bowler.runs || 0) : '0';
        document.getElementById('bowler-wkts').textContent = bowler ? (bowler.wickets || 0) : '0';
        document.getElementById('bowler-econ').textContent = bowler ? formatEcon(bowler.runs || 0, bowler.balls || 0, m.ballsPerOver) : '0.0';
    }

    // Mobile bowler bar
    const mobBowlerBar = document.getElementById('mobile-bowler-bar');
    if (mobBowlerBar) {
        if (bowler) {
            mobBowlerBar.style.display = 'flex';
            document.getElementById('mob-bowler-name').textContent = `🎯 ${bowler.name}`;
            document.getElementById('mob-bowler-stats').textContent = 
                `${formatOvers(bowler.balls || 0, m.ballsPerOver)} ov | ${bowler.runs || 0}R | ${bowler.wickets || 0}W`;
        } else {
            mobBowlerBar.style.display = 'none';
        }
    }

    // Partnership – track per partnership object
    const p = getPartnership(inn);
    const pr = p.runs || 0;
    const pb = p.balls || 0;
    const psr = formatSR(p.runs || 0, p.balls || 0);
    ['partner-runs', 'partner-runs-sc'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = pr;
    });
    ['partner-balls', 'partner-balls-sc'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = pb;
    });
    ['partner-sr', 'partner-sr-sc'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = psr;
    });

    // Fall of wickets
    const fowHtml =
        inn.fallOfWickets && inn.fallOfWickets.length
            ? `<div style="display:flex;flex-wrap:wrap;gap:6px">` +
              inn.fallOfWickets
                  .map(
                      (fw, i) =>
                          `<span class="badge badge-red" title="${fw.batsmanName} – ${fw.wicketType}">${i + 1}–${fw.runs} (${fw.batsmanName}, ${formatOvers(fw.balls, m.ballsPerOver)} ov)</span>`
                  )
                  .join('') +
              `</div>`
            : null;
    ['fow-list', 'fow-list-sc'].forEach((id) => {
        const fowEl = document.getElementById(id);
        if (!fowEl) return;
        if (fowHtml) fowEl.innerHTML = fowHtml;
        else fowEl.textContent = 'No wickets yet';
    });

    // Undo/Redo states
    document.getElementById('undo-btn').disabled = !(m.history && m.history.length);
    document.getElementById('redo-btn').disabled = !(m.redoStack && m.redoStack.length);
    const lastBall = m.history && m.history.length ? m.history[m.history.length - 1] : null;
    document.getElementById('last-ball-info').textContent = lastBall ? 'Last action can be undone' : '';

    // CRITICAL: Ensure Match Controls are visible if match is active
    const controls = document.getElementById('card-controls');
    if (controls) {
        controls.style.display = (m.status === 'live' || m.status === 'paused') ? 'block' : 'none';
        
        const decBtn = document.getElementById('btn-declare');
        if (decBtn) {
            decBtn.style.display = (m.matchFormat === 'test' && m.status === 'live') ? 'block' : 'none';
        }
    }

    if (typeof syncLivePlayerPhotoSlots === 'function') {
        syncLivePlayerPhotoSlots(m);
    }

    refreshDesktopPopupBar();
}

function uploadPlayerPhoto(role) {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;

    let p = null;
    if (role === 'striker') {
        const idx = inn.currentBatsmenIdx[inn.strikerIdx];
        p = idx !== null && idx !== undefined ? inn.batsmen[idx] : null;
    } else if (role === 'nonstriker') {
        const idx = inn.currentBatsmenIdx[inn.strikerIdx === 0 ? 1 : 0];
        p = idx !== null && idx !== undefined ? inn.batsmen[idx] : null;
    } else if (role === 'bowler') {
        p = inn.currentBowlerIdx !== null && inn.currentBowlerIdx !== undefined ? inn.bowlers[inn.currentBowlerIdx] : null;
    } else if (role === 'guest') {
        // Special case for guest: create a temporary player object
        p = { name: document.getElementById('guest-name')?.value || 'Special Guest', playerId: 'GUEST_' + Date.now() };
    }

    if (!p) {
        showToast('No player selected for this role', 'error');
        return;
    }
    
    // Auto-generate a dummy ID if it's missing (e.g. ad-hoc manual match)
    if (!p.playerId) {
        p.playerId = 'MANUAL_' + p.name.replace(/\s+/g, '_') + '_' + Date.now();
        // Since it's an ad-hoc player, we don't save to DB.PLAYERS, but photo key will use this id.
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target.result;
            DB.savePlayerPhoto(p.playerId, dataUrl);
            DB.saveMatch(currentMatch);
            window[`__photo_cleared_${role}`] = false;
            window[`__photo_bound_${role}`] = String(p.playerId || p.name || '');
            if (role === 'striker') window.__photo_striker = dataUrl;
            else if (role === 'nonstriker') window.__photo_nonstriker = dataUrl;
            else if (role === 'bowler') window.__photo_bowler = dataUrl;
            showToast('✅ Photo updated & synced!', 'success');
            if (typeof syncLivePlayerPhotoSlots === 'function') {
                syncLivePlayerPhotoSlots(currentMatch);
            } else if (typeof renderCurrentState === 'function') {
                renderCurrentState();
            }
            if (typeof Broadcast !== 'undefined') {
                Broadcast.send('SYNC_PLAYER_PHOTO', { playerId: p.playerId, photo: dataUrl });
                Broadcast.send('SYNC_SCORE', { match: currentMatch });
            }
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

function getPartnership(inn) {
    // Use dedicated partnership tracker
    if (!inn.currentPartnership) inn.currentPartnership = { runs: 0, balls: 0 };
    return inn.currentPartnership;
}

function setStriker(i) {
    if (!currentMatch) return;
    currentMatch.innings[currentMatch.currentInnings].strikerIdx = i;
    saveAndRender();
    
    maybeAutoBroadcastPlayerProfile('striker');
}

// ========== RECORD BALL ==========
async function recordBall(event) {
    if (isPopupScoreSurface()) {
        await forwardPopupScoringCommand('recordBall', { event: event });
        return;
    }
    const m = currentMatch;
    if (!m || m.status !== 'live') return;
    const inn = m.innings[m.currentInnings];
    if (!inn || inn.isDone) return;

    // Need bowler?
    if (inn.currentBowlerIdx === null) {
        pendingBallEvent = event; openBowlerPickerOrQueue(); return;
    }
    // Need batsmen?
    const idx0 = inn.currentBatsmenIdx[0], idx1 = inn.currentBatsmenIdx[1];
    if (idx0 === undefined || idx0 === null || !inn.batsmen[idx0]) {
        pendingBallEvent = event; openBatsmanPickerOrQueue(0, '1st Batsman', 0); return;
    }
    if (idx1 === undefined || idx1 === null || !inn.batsmen[idx1]) {
        pendingBallEvent = event; openBatsmanPickerOrQueue(1, '2nd Batsman', 0); return;
    }

    pushHistory();
    applyBall(inn, event);
    saveAndRender();

    // 4/6/W TV graphics: hotkeys only (see triggerVisualBigEvent)

    // Check order matters: over end first, then innings end
    checkEndOfOver(inn);
    checkEndOfInnings(inn, null);
}

function applyBall(inn, event) {
    const m = currentMatch;
    const bpo = m.ballsPerOver;
    const strikerSlot = inn.strikerIdx;
    const strikerIdx = inn.currentBatsmenIdx[strikerSlot];
    const striker = inn.batsmen[strikerIdx];
    const bowler = inn.bowlers[inn.currentBowlerIdx];

    const isLegal = (event.type !== 'wide' && event.type !== 'noball');
    const runs = event.runs || 0;

    if (isLegal) {
        inn.balls++;
        striker.balls++;
    }

    inn.runs += runs;

    // Batsman scoring: runs go to striker (not for bye/legbye)
    if (event.type !== 'bye' && event.type !== 'legbye') {
        striker.runs += runs;
        if (event.type === 'four') striker.fours++;
        if (event.type === 'six') striker.sixes++;
    }

    // Bowler concedes runs (NOT for bye/legbye)
    if (bowler) {
        if (isLegal) bowler.balls++;
        if (event.type !== 'bye' && event.type !== 'legbye') bowler.runs += runs;
        // Maiden check: done at end of over
    }

    // Partnership tracking
    if (!inn.currentPartnership) inn.currentPartnership = { runs: 0, balls: 0 };
    inn.currentPartnership.runs += runs;
    if (isLegal) inn.currentPartnership.balls++;

    // Push ball record
    inn.currentOver.push({
        type: event.type,
        runs,
        wicket: false,
        batsmanIdx: strikerIdx,
        bowlerIdx: inn.currentBowlerIdx,
        legal: isLegal,
    });

    // Rotate strike on odd runs (legal balls only)
    if (isLegal && runs % 2 === 1) {
        inn.strikerIdx = inn.strikerIdx === 0 ? 1 : 0;
    }
}

function recordExtra(type) {
    const m = currentMatch;
    if (!m || m.status !== 'live') return;
    const inn = m.innings[m.currentInnings];
    if (!inn || inn.isDone) return;
    if (inn.currentBowlerIdx === null) { pendingExtraType = type; openBowlerPickerOrQueue(); return; }

    if (type === 'wide') {
        openWideModal(); // Always use modal for wide (supports extra overthrow runs)
        return;
    } else if (type === 'noball') {
        openNoballModal();
        return;
    }
    // fallthrough for any other extra type
    saveAndRender();
    checkEndOfInnings(inn, null);
}

// ---- Wide ----
let wideExtraRuns = 0;

function openWideModal() {
    const m = currentMatch;
    if (!m || m.status !== 'live') return;
    const inn = m.innings[m.currentInnings];
    if (!inn || inn.isDone) return;
    if (inn.currentBowlerIdx === null) { pendingExtraType = 'wide'; openBowlerPickerOrQueue(); return; }
    wideExtraRuns = 0;
    document.querySelectorAll('#modal-wide .wr-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    openModal('modal-wide');
}

function selectWideRuns(btn) {
    wideExtraRuns = parseInt(btn.dataset.val);
    document.querySelectorAll('#modal-wide .wr-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

async function confirmWide() {
    if (isPopupScoreSurface()) {
        closeModal('modal-wide');
        await forwardPopupScoringCommand('confirmWide', { wideExtraRuns });
        return;
    }
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn || inn.isDone) { closeModal('modal-wide'); return; }
    if (inn.currentBowlerIdx === null) { closeModal('modal-wide'); pendingExtraType = 'wide'; openBowlerPickerOrQueue(); return; }

    pushHistory();
    const totalRuns = 1 + wideExtraRuns; // 1 wide penalty + overthrows
    inn.runs += totalRuns;
    inn.extras.wides += totalRuns;
    
    // Bowler's runs increase by the total runs (Wide + any overthrows)
    const bowler = inn.bowlers[inn.currentBowlerIdx];
    if (bowler) bowler.runs += totalRuns;

    if (!inn.currentPartnership) inn.currentPartnership = { runs: 0, balls: 0 };
    inn.currentPartnership.runs += totalRuns;
    
    // Wide is NOT a legal delivery — ball count doesn't increase
    inn.currentOver.push({ type: 'wide', runs: totalRuns, wicket: false, legal: false });
    
    // On overthrows (odd extra runs), rotate strike
    // Note: Wide penalty itself doesn't rotate strike, overthrow runs do.
    if (wideExtraRuns % 2 === 1) inn.strikerIdx = inn.strikerIdx === 0 ? 1 : 0;

    closeModal('modal-wide');
    saveAndRender();
    checkEndOfInnings(inn, null);
}

// ---- Bye / Leg Bye ----
function openByeModal() {
    byeExtraType = 'bye';
    document.getElementById('bye-modal-title').textContent = 'Bye Runs';
    byeRuns = 1;
    document.querySelectorAll('#modal-bye .wr-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    openModal('modal-bye');
}
function openLegByeModal() {
    byeExtraType = 'legbye';
    document.getElementById('bye-modal-title').textContent = 'Leg Bye Runs';
    byeRuns = 1;
    document.querySelectorAll('#modal-bye .wr-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    openModal('modal-bye');
}
function selectByeRuns(btn) {
    byeRuns = parseInt(btn.dataset.val);
    document.querySelectorAll('#modal-bye .wr-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}
async function confirmBye() {
    if (isPopupScoreSurface()) {
        closeModal('modal-bye');
        await forwardPopupScoringCommand('confirmBye', { byeExtraType, byeRuns });
        return;
    }
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn || inn.isDone) { closeModal('modal-bye'); return; }

    if (inn.currentBowlerIdx === null) {
        closeModal('modal-bye');
        pendingExtraType = byeExtraType;
        openBowlerPickerOrQueue(); return;
    }

    // Ensure batsmen exist
    if (!inn.batsmen.length || inn.currentBatsmenIdx[0] === null) {
        closeModal('modal-bye'); return;
    }

    pushHistory();

    // Bye/LegBye: runs go to team total and extras, NOT to batsman
    // BUT it IS a legal delivery (ball counts, bowler ball counts)
    inn.runs += byeRuns;
    inn.balls++;

    const bowler = inn.bowlers[inn.currentBowlerIdx];
    if (bowler) bowler.balls++; // bowler's ball count increases but NOT runs

    if (byeExtraType === 'bye') inn.extras.byes += byeRuns;
    else inn.extras.legByes += byeRuns;

    if (!inn.currentPartnership) inn.currentPartnership = { runs: 0, balls: 0 };
    inn.currentPartnership.runs += byeRuns;
    inn.currentPartnership.balls += 1;

    // Batsman at strike: ball counts for THEIR balls faced (it's a legal delivery)
    const strikerIdx = inn.currentBatsmenIdx[inn.strikerIdx];
    if (strikerIdx !== null && inn.batsmen[strikerIdx]) {
        inn.batsmen[strikerIdx].balls++;
    }

    inn.currentOver.push({ type: byeExtraType, runs: byeRuns, wicket: false, legal: true });

    // Rotate strike on odd runs
    if (byeRuns % 2 === 1) inn.strikerIdx = inn.strikerIdx === 0 ? 1 : 0;

    closeModal('modal-bye');
    saveAndRender();
    checkEndOfOver(inn);
    checkEndOfInnings(inn, null);
}

// ---- No Ball ----
let noballRuns = 0;

function openNoballModal() {
    noballRuns = 0;
    document.querySelectorAll('#modal-noball .wr-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    openModal('modal-noball');
}

function selectNoballRuns(btn) {
    noballRuns = parseInt(btn.dataset.val);
    document.querySelectorAll('#modal-noball .wr-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

async function confirmNoball() {
    if (isPopupScoreSurface()) {
        closeModal('modal-noball');
        await forwardPopupScoringCommand('confirmNoball', { noballRuns });
        return;
    }
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn || inn.isDone) { closeModal('modal-noball'); return; }

    if (inn.currentBowlerIdx === null) {
        closeModal('modal-noball');
        pendingExtraType = 'custom_noball';
        openBowlerPickerOrQueue(); return;
    }

    if (!inn.batsmen.length || inn.currentBatsmenIdx[0] === null) {
        closeModal('modal-noball'); return;
    }

    pushHistory();

    const totalRuns = 1 + noballRuns;
    inn.runs += totalRuns;
    inn.extras.noBalls += 1;

    const strikerIdx = inn.currentBatsmenIdx[inn.strikerIdx];
    const striker = inn.batsmen[strikerIdx];
    if (striker && noballRuns > 0) {
        striker.runs += noballRuns;
        if (noballRuns === 4) striker.fours++;
        if (noballRuns === 6) striker.sixes++;
        striker.balls++; 
    }

    const bowler = inn.bowlers[inn.currentBowlerIdx];
    if (bowler) bowler.runs += totalRuns;

    if (!inn.currentPartnership) inn.currentPartnership = { runs: 0, balls: 0 };
    inn.currentPartnership.runs += totalRuns;

    inn.currentOver.push({ type: 'noball', runs: noballRuns, wicket: false, legal: false });

    if (noballRuns % 2 === 1) inn.strikerIdx = inn.strikerIdx === 0 ? 1 : 0;

    closeModal('modal-noball');
    saveAndRender();
    checkEndOfInnings(inn, null);
}

// ========== WICKET ==========
function openWicketModal() {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;


    const bat0 = inn.batsmen[inn.currentBatsmenIdx[0]];
    const bat1 = inn.batsmen[inn.currentBatsmenIdx[1]];
    document.getElementById('wk-bat-name-0').textContent = bat0 ? bat0.name : 'Batter 1';
    document.getElementById('wk-bat-name-1').textContent = bat1 ? bat1.name : 'Batter 2';

    // Reset wicket runs selection
    wicketRuns = 0;
    document.querySelectorAll('#modal-wicket .wr-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.val) === 0)
    );
    document.getElementById('wicket-fielder').value = '';
    document.getElementById('wicket-type').selectedIndex = 0;

    openModal('modal-wicket');
}

function selectWicketRuns(btn) {
    wicketRuns = parseInt(btn.dataset.val || 0);
    document.querySelectorAll('#modal-wicket .wr-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

async function confirmWicket() {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn || inn.isDone) { closeModal('modal-wicket'); return; }

    if (inn.currentBowlerIdx === null) { closeModal('modal-wicket'); openBowlerPickerOrQueue(); return; }

    const radio = document.querySelector('input[name="dismissed"]:checked');
    const dismissedSlot = radio ? parseInt(radio.value) : inn.strikerIdx;
    const wicketType = document.getElementById('wicket-type').value;
    const fielder = document.getElementById('wicket-fielder').value.trim();

    if (isPopupScoreSurface()) {
        closeModal('modal-wicket');
        await forwardPopupScoringCommand('confirmWicket', {
            dismissedSlot,
            wicketType,
            fielder,
            wicketRuns,
        });
        return;
    }
    const dismissedBatIdx = inn.currentBatsmenIdx[dismissedSlot];
    const dismissedBat = inn.batsmen[dismissedBatIdx];

    pushHistory();

    // This is a legal delivery → balls++
    inn.balls++;
    inn.wickets++;
    inn.runs += wicketRuns;

    // Dismissed batsman stats
    if (dismissedBat) {
        dismissedBat.balls++;                           // ball faced on dismissal
        dismissedBat.runs += wicketRuns;               // if they ran before getting out
        dismissedBat.notOut = false;
        dismissedBat.dismissal = buildDismissalText(wicketType, fielder,
            inn.bowlers[inn.currentBowlerIdx]?.name);
    }

    // Bowler stats
    const bowler = inn.bowlers[inn.currentBowlerIdx];
    if (bowler) {
        bowler.balls++;
        bowler.runs += wicketRuns;
        const notBowlerWickets = ['Run Out', 'Obstructing', 'Handled Ball', 'Timed Out'];
        if (!notBowlerWickets.includes(wicketType)) bowler.wickets++;
    }

    // Fall of wickets
    inn.fallOfWickets.push({
        runs: inn.runs, balls: inn.balls,
        batsmanName: dismissedBat ? dismissedBat.name : '?',
        wicketType,
    });

    captureLastWicketForBroadcast(m, inn, dismissedBat);

    // Save to historical partnerships
    if (!inn.partnerships) inn.partnerships = [];
    if (inn.currentPartnership) {
        const batA = inn.batsmen[inn.currentBatsmenIdx[0]];
        const batB = inn.batsmen[inn.currentBatsmenIdx[1]];
        inn.partnerships.push({
            runs: inn.currentPartnership.runs,
            balls: inn.currentPartnership.balls,
            batsman1: batA ? batA.name : 'Unknown',
            batsman2: batB ? batB.name : 'Unknown',
            wicket: dismissedBat ? dismissedBat.name : 'Retired'
        });
    }

    // Reset partnership for new pair
    inn.currentPartnership = { runs: 0, balls: 0 };

    // Ball record
    inn.currentOver.push({ type: 'run', runs: wicketRuns, wicket: true, legal: true });

    // Rotate on odd wicket-ball runs
    if (wicketRuns % 2 === 1) inn.strikerIdx = inn.strikerIdx === 0 ? 1 : 0;

    currentPendingWicket = dismissedSlot;
    closeModal('modal-wicket');
    saveAndRender();
    
    // Wicket TV graphic: hotkeys only (Shift+W / LAST WICKET card)

    // Check end of over first
    const overDone = checkEndOfOver(inn);

    // Check end of innings
    const m2 = currentMatch;
    const needWickets = m2.playersPerSide - 1;
    const needBalls = m2.overs * m2.ballsPerOver;
    const innsEnded = inn.wickets >= needWickets || inn.balls >= needBalls;

    if (m2.currentInnings === 1 && m2.innings[0] && inn.runs >= m2.innings[0].runs + 1) {
        // Chase complete
        inn.isDone = true;
        finishInnings(inn, 'chase_won');
        return;
    }

    if (innsEnded) {
        inn.isDone = true;
        finishInnings(inn, 'all_out_or_overs');
    } else {
        // Need new batsman
        openBatsmanPickerOrQueue(dismissedSlot, 'New Batsman In', overDone ? 180 : 80);
    }
}

function buildDismissalText(type, fielder, bowlerName) {
    switch (type) {
        case 'Bowled': return `b ${bowlerName || '?'}`;
        case 'Caught': return `c ${fielder || '?'} b ${bowlerName || '?'}`;
        case 'LBW': return `lbw b ${bowlerName || '?'}`;
        case 'Run Out': return `run out (${fielder || '?'})`;
        case 'Stumped': return `st ${fielder || '?'} b ${bowlerName || '?'}`;
        case 'Hit Wicket': return `hit wkt b ${bowlerName || '?'}`;
        case 'C&B': return `c & b ${bowlerName || '?'}`;
        default: return type;
    }
}

function computeBatterOverlayStats(bat) {
    const balls = bat?.balls || 0;
    const runs = bat?.runs || 0;
    const fours = bat?.fours || 0;
    const sixes = bat?.sixes || 0;
    const boundaryBalls = fours + sixes;
    let nonBoundaryRuns = Math.max(0, runs - fours * 4 - sixes * 6);
    let scoringOther = 0;
    while (nonBoundaryRuns > 0 && scoringOther < balls - boundaryBalls) {
        if (nonBoundaryRuns >= 3) {
            scoringOther++;
            nonBoundaryRuns -= 3;
        } else if (nonBoundaryRuns >= 2) {
            scoringOther++;
            nonBoundaryRuns -= 2;
        } else {
            scoringOther++;
            nonBoundaryRuns -= 1;
        }
    }
    const dots = Math.max(0, balls - boundaryBalls - scoringOther);
    const strikeRate = balls > 0 ? Math.round((runs / balls) * 100) : 0;
    return { fours, sixes, dots, strikeRate };
}

/** Store last dismissal for manual TV graphic (not auto-shown). */
function captureLastWicketForBroadcast(m, inn, dismissedBat) {
    if (!m || !inn || !dismissedBat) return;
    const innIdx = m.currentInnings ?? 0;
    const innNum = innIdx + 1;
    const ord =
        innNum === 1 ? '1st' : innNum === 2 ? '2nd' : innNum === 3 ? '3rd' : `${innNum}th`;
    const teamName = inn.battingTeam || m.team1 || 'TEAM';
    const extra = computeBatterOverlayStats(dismissedBat);
    m.lastWicket = {
        name: (dismissedBat.name || '?').toUpperCase(),
        runs: dismissedBat.runs ?? 0,
        balls: dismissedBat.balls ?? 0,
        inningsLabel: `${ord} INNS`,
        dismissal: (dismissedBat.dismissal || 'out').toLowerCase(),
        teamName,
        inningsIndex: innIdx,
        fours: extra.fours,
        sixes: extra.sixes,
        dots: extra.dots,
        strikeRate: extra.strikeRate,
        at: Date.now(),
    };
}

function showLastWicketBroadcast() {
    if (typeof Broadcast !== 'undefined' && Broadcast.showLastWicket) {
        Broadcast.showLastWicket();
        return;
    }
    const m = currentMatch;
    const payload =
        typeof buildLastWicketBroadcastData === 'function'
            ? buildLastWicketBroadcastData(m)
            : m?.lastWicket || null;
    if (!payload?.batters?.length && !payload?.name) {
        showToast('No wickets recorded yet this innings', 'error');
        return;
    }
    sendBroadcast('SHOW_LAST_WICKET', payload);
}
window.showLastWicketBroadcast = showLastWicketBroadcast;

// ========== NEW BATSMAN ==========
function openNewBatsmanModal(slot, title) {
    currentPendingWicket = (slot !== undefined) ? slot : 0;
    document.getElementById('new-batsman-sub').textContent = title || 'New Batsman';
    document.getElementById('new-bat-name').value = '';
    document.getElementById('player-lookup-result').textContent = '';
    populateSquadDatalist('batting');
    renderSquadQuickPick('squad-bat-opts', 'batting');
    openModal('modal-new-batsman');
}

function lookupPlayer() {
    const name = document.getElementById('new-bat-name')?.value.trim();
    const player = name ? findPlayerInTeamRoster(name, getInningsTeamForSide('batting')) : null;
    const resultEl = document.getElementById('player-lookup-result');
    if (!resultEl) return;
    if (player) {
        document.getElementById('new-bat-name').value = player.name;
        resultEl.innerHTML = `✅ <b>${player.name}</b> | ${capitalize(player.role || 'player')} | ${player.team || 'No team'}`;
        resultEl.style.color = '#00e676';
    } else {
        resultEl.textContent = '';
    }
}

async function confirmNewBatsman() {
    const name = document.getElementById('new-bat-name').value.trim();
    let pid = '';
    if (!name) { showToast('❌ Enter batsman name', 'error'); return; }

    if (isPopupScoreSurface()) {
        closeModal('modal-new-batsman');
        await forwardPopupScoringCommand('confirmNewBatsman', {
            name,
            pid,
            slot: currentPendingWicket,
        });
        return;
    }

    const rosterPid = ensurePlayerOnTeamRoster(name, 'batting');
    if (!pid) pid = rosterPid || '';
    if (!pid) pid = resolvePlayerIdForInnings(name, 'batting') || '';
    if (!pid) {
        const pMatch = DB.getPlayers().find(p => p.name.toLowerCase() === name.toLowerCase());
        if (pMatch) pid = pMatch.playerId;
    }

    const m = currentMatch;
    const inn = m.innings[m.currentInnings];
    const bat = {
        name, playerId: pid || null,
        runs: 0, balls: 0, fours: 0, sixes: 0,
        notOut: true, dismissal: null,
    };
    inn.batsmen.push(bat);
    const newIdx = inn.batsmen.length - 1;

    const idx0 = inn.currentBatsmenIdx[0];
    const idx1 = inn.currentBatsmenIdx[1];

    // Replace dismissed slot or fill first empty
    if (idx0 === undefined || idx0 === null) {
        inn.currentBatsmenIdx[0] = newIdx;
    } else if (idx1 === undefined || idx1 === null) {
        inn.currentBatsmenIdx[1] = newIdx;
    } else {
        inn.currentBatsmenIdx[currentPendingWicket] = newIdx;
    }
    
    // Auto-set striker to the new batsman
    inn.strikerIdx = (idx0 === undefined || idx0 === null) ? 0 : 
                    (idx1 === undefined || idx1 === null) ? 1 : currentPendingWicket;

    // Reset partnership
    inn.currentPartnership = { runs: 0, balls: 0 };

    closeModal('modal-new-batsman');
    if (currentMatch?._scoringUi) delete currentMatch._scoringUi;
    if (inn.currentBowlerIdx === null) {
        openBowlerPickerOrQueue();
    } else { saveAndRender(); }
    
    if (typeof syncLivePlayerPhotoSlots === 'function') syncLivePlayerPhotoSlots(m);
    maybeAutoBroadcastPlayerProfile('striker');

    showToast(`🏏 ${name} is now at the crease!`, 'success');
}

// ========== NEW BOWLER ==========
function openNewBowlerModal() {
    document.getElementById('new-bowl-name').value = '';
    populateSquadDatalist('bowling');
    renderSquadQuickPick('recent-bowlers-opts', 'bowling', { includeInningsBowlers: true });
    openModal('modal-new-bowler');
}

function pickSquadBowlerName(name) {
    const inp = document.getElementById('new-bowl-name');
    if (inp) {
        inp.value = name;
        applySquadNameInput(inp, 'bowling', 'bowler');
    }
}

function lookupBowler() {
    const name = document.getElementById('new-bowl-name')?.value.trim();
    const player = name ? findPlayerInTeamRoster(name, getInningsTeamForSide('bowling')) : null;
    if (player) {
        document.getElementById('new-bowl-name').value = player.name;
        showToast(`✅ Found: ${player.name}`, 'success');
    }
}

async function confirmNewBowler() {
    const name = document.getElementById('new-bowl-name').value.trim();
    let pid = '';
    if (!name) { showToast('❌ Enter bowler name', 'error'); return; }

    if (isPopupScoreSurface()) {
        closeModal('modal-new-bowler');
        await forwardPopupScoringCommand('confirmNewBowler', { name, pid });
        return;
    }

    const rosterPid = ensurePlayerOnTeamRoster(name, 'bowling');
    if (!pid) pid = rosterPid || '';
    if (!pid) pid = resolvePlayerIdForInnings(name, 'bowling') || '';
    if (!pid) {
        const pMatch = DB.getPlayers().find(p => p.name.toLowerCase() === name.toLowerCase());
        if (pMatch) pid = pMatch.playerId;
    }

    if (currentMatch?._scoringUi) delete currentMatch._scoringUi;

    const m = currentMatch;
    const inn = m.innings[m.currentInnings];

    let bowlerIdx = inn.bowlers.findIndex(b => b.name === name);
    if (bowlerIdx === -1) {
        inn.bowlers.push({ name, playerId: pid || null, balls: 0, runs: 0, wickets: 0, maidens: 0 });
        bowlerIdx = inn.bowlers.length - 1;
    }
    inn.currentBowlerIdx = bowlerIdx;
    closeModal('modal-new-bowler');

    if (pendingBallEvent) {
        const ev = pendingBallEvent; pendingBallEvent = null;
        setTimeout(() => recordBall(ev), 100);
    } else if (pendingExtraType) {
        const et = pendingExtraType; pendingExtraType = null;
        if (et === 'custom_noball') { setTimeout(() => confirmNoball(), 100); }
        else { setTimeout(() => recordExtra(et), 100); }
    } else { saveAndRender(); }
    showToast(`⚾ ${name} is now bowling`, 'success');

    if (typeof syncLivePlayerPhotoSlots === 'function') syncLivePlayerPhotoSlots(m);
    maybeAutoBroadcastPlayerProfile('bowler');
}

// ========== END OF OVER ==========
// Returns true if over ended
function checkEndOfOver(inn) {
    const m = currentMatch;
    const bpo = m.ballsPerOver;
    if (inn.balls > 0 && inn.balls % bpo === 0) {
        // Maiden detection
        const bowler = inn.bowlers[inn.currentBowlerIdx];
        if (bowler) {
            const overRuns = inn.currentOver.reduce((s, b) => {
                // Only count runs that go to bowler (not byes/legbyes)
                if (b.type !== 'bye' && b.type !== 'legbye') return s + (b.runs || 0);
                return s;
            }, 0);
            if (overRuns === 0 && inn.currentOver.length > 0) bowler.maidens++;
        }

        // Save completed over
        inn.overHistory.push([...inn.currentOver]);
        inn.currentOver = [];
        inn.currentBowlerIdx = null;

        // Rotate strike at end of over
        inn.strikerIdx = inn.strikerIdx === 0 ? 1 : 0;

        saveAndRender();
        const overNum = inn.balls / bpo;
        showToast(`Over ${overNum} complete!`);

        // Check if innings ended to prevent showing bowler modal
        const isTest = m.matchFormat === 'test';
        let isEnd = (inn.balls >= m.overs * bpo) || (inn.wickets >= (m.playersPerSide - 1));
        
        if (!isTest && m.currentInnings === 1 && m.innings[0] && inn.runs >= m.innings[0].runs + 1) isEnd = true;
        if (isTest && m.currentInnings === 3) {
            const totalA = (m.innings[0]?.runs || 0) + (m.innings[2]?.runs || 0);
            const totalB = (m.innings[1]?.runs || 0) + (inn.runs || 0);
            if (totalB >= totalA + 1) isEnd = true;
        }

        if (!isEnd) {
            requestBowlerModal(100);
        }
        return true;
    }
    return false;
}

// ========== END OF INNINGS ==========
function checkEndOfInnings(inn, callback) {
    if (_innings_ending) return;
    const m = currentMatch;
    const maxWickets = m.playersPerSide - 1;
    const maxBalls = m.overs * m.ballsPerOver;

    // Chase complete
    const isTest = m.matchFormat === 'test';
    if (!isTest && m.currentInnings === 1 && m.innings[0]) {
        const target = m.innings[0].runs + 1;
        if (inn.runs >= target) {
            _innings_ending = true;
            inn.isDone = true;
            finishInnings(inn, 'chase_won');
            return;
        }
    }
    if (isTest && m.currentInnings === 3) {
        const totalA = (m.innings[0]?.runs || 0) + (m.innings[2]?.runs || 0);
        const totalB = (m.innings[1]?.runs || 0) + (inn.runs || 0);
        if (totalB >= totalA + 1) {
            _innings_ending = true;
            inn.isDone = true;
            finishInnings(inn, 'chase_won');
            return;
        }
    }

    if (inn.wickets >= maxWickets || inn.balls >= maxBalls) {
        _innings_ending = true;
        inn.isDone = true;
        finishInnings(inn, 'all_out_or_overs');
    } else if (callback) {
        callback();
    }
}

function finishInnings(inn, reason) {
    const m = currentMatch;
    // Mark all not-dismissed batsmen as not out
    inn.batsmen.forEach(b => { if (!b.dismissal) b.notOut = true; });

    // Save final partnership
    if (!inn.partnerships) inn.partnerships = [];
    if (inn.currentPartnership && (inn.currentPartnership.runs > 0 || inn.currentPartnership.balls > 0)) {
        const batA = inn.batsmen[inn.currentBatsmenIdx[0]];
        const batB = inn.batsmen[inn.currentBatsmenIdx[1]];
        inn.partnerships.push({
            runs: inn.currentPartnership.runs,
            balls: inn.currentPartnership.balls,
            batsman1: batA ? batA.name : 'Unknown',
            batsman2: batB ? batB.name : 'Unknown',
            wicket: 'Not Out / Innings End'
        });
    }

    DB.saveMatch(m);

    const isTest = m.matchFormat === 'test';
    const maxInnings = m.totalInnings || (isTest ? 4 : 2);

    // Test match special: check for innings win at end of 3rd innings (m.currentInnings === 2)
    if (isTest && m.currentInnings === 2) {
        const teamA = m.battingFirst;
        const teamB = m.fieldingFirst;
        const scoreA = m.innings.filter((_, idx) => idx <= 2).filter(i => i && i.battingTeam === teamA).reduce((s, i) => s + (i.runs || 0), 0);
        const scoreB = m.innings.filter((_, idx) => idx <= 2).filter(i => i && i.battingTeam === teamB).reduce((s, i) => s + (i.runs || 0), 0);
        
        // If team who batted twice is still behind team who batted once
        const bfInns = m.innings.filter((_, idx) => idx <= 2 && m.innings[idx]?.battingTeam === teamA).length;
        const ffInns = m.innings.filter((_, idx) => idx <= 2 && m.innings[idx]?.battingTeam === teamB).length;

        if (bfInns === 2 && scoreA < scoreB) { // Team A batted 1st and 3rd
            showMatchResult();
            return;
        } else if (ffInns === 2 && scoreB < scoreA) { // Team B followed on
            showMatchResult();
            return;
        }
    }

    if (m.currentInnings < maxInnings - 1) {
        // Test match result check: if it's 4th innings and target reached
        if (isTest && m.currentInnings === 3) {
            showMatchResult();
        } else {
            showInningsEndModal(inn, reason);
        }
    } else {
        showMatchResult();
    }
}

function confirmEndInnings() {
    if (!confirm('Force-end this innings?')) return;
    const inn = currentMatch.innings[currentMatch.currentInnings];
    inn.isDone = true;
    _innings_ending = true;
    finishInnings(inn, 'declared');
}

function confirmEndMatch() {
    if (!confirm('Are you sure you want to officially end this match and record the result?')) return;
    const inn = currentMatch.innings[currentMatch.currentInnings];
    if (inn && !inn.isDone) {
        inn.isDone = true;
        _innings_ending = true;
        inn.batsmen.forEach(b => { if (!b.dismissal) b.notOut = true; });
    }
    DB.saveMatch(currentMatch);
    showMatchResult();
}

function showInningsEndModal(inn, reason) {
    const m = currentMatch;
    const isTest = m.matchFormat === 'test';
    let title = (m.currentInnings + 1) + (m.currentInnings === 0 ? 'st' : m.currentInnings === 1 ? 'nd' : m.currentInnings === 2 ? 'rd' : 'th') + ' Innings Complete!';
    if (reason === 'declared') title = '📢 Innings Declared!';
    
    document.getElementById('innings-end-title').textContent = title;

    let targetHtml = '';
    if (!isTest) {
        targetHtml = `<div style="margin-top:10px;font-size:14px">Target for ${inn.bowlingTeam}: <strong style="color:#00e676">${inn.runs + 1}</strong></div>`;
    } else {
        // Calculate lead/trail for test
        const totalA = (m.innings[0]?.runs || 0) + (m.innings[2]?.runs || 0);
        const totalB = (m.innings[1]?.runs || 0) + (m.innings[3]?.runs || 0);
        const diff = Math.abs(totalA - totalB);
        const leader = totalA > totalB ? m.battingFirst : m.fieldingFirst;
        targetHtml = `<div style="margin-top:10px;font-size:14px">${leader} leads by <strong style="color:#00e676">${diff}</strong> runs</div>`;
    }

    document.getElementById('innings-end-summary').innerHTML = `
    <div style="font-size:22px;font-weight:900;color:#ffc107;margin:8px 0">${inn.battingTeam}: ${inn.runs}/${inn.wickets}</div>
    <div style="color:var(--c-muted)">${formatOvers(inn.balls, m.ballsPerOver)} overs · CRR: ${formatCRR(inn.runs, inn.balls)}</div>
    ${targetHtml}`;
    openModal('modal-innings-end');
}

function proceedAfterInnings() {
    const m = currentMatch;
    const inn = m.innings[m.currentInnings];
    closeModal('modal-innings-end');
    
    const isTest = m.matchFormat === 'test';
    const maxInns = m.totalInnings || (isTest ? 4 : 2);
    
    // Innings Limit (Max Overs per innings for Test)
    if (isTest && m.maxInningsOvers && formatOvers(inn.balls, m.ballsPerOver) >= m.maxInningsOvers) {
        finishInnings(inn, 'overs_limit');
        return;
    }

    if (m.currentInnings >= maxInns - 1) {
        showMatchResult();
    } else {
        const nextInningsIdx = m.currentInnings + 1;
        
        // Test Match 3rd Innings Choice (Standard vs Follow-On)
        if (isTest && maxInns === 4 && m.currentInnings === 1) {
            const inn0 = m.innings[0];
            const inn1 = m.innings[1];
            const lead = inn0.runs - inn1.runs;
            
            // Setup Test Modal
            document.getElementById('test-btn-followon').style.display = (lead >= 100) ? 'block' : 'none';
            document.getElementById('test-innings-hint').textContent = `${inn0.battingTeam} leads by ${lead} runs.`;
            openModal('modal-test-innings-select');
            return;
        }

        // Standard rotation
        const prevInn = m.innings[m.currentInnings];
        m.innings[nextInningsIdx] = DB.createInnings(prevInn.bowlingTeam, prevInn.battingTeam);
        m.currentInnings = nextInningsIdx;
        saveAndRender();
        showToast(`Innings ${nextInningsIdx + 1} Started!`, 'success');
        setTimeout(() => openOpenBatsmenModal(), 300);
    }
}

// ========== TOSS HELPERS ==========
let _selectedTossWinner = null;
let _selectedTossDecision = null;

window.selectTossWinner = function(side) {
    _selectedTossWinner = side;
    document.querySelectorAll('.toss-team-btn').forEach(b => b.classList.remove('btn-primary', 'active'));
    document.getElementById(side === 'team1' ? 'toss-winner-t1' : 'toss-winner-t2').classList.add('btn-primary', 'active');
};

window.selectTossDecision = function(dec) {
    _selectedTossDecision = dec;
    document.querySelectorAll('.toss-dec-btn').forEach(b => b.classList.remove('btn-primary', 'active'));
    document.getElementById(dec === 'bat' ? 'toss-dec-bat' : 'toss-dec-bowl').classList.add('btn-primary', 'active');
};

window.finalizeTossAndStartLive = function() {
    if (!_selectedTossWinner || !_selectedTossDecision) {
        showToast('Please select both Toss Winner and Decision!', 'error');
        return;
    }
    const m = currentMatch;
    const t1 = m.team1;
    const t2 = m.team2;
    
    const tossWinnerName = _selectedTossWinner === 'team1' ? t1 : t2;
    const dec = _selectedTossDecision;
    const battingFirst = dec === 'bat' ? tossWinnerName : (tossWinnerName === t1 ? t2 : t1);
    const fieldingFirst = battingFirst === t1 ? t2 : t1;

    m.status = 'live';
    m.isScheduledTemplate = false;
    m.tossWinner = tossWinnerName;
    m.tossDecision = dec;
    m.battingFirst = battingFirst;
    m.fieldingFirst = fieldingFirst;
    
    // Test match or Limited Overs
    const limit = m.matchFormat === 'test' ? 4 : 2;
    m.totalInnings = limit;
    m.innings = new Array(limit).fill(null);
    m.innings[0] = DB.createInnings(battingFirst, fieldingFirst);
    m.currentInnings = 0;

    DB.saveMatch(m);
    closeModal('modal-toss-result');
    loadMatch(m);
    showToast('Match Started! Setting up openers...', 'success');
};

// ========== TEST INNINGS HELPERS ==========
window.finalizeTestInningsSelection = function(isFollowOn) {
    const m = currentMatch;
    const nextIdx = 2; // Index 2 is the 3rd innings
    const inn0 = m.innings[0];
    const inn1 = m.innings[1];

    if (!inn0 || !inn1) return showToast('Critical Error: Innings data missing', 'error');

    if (isFollowOn) {
        // Team B bats AGAIN (Follow-on)
        m.innings[nextIdx] = DB.createInnings(inn1.battingTeam, inn1.bowlingTeam);
        showToast(`🔥 ${inn1.battingTeam} is FOLLOWING ON!`, 'default');
    } else {
        // Standard: Team A bats 2nd time
        m.innings[nextIdx] = DB.createInnings(inn0.battingTeam, inn0.bowlingTeam);
        showToast(`🏏 2nd Innings for ${inn0.battingTeam} started.`, 'default');
    }

    m.currentInnings = nextIdx;
    DB.saveMatch(m);
    closeModal('modal-test-innings-select');
    
    // Crucial: Render then open modal with a slightly longer delay to avoid UI conflict
    saveAndRender();
    setTimeout(() => {
        openOpenBatsmenModal();
    }, 600);
};

// ========== MATCH RESULT ==========
function showMatchResult() {
    const m = currentMatch;
    const isTest = m.matchFormat === 'test';
    const inn0 = m.innings[0];
    const inn1 = m.innings[1];
    
    m.status = 'completed';
    let winner, resultText;
    
    if (isTest) {
        const teamA = m.battingFirst;
        const teamB = m.fieldingFirst;
        const scoreA = m.innings.filter(i => i && i.battingTeam === teamA).reduce((s, i) => s + (i.runs || 0), 0);
        const scoreB = m.innings.filter(i => i && i.battingTeam === teamB).reduce((s, i) => s + (i.runs || 0), 0);
        
        // Check if all 4 innings are done or match ended early
        const lastInn = m.innings[m.currentInnings];
        const targetReached = (m.currentInnings === 3 && lastInn && scoreB > scoreA); // This assumes standard target chase in 4th

        // Special case: Innings Win (Match ended before or during 3rd innings completion)
        if (m.currentInnings < 3) {
            if (scoreA > scoreB) {
                winner = teamA;
                const diff = scoreA - scoreB;
                resultText = `${winner} won by an innings and ${diff} run${diff !== 1 ? 's' : ''}`;
            } else if (scoreB > scoreA) {
                winner = teamB;
                const diff = scoreB - scoreA;
                resultText = `${winner} won by an innings and ${diff} run${diff !== 1 ? 's' : ''}`;
            } else {
                winner = null;
                resultText = "Match Drawn!";
            }
        } else {
            // 4th Innings Result
            if (scoreB > scoreA) {
                winner = teamB;
                const wkLeft = (m.playersPerSide - 1) - m.innings[3].wickets;
                resultText = `${winner} won by ${wkLeft} wicket${wkLeft !== 1 ? 's' : ''}`;
            } else if (scoreA > scoreB) {
                winner = teamA;
                const diff = scoreA - scoreB;
                resultText = `${winner} won by ${diff} run${diff !== 1 ? 's' : ''}`;
            } else {
                winner = null;
                resultText = 'Match Tied!';
            }
        }
    } else {
        const inn0 = m.innings[0];
        const inn1 = m.innings[1];
        if (m.currentInnings === 1 && inn1 && inn1.runs >= inn0.runs + 1) {
            winner = inn1.battingTeam;
            const wicketsLeft = (m.playersPerSide - 1) - inn1.wickets;
            resultText = `${winner} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? 's' : ''}`;
        } else if (!inn1 || inn1.runs < inn0.runs + 1) {
            winner = inn0.battingTeam;
            const diff = inn0.runs - (inn1 ? inn1.runs : 0);
            resultText = `${winner} won by ${diff} run${diff !== 1 ? 's' : ''}`;
        } else {
            winner = null;
            resultText = 'Match Tied!';
        }
    }

    m.result = resultText;
    m.winner = winner || null;
    m.completedAt = Date.now();

    // Keep tournament rosters on disk after match ends (permanent squad names)

    // Clear session-specific tokens and hotkey state
    DB.clearMatchData(m.id);
    DB.saveMatch(m);

    // Update tournament
    if (m.tournamentId) {
        const t = DB.getTournament(m.tournamentId);
        if (t) {
            if (t.format === 'knockout') {
                // Promote winner to next match if applicable
                if (m.knockout && m.knockout.nextMatchId && winner) {
                    const nextMatch = DB.getMatch(m.knockout.nextMatchId);
                    if (nextMatch) {
                        if (m.knockout.slot === 1) nextMatch.team1 = winner;
                        else if (m.knockout.slot === 2) nextMatch.team2 = winner;
                        DB.saveMatch(nextMatch);
                    }
                }
            } else if (typeof window.computeTournamentStandings === 'function') {
                window.computeTournamentStandings(t);
            } else {
                computeStandings(t);
            }
            DB.saveTournament(t);
            
            // ALWAYS update global team & player stats to ensure rankings are instant
            syncOfficialStats(m, t);
        }
    }

    document.getElementById('result-winner').textContent = winner ? `${winner}` : 'Tie!';
    document.getElementById('result-summary').textContent = resultText;

    // Player of Match (Aggregated from all innings)
    let allBatsmen = [];
    m.innings.forEach(inn => {
        if (inn && inn.batsmen) allBatsmen.push(...inn.batsmen);
    });
    
    const sortedBats = [...allBatsmen].sort((a, b) => (b.runs || 0) - (a.runs || 0));
    const mom = sortedBats[0];
    if (mom) {
        document.getElementById('result-mom').innerHTML = `
      <div style="font-size:11px;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.08em;mb:6px">Player of the Match</div>
      <div style="font-size:18px;font-weight:800">${mom.name}</div>
      <div style="font-size:13px;color:var(--c-muted)">${mom.runs || 0} runs off ${mom.balls || 0} balls · SR ${formatSR(mom.runs || 0, mom.balls || 0)}</div>`;
    }
    const mrHomeBtn = document.querySelector('#modal-result .btn-primary');
    const mrBackBtn = document.querySelector('#modal-result .btn-ghost');
    if (mrHomeBtn && mrBackBtn) {
        if (m.tournamentId) {
            // Give clear option to exit the score tab entirely
            mrHomeBtn.innerHTML = '🏠 Exit Scorecard';
            mrHomeBtn.onclick = () => { 
                location.href = '../pages/ongoing-matches.html'; 
            };
            mrBackBtn.innerHTML = '📅 Tournament Hub';
            mrBackBtn.onclick = () => { 
                closeModal('modal-result'); 
                openTournamentHub(m.tournamentId); 
            };
        } else {
            mrHomeBtn.innerHTML = '🏠 Back to Home';
            mrHomeBtn.onclick = () => { location.href = '../index.html'; };
            mrBackBtn.innerHTML = '🔄 Score New Match';
            mrBackBtn.onclick = () => { closeModal('modal-result'); showScreen('setup'); };
        }
    }

    // Auto-broadcast summary or scorecard on match complete
    if (m.tournamentId) {
        sendBroadcast('SHOW_SUMMARY');
    } else {
        sendBroadcast('SHOW_SCORECARD');
    }

    // Check if tournament is fully complete – show End Tournament button prominentally
    if (m.tournamentId) {
        const t = DB.getTournament(m.tournamentId);
        if (t) {
            const allMatches = (t.matches || []).map(id => DB.getMatch(id)).filter(Boolean);
            const allDone = allMatches.every(mx => mx.status === 'completed' || mx.id === m.id);
            if (allDone && t.status !== 'completed') {
                // All matches done – prompt End Tournament with a delay for visual comfort
                setTimeout(() => {
                    const confirmEnd = confirm(`🏆 ALL MATCHES IN "${t.name}" ARE COMPLETED!\n\nWould you like to END the Tournament and finalize the results now?`);
                    if (confirmEnd) {
                        endTournamentManually(m.tournamentId);
                    }
                }, 1200);

                if (mrHomeBtn) {
                    mrHomeBtn.innerHTML = '🏆 FINISH TOURNAMENT';
                    mrHomeBtn.classList.remove('btn-primary');
                    mrHomeBtn.style.background = '#ffc107';
                    mrHomeBtn.style.color = '#000';
                    mrHomeBtn.style.fontWeight = '900';
                    mrHomeBtn.style.boxShadow = '0 0 25px rgba(255,193,7,0.4)';
                    mrHomeBtn.style.border = 'none';
                    mrHomeBtn.onclick = () => {
                         closeModal('modal-result');
                         endTournamentManually(m.tournamentId);
                    };
                }
                if (mrBackBtn) {
                    mrBackBtn.innerHTML = '🏠 Exit Scorecard';
                    mrBackBtn.onclick = () => { location.href = '../pages/ongoing-matches.html'; };
                }
            }
        }
    }
    
    // ─── NEW: High-Detail Report Archival ───────────────────
    if (typeof archiveMatchReport === 'function') {
        console.log('📄 Archiving high-detail match report...');
        archiveMatchReport(m);
    }
    // ────────────────────────────────────────────────────────

    openModal('modal-result');
}

/**
 * Capture a snapshot of the current match for historical reporting.
 */
function archiveMatchReport(m) {
    if (!m) return;
    try {
        const report = {
            id: 'RE-SNAP-' + Date.now(),
            matchId: m.id,
            matchData: JSON.parse(JSON.stringify(m)), // Full snapshot
            generatedAt: Date.now(),
            status: m.status
        };
        DB.saveMatchReport(report);
        
        // Show subtle notification
        console.log('✅ Match report snapshot archived to DB.');
    } catch (e) {
        console.error('Failed to archive match report snapshot:', e);
    }
}

function openTournamentSummary() {
    const m = currentMatch;
    if (!m || !m.tournamentId) return;
    const t = DB.getTournament(m.tournamentId);
    if (!t) return;
    
    computeStandings(t);
    
    // Render points table
    const ptsBody = document.getElementById('ts-points-body');
    if (ptsBody && t.standings) {
        const sortedTeams = Object.entries(t.standings).map(([team, s]) => ({ team, ...s }))
            .sort((a, b) => b.points - a.points || b.nrr - a.nrr);
            
        ptsBody.innerHTML = sortedTeams.map(s => `<tr>
            <td><strong>${s.team}</strong></td>
            <td>${s.played}</td><td>${s.won}</td><td>${s.lost}</td><td>${s.tied}</td>
            <td><strong>${s.points}</strong></td><td>${(s.nrr || 0).toFixed(3)}</td>
        </tr>`).join('');
    }
    
    // Render top players
    const tMatches = DB.getMatches().filter(match => match.tournamentId === t.id && match.status === 'completed');
    const batStats = {};
    const bowlStats = {};
    
    tMatches.forEach(match => {
        [0, 1].forEach(innIdx => {
            const inn = match.innings[innIdx];
            if(!inn) return;
            
            inn.batsmen.forEach(b => {
                if(!b.name || Number.isNaN(b.runs)) return;
                if(!batStats[b.name]) batStats[b.name] = { matches: 0, runs: 0, balls: 0, hs: 0 };
                batStats[b.name].matches++;
                batStats[b.name].runs += (b.runs || 0);
                batStats[b.name].balls += (b.balls || 0);
                batStats[b.name].hs = Math.max(batStats[b.name].hs, b.runs || 0);
            });
            
            inn.bowlers.forEach(b => {
                if(!b.name) return;
                if(!bowlStats[b.name]) bowlStats[b.name] = { matches: 0, wickets: 0, runs: 0, balls: 0 };
                bowlStats[b.name].matches++;
                bowlStats[b.name].wickets += (b.wickets || 0);
                bowlStats[b.name].runs += (b.runs || 0);
                bowlStats[b.name].balls += (b.balls || 0);
            });
        });
    });
    
    const topBat = Object.entries(batStats).map(([name, s]) => ({ name, ...s }))
        .sort((a,b) => b.runs - a.runs).slice(0, 10);
        
    const topBowl = Object.entries(bowlStats).map(([name, s]) => ({ name, ...s }))
        .sort((a,b) => b.wickets - a.wickets || a.runs - b.runs).slice(0, 10);
        
    const batBody = document.getElementById('ts-batting-body');
    if (batBody) {
        batBody.innerHTML = topBat.map(s => `<tr>
            <td><strong>${s.name}</strong></td>
            <td>${s.matches}</td><td><strong>${s.runs}</strong></td><td>${s.hs}</td>
            <td>${s.balls > 0 ? ((s.runs / s.balls) * 100).toFixed(1) : '0.0'}</td>
        </tr>`).join('');
    }
    
    const bowlBody = document.getElementById('ts-bowling-body');
    if (bowlBody) {
        bowlBody.innerHTML = topBowl.map(s => `<tr>
            <td><strong>${s.name}</strong></td>
            <td>${s.matches}</td><td><strong>${s.wickets}</strong></td>
            <td>${s.balls > 0 ? (s.runs / (s.balls / 6)).toFixed(2) : '0.00'}</td>
        </tr>`).join('');
    }
    
    const tsTitle = document.getElementById('ts-title');
    if (tsTitle) tsTitle.textContent = `🏆 ${t.name || 'Tournament'} — Summary`;
    showScreen('tournament-summary');
}

async function downloadTournamentSummaryPDF() {
    const tid = currentMatch?.tournamentId;
    if (!tid) {
        showToast('No tournament linked to this match', 'error');
        return;
    }
    if (typeof MatchReportEngine !== 'undefined' && MatchReportEngine.generateTournamentPDF) {
        await MatchReportEngine.generateTournamentPDF(tid);
        return;
    }
    if (typeof generateTournamentPDF === 'function') {
        await generateTournamentPDF(tid);
        return;
    }
    showToast('PDF report engine not loaded — refresh the page', 'error');
}
window.downloadTournamentSummaryPDF = downloadTournamentSummaryPDF;

function computeStandings(t) {
    t.teams.forEach(team => {
        if (!t.standings[team]) t.standings[team] = {};
        Object.assign(t.standings[team], { played: 0, won: 0, lost: 0, tied: 0, points: 0, runsScored: 0, ballsFaced: 0, runsConceded: 0, ballsBowled: 0, nrr: 0 });
    });
    const matches = DB.getMatches().filter(m => m.tournamentId === t.id && m.status === 'completed');
    matches.forEach(m => {
        const i0 = m.innings[0]; const i1 = m.innings[1];
        if (!i0 || !i1) return;
        
        const battingFirst = m.battingFirst || m.team1;
        const fieldingFirst = m.fieldingFirst || m.team2;

        const s1 = t.standings[battingFirst] || {}; 
        const s2 = t.standings[fieldingFirst] || {};
        if (!s1.played && s1.played !== 0) return; // Team not in tournament list

        const bpo = m.ballsPerOver || 6;
        const maxBalls = m.overs * bpo;
        const pps = m.playersPerSide || 11;

        s1.played++; s2.played++;

        // All Out counts as full overs
        const b0 = (i0.wickets >= pps - 1) ? maxBalls : i0.balls;
        const b1 = (i1.wickets >= pps - 1) ? maxBalls : i1.balls;

        s1.runsScored += i0.runs; s1.ballsFaced += b0; s1.runsConceded += i1.runs; s1.ballsBowled += b1;
        s2.runsScored += i1.runs; s2.ballsFaced += b1; s2.runsConceded += i0.runs; s2.ballsBowled += b0;

        if (i1.runs > i0.runs) { s2.won++; s2.points += 2; s1.lost++; }
        else if (i1.runs < i0.runs) { s1.won++; s1.points += 2; s2.lost++; }
        else { s1.tied++; s2.tied++; s1.points++; s2.points++; }
    });
    t.teams.forEach(team => {
        const s = t.standings[team];
        const bpo = t.ballsPerOver || 6;
        const rr = s.ballsFaced ? (s.runsScored / (s.ballsFaced / bpo)) : 0;
        const ra = s.ballsBowled ? (s.runsConceded / (s.ballsBowled / bpo)) : 0;
        s.nrr = parseFloat((rr - ra).toFixed(3)) || 0;
    });
}

// ========== PUBLISH ==========
function togglePublish(checked) {
    if (!currentMatch) return;
    currentMatch.publishLive = checked;
    DB.saveMatch(currentMatch);
    if (checked && currentMatch.tournamentId && !isTournamentAuthorized(currentMatch.tournamentId)) {
        showToast('Unlock this tournament first to publish securely.', 'error');
        currentMatch.publishLive = false;
        DB.saveMatch(currentMatch);
        return;
    }
    showToast(checked ? 'Score published live!' : 'Live score hidden', 'success');
    updateHeaderActions();
}

// ========== UNDO / REDO ==========
function pushHistory() {
    const m = currentMatch;
    const snapshot = JSON.stringify({ innings: m.innings, currentInnings: m.currentInnings });
    m.history = m.history || [];
    m.history.push(snapshot);
    m.redoStack = [];
    if (m.history.length > 150) m.history.shift();
}

async function undoAction() {
    if (isPopupScoreSurface()) {
        await forwardPopupScoringCommand('undoAction');
        return;
    }
    const m = currentMatch;
    if (!m || !m.history || !m.history.length) { showToast('Nothing to undo', 'error'); return; }
    const current = JSON.stringify({ innings: m.innings, currentInnings: m.currentInnings });
    m.redoStack = m.redoStack || [];
    m.redoStack.push(current);
    const prev = JSON.parse(m.history.pop());
    m.innings = prev.innings;
    m.currentInnings = prev.currentInnings;
    _innings_ending = false;
    saveAndRender();
    showToast('↩ Undone!', 'success');
}

async function redoAction() {
    if (isPopupScoreSurface()) {
        await forwardPopupScoringCommand('redoAction');
        return;
    }
    const m = currentMatch;
    if (!m || !m.redoStack || !m.redoStack.length) { showToast('Nothing to redo', 'error'); return; }
    const current = JSON.stringify({ innings: m.innings, currentInnings: m.currentInnings });
    m.history = m.history || [];
    m.history.push(current);
    const next = JSON.parse(m.redoStack.pop());
    m.innings = next.innings;
    m.currentInnings = next.currentInnings;
    _innings_ending = false;
    saveAndRender();
    showToast('↪ Redone!', 'success');
}

// ========== SCORECARD MODAL ==========
function openScorecard() {
    const m = currentMatch;
    if (!m) return;
    let html = '';
    m.innings.forEach((inn, i) => {
        if (!inn) return;
        const ex = inn.extras || {};
        const totalEx = (ex.wides || 0) + (ex.noBalls || 0) + (ex.byes || 0) + (ex.legByes || 0);
        html += `<div style="margin-bottom:22px">
      <div style="font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-muted);margin-bottom:10px;font-size:12px">
        ${i === 0 ? '1st' : '2nd'} Innings – ${inn.battingTeam}
        <span style="color:#fff;margin-left:8px;font-size:18px">${inn.runs}/${inn.wickets} (${formatOvers(inn.balls, m.ballsPerOver)} ov)</span>
      </div>
      <table class="data-table" style="margin-bottom:8px">
        <thead><tr><th>Batsman</th><th>How Out</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
        <tbody>
          ${(inn.batsmen || []).map(b => `<tr>
            <td><strong>${b.name}</strong></td>
            <td style="font-size:12px;color:var(--c-muted)">${b.dismissal || (b.notOut ? 'not out' : 'did not bat')}</td>
            <td><strong>${b.runs || 0}</strong></td><td>${b.balls || 0}</td>
            <td>${b.fours || 0}</td><td>${b.sixes || 0}</td>
            <td>${formatSR(b.runs || 0, b.balls || 0)}</td>
          </tr>`).join('')}
          <tr style="border-top:1px solid var(--c-border)">
            <td colspan="2" style="color:var(--c-muted)">Extras (${totalEx})</td>
            <td colspan="5" style="font-size:12px;color:var(--c-muted)">
              Wd:${ex.wides || 0} Nb:${ex.noBalls || 0} By:${ex.byes || 0} Lb:${ex.legByes || 0}
            </td>
          </tr>
        </tbody>
      </table>
      <table class="data-table">
        <thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead>
        <tbody>
          ${(inn.bowlers || []).map(b => `<tr>
            <td><strong>${b.name}</strong></td>
            <td>${formatOvers(b.balls || 0, m.ballsPerOver)}</td><td>${b.maidens || 0}</td>
            <td>${b.runs || 0}</td><td><strong>${b.wickets || 0}</strong></td>
            <td>${formatEcon(b.runs || 0, b.balls || 0, m.ballsPerOver)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${inn.fallOfWickets && inn.fallOfWickets.length ? `
      <div style="margin-top:10px;font-size:12px">
        <span style="color:var(--c-muted);font-weight:700">FOW: </span>
        ${inn.fallOfWickets.map((fw, j) => `${j + 1}-${fw.runs} (${fw.batsmanName}, ${formatOvers(fw.balls, m.ballsPerOver)} ov)`).join(', ')}
      </div>`: ''}
    </div>`;
    });
    document.getElementById('scorecard-content').innerHTML = html;
    openModal('modal-scorecard');
}

// ========== PAUSE / SAVE ==========
function pauseAndExit(noConfirm) {
    if (!currentMatch) { location.href = '../index.html'; return; }
    currentMatch.status = 'paused';
    DB.saveMatch(currentMatch);
    showToast('⏸ Match saved! Resume anytime.', 'success');
    setTimeout(() => {
        if (currentMatch.tournamentId) {
            openTournamentHub(currentMatch.tournamentId);
        } else {
            location.href = '../index.html';
        }
    }, 1200);
}

window.declareInnings = function() {
    if (!confirm('Are you sure you want to DECLARE this innings?')) return;
    const inn = currentMatch.innings[currentMatch.currentInnings];
    inn.isDone = true;
    _innings_ending = true;
    finishInnings(inn, 'declared');
}

// ========== HELPERS ==========
// BroadcastChannel for instant same-browser cross-tab TV display updates
const _scorerBC = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('cricpro_live') : null;
let _overlaySignalTimer = null;

function flushOverlaySignal() {
    _overlaySignalTimer = null;
    if (!currentMatch) return;
    if (typeof enrichMatchBroadcastMedia === 'function') enrichMatchBroadcastMedia(currentMatch);
    if (window.desktopAPI) {
        window.desktopAPI.publishMatch(currentMatch);
        window.desktopAPI.broadcastCommand({
            cmd: 'SYNC_SCORE',
            data: { match: currentMatch, matchId: currentMatch.id },
            matchId: currentMatch.id,
            tournamentId: currentMatch.tournamentId || null,
            timestamp: Date.now(),
        });
        return;
    }
    if (_scorerBC) {
        _scorerBC.postMessage({ type: 'score_update', matchId: currentMatch.id, ts: Date.now() });
    }
    localStorage.setItem('cricpro_force_update', Date.now().toString());
}

function scheduleOverlaySignal() {
    if (_overlaySignalTimer) clearTimeout(_overlaySignalTimer);
    _overlaySignalTimer = setTimeout(flushOverlaySignal, 12);
}

function saveAndRender() {
    if (currentMatch) {
        window.currentMatch = currentMatch;
        window.currentTournament = currentTournament;
        const isDesktop = !!window.desktopAPI;
        DB.saveMatch(currentMatch, true, {
            skipPublish: isDesktop,
            skipForceUpdate: isDesktop,
        });
        renderScoring();
        if (typeof syncBroadcastMasterPhotos === 'function') {
            syncBroadcastMasterPhotos(currentMatch);
        }
        scheduleOverlaySignal();
        if (isDesktop) {
            scheduleCloudFlush(true);
            if (!isPopupScoreSurface()) runPendingScoringUi();
        }
        const t1el = document.getElementById('hk-team1-name');
        const t2el = document.getElementById('hk-team2-name');
        if (t1el) t1el.textContent = currentMatch.team1 || 'Team A';
        if (t2el) t2el.textContent = currentMatch.team2 || 'Team B';
    }
}
function openModal(id) { const e = document.getElementById(id); if (e) e.style.display = 'flex'; }
function closeModal(id) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

async function printScorecard() {
    if (typeof MatchReportEngine !== 'undefined' && MatchReportEngine.generatePDF) {
        await MatchReportEngine.generatePDF(currentMatch.id);
    } else {
        alert('Report Engine not loaded. Please refresh or check scripts.');
    }
}

// ========== NEW OPEN BATSMEN ==========
function openOpenBatsmenModal() {
    document.getElementById('open-bat1-name').value = '';
    document.getElementById('open-bat2-name').value = '';
    populateSquadDatalist('batting');
    renderSquadQuickPick('squad-open-bat-opts', 'batting', { openBatsmen: true });
    openModal('modal-open-batsmen');
}

function lookupPlayerOpen(num) {
    const name = document.getElementById(`open-bat${num}-name`)?.value.trim();
    const player = name ? findPlayerInTeamRoster(name, getInningsTeamForSide('batting')) : null;
    if (player) {
        document.getElementById(`open-bat${num}-name`).value = player.name;
        showToast(`✅ Found: ${player.name}`, 'success');
    }
}

function confirmOpenBatsmen() {
    const n1 = document.getElementById('open-bat1-name').value.trim();
    let pid1 = null;
    const n2 = document.getElementById('open-bat2-name').value.trim();
    let pid2 = null;

    if (!n1 || !n2) { showToast('❌ Enter both opening batsmen names', 'error'); return; }

    const r1 = ensurePlayerOnTeamRoster(n1, 'batting');
    const r2 = ensurePlayerOnTeamRoster(n2, 'batting');
    if (!pid1) pid1 = r1 || resolvePlayerIdForInnings(n1, 'batting');
    if (!pid2) pid2 = r2 || resolvePlayerIdForInnings(n2, 'batting');
    if (!pid1) {
        const pMatch1 = DB.getPlayers().find(p => p.name.toLowerCase() === n1.toLowerCase());
        if (pMatch1) pid1 = pMatch1.playerId;
    }
    if (!pid2) {
        const pMatch2 = DB.getPlayers().find(p => p.name.toLowerCase() === n2.toLowerCase());
        if (pMatch2) pid2 = pMatch2.playerId;
    }

    const m = currentMatch;
    const inn = m.innings[m.currentInnings];

    inn.batsmen.push({ name: n1, playerId: pid1, runs: 0, balls: 0, fours: 0, sixes: 0, notOut: true, dismissal: null });
    inn.batsmen.push({ name: n2, playerId: pid2, runs: 0, balls: 0, fours: 0, sixes: 0, notOut: true, dismissal: null });

    inn.currentBatsmenIdx[0] = 0;
    inn.currentBatsmenIdx[1] = 1;
    // Striker is bat1 (at index 0)
    inn.strikerIdx = 0;

    closeModal('modal-open-batsmen');
    
    // Set initial striker and initial partnership
    inn.strikerIdx = 0;
    inn.currentPartnership = { runs: 0, balls: 0 };
    
    saveAndRender();
    setTimeout(() => openNewBowlerModal(), 200);
}

// ========== STATS SYNC (TEAM & PLAYER) ==========
// Always update cumulative statistics so rankings are always live
function syncOfficialStats(m, t) {
    if (!m.innings[0]) return;

    [0, 1].forEach(innIdx => {
        const inn = m.innings[innIdx];
        if (!inn) return;

        inn.batsmen.forEach(b => {
            if (!b.playerId) return;
            const existing = DB.getPlayerById(b.playerId);
            if (!existing) return;

            const s = existing.stats || {};
            const runs = b.runs || 0;
            const stats = {
                innings:  (s.innings  || 0) + 1,
                runs:     (s.runs     || 0) + runs,
                balls:    (s.balls    || 0) + (b.balls || 0),
                fours:    (s.fours    || 0) + (b.fours || 0),
                sixes:    (s.sixes    || 0) + (b.sixes || 0),
                notOuts:  (s.notOuts  || 0) + (b.notOut ? 1 : 0),
                highScore: Math.max((s.highScore || 0), runs),
            };
            if (runs >= 100) stats.hundreds = (existing.stats.hundreds || 0) + 1;
            else if (runs >= 50) stats.fifties = (existing.stats.fifties || 0) + 1;
            else if (runs >= 30) stats.thirties = (existing.stats.thirties || 0) + 1;

            existing.stats = { ...existing.stats, ...stats };
            DB.updatePlayerStats(b.playerId, existing.stats);
        });

        inn.bowlers.forEach(b => {
            if (!b.playerId) return;
            const p = DB.getPlayerById(b.playerId);
            if (!p) return;

            const s = p.stats || {};
            const wkt = b.wickets || 0;
            const bestParts = (s.bestBowling || '0/0').split('/');
            const bestW = parseInt(bestParts[0]) || 0;
            const bestR = parseInt(bestParts[1]) || 999;
            let newBest = s.bestBowling || '0/0';
            if (wkt > bestW || (wkt === bestW && (b.runs || 0) < bestR)) {
                newBest = `${wkt}/${b.runs || 0}`;
            }
            const stats = {
                wickets:      (s.wickets     || 0) + wkt,
                bowlingRuns:  (s.bowlingRuns || 0) + (b.runs || 0),
                overs:        (s.overs       || 0) + ((b.balls || 0) / (m.ballsPerOver || 6)),
                maidens:      (s.maidens     || 0) + (b.maidens || 0),
                bestBowling:  newBest,
            };
            p.stats = { ...p.stats, ...stats };
            DB.updatePlayerStats(b.playerId, p.stats);
        });
    });

    // Increment match count for all players in this match (once per match)
    const allPids = new Set();
    [0, 1].forEach(innIdx => {
        const inn = m.innings[innIdx];
        if (!inn) return;
        [...(inn.batsmen || []), ...(inn.bowlers || [])].forEach(b => {
            if (b.playerId) allPids.add(b.playerId);
        });
    });
    allPids.forEach(pid => {
        const p = DB.getPlayerById(pid);
        if (p) {
            p.stats.matches = (p.stats.matches || 0) + 1;
            DB.updatePlayerStats(pid, p.stats);
        }
    });

    // Update Team Stats (Played/Won/NRR Components)
    const teamsList = [m.battingFirst, m.fieldingFirst];
    teamsList.forEach((tName, i) => {
        const team = DB.getTeams().find(t => t.name === tName);
        if (team) {
            const s = team.stats || { played: 0, won: 0, lost: 0, tied: 0, runsScored: 0, ballsFaced: 0, runsConceded: 0, ballsBowled: 0, prizeMoney: 0 };
            s.played++;
            
            const i0 = m.innings[0], i1 = m.innings[1];
            if (i0 && i1) {
                const isBatFirst = (m.battingFirst === tName);
                const myInn = isBatFirst ? i0 : i1;
                const oppInn = isBatFirst ? i1 : i0;
                
                // Wins/Loss/Tie
                if (myInn.runs > oppInn.runs) s.won++;
                else if (myInn.runs < oppInn.runs) s.lost++;
                else s.tied++;

                // NRR Components
                // In cricket, if a team is all out, they are considered to have faced their full quota of overs for NRR purposes.
                let myBalls = myInn.balls;
                if (myInn.wickets >= m.playersPerSide - 1) myBalls = m.overs * m.ballsPerOver;
                
                let oppBalls = oppInn.balls;
                if (oppInn.wickets >= m.playersPerSide - 1) oppBalls = m.overs * m.ballsPerOver;

                s.runsScored += myInn.runs;
                s.ballsFaced += myBalls;
                s.runsConceded += oppInn.runs;
                s.ballsBowled += oppBalls;
            }
            DB.updateTeamStats(tName, s);
        }
    });

    // Check if this is the last match of the tournament — if so, push tournament summary
    if (!t) return;
    const allMatches = DB.getMatches().filter(mx => mx.tournamentId === t.id);
    const allDone = allMatches.every(mx => mx.status === 'completed' || mx.id === m.id);
    if (allDone && t.isOfficial) {
        // mark tournament complete
        t.status = 'completed';
        
        // Distribution of Prizes
        if (t.standings) {
            const sorted = Object.values(t.standings).sort((a,b) => b.points - a.points || b.nrr - a.nrr);
            const prizeMap = { first: 0, second: 1, third: 2 };
            ['first', 'second', 'third'].forEach(rank => {
                if (sorted[prizeMap[rank]] && t.prizes && t.prizes[rank]) {
                    const val = parseFloat((t.prizes[rank] + '').replace(/[^\d.-]/g, '')) || 0;
                    const teamName = sorted[prizeMap[rank]].name;
                    const teamObj = DB.getTeams().find(tm => tm.name === teamName);
                    if (teamObj) {
                        const s = teamObj.stats || { played: 0, won: 0, lost: 0, tied: 0, prizeMoney: 0 };
                        s.prizeMoney = (s.prizeMoney || 0) + val;
                        DB.updateTeamStats(teamName, s);
                    }
                }
            });
        }

        DB.saveTournament(t);
        // Push all player stats + team stats to MongoDB
        if (typeof pushAllStatsAfterTournament === 'function') {
            pushAllStatsAfterTournament(t.id);
        }
    }
}

// ========== ROSTER & OVERLAYS ==========
function getActiveRosterRoot() {
    if (currentMatch?.tournamentId) {
        const t = DB.getTournament(currentMatch.tournamentId);
        if (t) return t;
    }
    return currentTournament && !currentTournament.isMock ? currentTournament : currentMatch;
}

function saveActiveRosterRoot(rootObj, quiet = false) {
    if (rootObj.id && rootObj.id.startsWith('MATCH-')) {
        DB.saveMatch(rootObj, true, { skipPublish: quiet, skipForceUpdate: quiet });
    } else {
        DB.saveTournament(rootObj, true, { skipPublish: quiet, skipForceUpdate: quiet });
    }
}

/** Roster slots for a team (player ids, legacy names, or empty strings). */
function getTeamRosterSlots(teamName, teamIdx) {
    const root = getActiveRosterRoot();
    const m = currentMatch;
    if (root?.rosters?.[teamName] && Array.isArray(root.rosters[teamName])) {
        return [...root.rosters[teamName]];
    }
    if (m?.rosters && teamIdx != null && Array.isArray(m.rosters[teamIdx])) {
        return m.rosters[teamIdx].map((entry) => {
            if (!entry) return '';
            if (typeof entry === 'string') return entry;
            return entry.id || entry.playerId || entry.name || '';
        });
    }
    return [];
}

function setTeamRosterIds(teamName, teamIdx, rosterIds, quiet = false) {
    const root = getActiveRosterRoot();
    const m = currentMatch;
    if (!root || !teamName) return;
    if (!root.rosters) root.rosters = {};
    root.rosters[teamName] = rosterIds;
    if (m && teamIdx != null) {
        m.rosters = m.rosters || {};
        m.rosters[teamIdx] = rosterIds.map((pid) => {
            const p = pid ? DB.getPlayerById(pid) : null;
            return {
                name: p?.name || '',
                id: pid || '',
                photo: pid ? DB.getPlayerPhoto(pid) : '',
            };
        });
        if (teamIdx === 0) m.team1 = teamName;
        else if (teamIdx === 1) m.team2 = teamName;
    }
    saveActiveRosterRoot(root, quiet);
    if (m && !quiet) {
        DB.saveMatch(m, true, { skipPublish: false });
    }
}

function getInningsTeamForSide(side) {
    const m = currentMatch;
    if (!m?.innings) return '';
    const inn = m.innings[m.currentInnings];
    if (!inn) return '';
    if (side === 'bowling') return inn.bowlingTeam || '';
    return inn.battingTeam || '';
}

function getSquadNamesForTeam(teamName) {
    if (!teamName) return [];
    const m = currentMatch;
    const teamIdx = m && m.team1 === teamName ? 0 : m && m.team2 === teamName ? 1 : null;
    const names = new Set();
    getTeamRosterSlots(teamName, teamIdx).forEach((val) => {
        if (!val) return;
        const p = resolveRosterPlayer(val);
        if (p?.name) names.add(p.name);
        else if (typeof val === 'string' && val.trim()) names.add(val.trim());
    });
    if (m?.rosters && teamIdx != null && Array.isArray(m.rosters[teamIdx])) {
        m.rosters[teamIdx].forEach((entry) => {
            if (entry?.name) names.add(entry.name);
        });
    }
    return Array.from(names);
}

function findPlayerInTeamRoster(name, teamName) {
    const n = (name || '').trim().toLowerCase();
    if (!n || !teamName) return null;
    const m = currentMatch;
    const teamIdx = m && m.team1 === teamName ? 0 : m && m.team2 === teamName ? 1 : null;
    for (const val of getTeamRosterSlots(teamName, teamIdx)) {
        const p = resolveRosterPlayer(val);
        if (p && p.name.trim().toLowerCase() === n) return p;
    }
    return (
        DB.getPlayers().find(
            (p) => p.name && p.name.trim().toLowerCase() === n
        ) || null
    );
}

function populateSquadDatalist(side) {
    const dl = document.getElementById('db-players-list');
    if (!dl) return;
    const teamName = getInningsTeamForSide(side);
    const names = teamName ? getSquadNamesForTeam(teamName) : [];
    if (!names.length) {
        dl.innerHTML = '';
        return;
    }
    dl.innerHTML = names
        .map((name) => `<option value="${escapeHTML(name)}"></option>`)
        .join('');
}

function rosterSlotHasPlayer(slots, pid, name) {
    const n = (name || '').trim().toLowerCase();
    return slots.some((val) => {
        if (!val) return false;
        const p = resolveRosterPlayer(val);
        if (pid && p?.playerId === pid) return true;
        if (p?.name && p.name.trim().toLowerCase() === n) return true;
        if (typeof val === 'string' && val.trim().toLowerCase() === n) return true;
        return false;
    });
}

/** Save player name into tournament/match roster + players DB (survives restart). */
function ensurePlayerOnTeamRoster(name, side = 'batting') {
    const trimmed = (name || '').trim();
    if (!trimmed || !currentMatch) return null;

    const m = currentMatch;
    const inn = m.innings?.[m.currentInnings ?? 0];
    const teamName = getInningsTeamForSide(side);
    if (!teamName) return null;
    let teamIdx = m.team1 === teamName ? 0 : m.team2 === teamName ? 1 : null;
    if (teamIdx == null && inn) {
        teamIdx =
            side === 'bowling'
                ? inn.bowlingTeam === m.team2
                    ? 1
                    : 0
                : inn.battingTeam === m.team2
                  ? 1
                  : 0;
    }
    if (teamIdx == null) teamIdx = 0;

    let pid = resolvePlayerIdForInnings(trimmed, side);
    if (!pid) {
        const hit = DB.getPlayers().find(
            (p) => p.name && p.name.trim().toLowerCase() === trimmed.toLowerCase()
        );
        if (hit) pid = hit.playerId;
        else {
            const created = DB.addPlayer({
                name: trimmed,
                team: teamName,
                role: side === 'bowling' ? 'Bowler' : 'Batsman',
            });
            pid = created?.playerId || null;
        }
    }

    const slots = [...getTeamRosterSlots(teamName, teamIdx)];
    if (!rosterSlotHasPlayer(slots, pid, trimmed)) {
        const entry = pid || trimmed;
        const emptyIdx = slots.findIndex((s) => !s || String(s).trim() === '');
        if (emptyIdx >= 0) slots[emptyIdx] = entry;
        else slots.push(entry);
        setTeamRosterIds(teamName, teamIdx, slots, false);
        if (window.desktopAPI?.requestPersist) {
            window.desktopAPI.requestPersist();
        }
    }
    return pid;
}

function renderSquadQuickPick(containerId, side, options = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const m = currentMatch;
    const inn = m?.innings?.[m.currentInnings];
    const teamName = getInningsTeamForSide(side);
    let names = teamName ? getSquadNamesForTeam(teamName) : [];

    if (options.includeInningsBowlers && side === 'bowling' && inn?.bowlers?.length) {
        const extra = inn.bowlers.map((b) => b.name).filter(Boolean);
        names = [...new Set([...names, ...extra])];
    }

    if (!names.length) {
        el.innerHTML =
            '<span class="squad-quick-empty">Squad empty — type name or save roster in Hotkeys → Team</span>';
        return;
    }

    el.innerHTML = names
        .map(
            (n) =>
                `<button type="button" class="squad-quick-btn bowler-quick-btn" data-squad-name="${escapeHTML(n)}">${escapeHTML(n)}</button>`
        )
        .join('');

    el.querySelectorAll('[data-squad-name]').forEach((btn) => {
        btn.onclick = () => {
            const picked = btn.getAttribute('data-squad-name');
            if (options.openBatsmen) pickSquadOpenBatsmanName(picked);
            else if (side === 'bowling') pickSquadBowlerName(picked);
            else pickSquadBatsmanName(picked);
        };
    });
}

function pickSquadOpenBatsmanName(name) {
    const n1 = document.getElementById('open-bat1-name');
    const n2 = document.getElementById('open-bat2-name');
    if (n1 && !n1.value.trim()) {
        n1.value = name;
        applySquadNameInput(n1, 'batting', 'batsman');
        return;
    }
    if (n2 && !n2.value.trim()) {
        n2.value = name;
        applySquadNameInput(n2, 'batting', 'nonstriker');
        return;
    }
    if (n1) {
        n1.value = name;
        applySquadNameInput(n1, 'batting', 'batsman');
    }
}

function pickSquadBatsmanName(name) {
    const inp = document.getElementById('new-bat-name');
    if (!inp) return;
    inp.value = name;
    applySquadNameInput(inp, 'batting', 'batsman');
    const sub = document.getElementById('player-lookup-result');
    if (sub) {
        sub.textContent = `✓ Selected: ${name}`;
        sub.style.color = '#00e676';
    }
}

function previewSquadPhotoOnOverlay(role, playerId, displayName) {
    const DEFAULT_PLAYER = '../assets/default-player.svg';
    const photo = playerId ? DB.getPlayerPhoto(playerId) : DEFAULT_PLAYER;
    const usePhoto = photo && photo !== DEFAULT_PLAYER ? photo : DEFAULT_PLAYER;
    const imgId =
        role === 'bowler'
            ? 'bm-photo-bowler'
            : role === 'nonstriker'
              ? 'bm-photo-nonstriker'
              : 'bm-photo-striker';
    const nameId =
        role === 'bowler'
            ? 'bm-name-bowler'
            : role === 'nonstriker'
              ? 'bm-name-nonstriker'
              : 'bm-name-striker';
    const img = document.getElementById(imgId);
    if (img) img.src = usePhoto;
    const lbl = document.getElementById(nameId);
    if (lbl && displayName) lbl.textContent = displayName;
}

function applySquadNameInput(inputEl, side, previewRole) {
    if (!inputEl) return;
    const teamName = getInningsTeamForSide(side);
    const name = inputEl.value.trim();
    if (!name || !teamName) return;
    const p = findPlayerInTeamRoster(name, teamName);
    if (!p) return;
    const row = inputEl.closest('.form-group') || inputEl.parentElement?.parentElement;
    const pidInp = row?.querySelector('input[id$="-pid"]');
    if (pidInp) pidInp.value = p.playerId || '';
    if (previewRole) previewSquadPhotoOnOverlay(previewRole, p.playerId, p.name);
}

function resolvePlayerIdForInnings(name, side) {
    const teamName = getInningsTeamForSide(side);
    const p = findPlayerInTeamRoster(name, teamName);
    return p?.playerId || null;
}


function renderTournamentStandings() {
    const t = currentTournament;
    if (!t) return;
    
    const container = document.getElementById('tm-standings-table');
    if (!container) return;

    if (!t.teams || t.teams.length === 0) {
        container.innerHTML = '<div style="padding:40px;text-align:center;opacity:0.5">No teams added yet.</div>';
        return;
    }

    // Initialize standings map
    const standings = {};
    t.teams.forEach(team => {
        standings[team] = { played: 0, won: 0, lost: 0, tied: 0, nr: 0, points: 0, runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0, nrr: 0 };
    });

    // Process all completed matches to calculate points and NRR
    if (t.matches) {
        t.matches.forEach(mId => {
            const m = DB.getMatch(mId);
            if (!m || m.status !== 'completed' || !m.innings || m.innings.length < 2) return;

            const t1 = m.team1;
            const t2 = m.team2;
            
            // If teams are missing from original roster, dynamically add them
            if (t1 !== 'TBD' && !standings[t1]) standings[t1] = { played: 0, won: 0, lost: 0, tied: 0, nr: 0, points: 0, runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0, nrr: 0 };
            if (t2 !== 'TBD' && !standings[t2]) standings[t2] = { played: 0, won: 0, lost: 0, tied: 0, nr: 0, points: 0, runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0, nrr: 0 };

            if (t1 === 'TBD' || t2 === 'TBD') return;

            const inn1 = m.innings[0];
            const inn2 = m.innings[1];
            
            // Batting first team
            const team1Bat = (inn1.battingTeam === t1) ? inn1 : inn2;
            const team1Bowl = (inn1.bowlingTeam === t1) ? inn1 : inn2;
            
            // Batting second team
            const team2Bat = (inn1.battingTeam === t2) ? inn1 : inn2;
            const team2Bowl = (inn1.bowlingTeam === t2) ? inn1 : inn2;

            if (!team1Bat || !team2Bat) return;

            standings[t1].played++;
            standings[t2].played++;

            // Win/Loss Calculation
            let result = m.resultText || '';
            if (result.includes(t1) && result.includes('won')) {
                standings[t1].won++; standings[t1].points += 2;
                standings[t2].lost++;
            } else if (result.includes(t2) && result.includes('won')) {
                standings[t2].won++; standings[t2].points += 2;
                standings[t1].lost++;
            } else if (result.toLowerCase().includes('tie') || result.toLowerCase().includes('drawn')) {
                standings[t1].tied++; standings[t1].points += 1;
                standings[t2].tied++; standings[t2].points += 1;
            } else if (result.toLowerCase().includes('no result') || result.toLowerCase().includes('abandoned')) {
                standings[t1].nr++; standings[t1].points += 1;
                standings[t2].nr++; standings[t2].points += 1;
            } else {
                // Fallback check if resultText is weird
                if (team1Bat.runs > team2Bat.runs) { standings[t1].won++; standings[t1].points += 2; standings[t2].lost++; }
                else if (team2Bat.runs > team1Bat.runs) { standings[t2].won++; standings[t2].points += 2; standings[t1].lost++; }
                else { standings[t1].tied++; standings[t2].tied++; standings[t1].points += 1; standings[t2].points += 1; }
            }

            // NRR Calculation Helpers
            const getOvers = (balls, isAllOut, maxOvers) => {
                if (isAllOut) return maxOvers;
                return Math.floor(balls / 6) + (balls % 6) / 6;
            };

            const t1AllOut = team1Bat.wickets >= m.playersPerSide - 1 || team1Bat.isAllOut;
            const t2AllOut = team2Bat.wickets >= m.playersPerSide - 1 || team2Bat.isAllOut;

            // Update runs and overs
            standings[t1].runsFor += team1Bat.runs;
            standings[t1].oversFor += getOvers(team1Bat.balls, t1AllOut, m.overs);
            standings[t1].runsAgainst += team2Bat.runs;
            standings[t1].oversAgainst += getOvers(team2Bat.balls, t2AllOut, m.overs);

            standings[t2].runsFor += team2Bat.runs;
            standings[t2].oversFor += getOvers(team2Bat.balls, t2AllOut, m.overs);
            standings[t2].runsAgainst += team1Bat.runs;
            standings[t2].oversAgainst += getOvers(team1Bat.balls, t1AllOut, m.overs);
        });
    }

    // Calculate NRR
    const teamsArr = Object.keys(standings).map(team => {
        const s = standings[team];
        if (s.oversFor > 0 && s.oversAgainst > 0) {
            s.nrr = (s.runsFor / s.oversFor) - (s.runsAgainst / s.oversAgainst);
        }
        return { name: team, ...s };
    });

    // Sort by points, then NRR
    teamsArr.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return b.nrr - a.nrr;
    });

    let html = `
    <div style="background:rgba(255,255,255,0.03); border-radius:12px; overflow:hidden; border:1px solid rgba(255,255,255,0.08)">
        <table style="width:100%; border-collapse:collapse; text-align:center; font-size:13px">
            <thead>
                <tr style="background:rgba(0,0,0,0.3); color:var(--c-muted); font-size:11px; text-transform:uppercase; letter-spacing:1px">
                    <th style="padding:12px 16px; text-align:left">Team</th>
                    <th style="padding:12px 8px">P</th>
                    <th style="padding:12px 8px">W</th>
                    <th style="padding:12px 8px">L</th>
                    <th style="padding:12px 8px">PTS</th>
                    <th style="padding:12px 16px; text-align:right">NRR</th>
                </tr>
            </thead>
            <tbody>
    `;

    teamsArr.forEach((t, i) => {
        const isTop4 = i < 4;
        const color = isTop4 ? 'var(--c-primary)' : 'var(--c-text)';
        const bg = i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent';
        
        html += `
            <tr style="background:${bg}; border-bottom:1px solid rgba(255,255,255,0.05)">
                <td style="padding:12px 16px; text-align:left; font-weight:800; color:${color}">
                    ${i + 1}. ${t.name}
                </td>
                <td style="padding:12px 8px; opacity:0.8">${t.played}</td>
                <td style="padding:12px 8px; color:#00e676; font-weight:700">${t.won}</td>
                <td style="padding:12px 8px; color:#ff1744; font-weight:700">${t.lost}</td>
                <td style="padding:12px 8px; font-weight:900; font-size:15px">${t.points}</td>
                <td style="padding:12px 16px; text-align:right; font-weight:700; color:${t.nrr >= 0 ? '#38bdf8' : '#ff8a65'}">
                    ${t.nrr > 0 ? '+' : ''}${t.nrr.toFixed(3)}
                </td>
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
    </div>
    <div style="font-size:11px; opacity:0.5; margin-top:12px; text-align:center;">
        * NRR formula: (Total Runs Scored / Total Overs Faced) - (Total Runs Conceded / Total Overs Bowled).
    </div>
    `;

    container.innerHTML = html;
}

function renderTournamentTeams() {
    const t = getActiveRosterRoot();
    if (!t) return;
    const container = document.getElementById('tm-teams-list');
    
    // For single match, 'teams' might just be team1 and team2
    const teamsList = t.teams || [t.team1, t.team2].filter(Boolean);

    container.innerHTML = teamsList.map(teamName => {
        if (!t.rosters) t.rosters = {};
        const roster = t.rosters[teamName] || [];
        const teamPhoto = DB.getTeamPhoto(teamName, t.id);
        const photoCount = roster.filter(v => v && String(v).trim()).length;
        return `
            <div class="card" style="padding:12px;display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:12px;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:12px">
                    <img src="${teamPhoto}" alt="" style="width:48px;height:48px;border-radius:12px;object-fit:cover;border:2px solid rgba(255,255,255,0.1)" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <div style="width:48px;height:48px;background:var(--c-primary);border-radius:12px;display:none;align-items:center;justify-content:center;font-weight:900;font-size:18px">${teamName[0] ? teamName[0].toUpperCase() : 'T'}</div>
                    <div>
                        <div style="font-weight:700;font-size:16px">${teamName}</div>
                        <div style="font-size:12px;opacity:0.6">${photoCount} / 11 players · tap Edit for photos</div>
                    </div>
                </div>
                <button class="btn btn-sm btn-primary" onclick="openRosterEditor('${escapeHTML(teamName)}')">📷 Squad & Photos</button>
            </div>
        `;
    }).join('');
}

let editingTeamName = null;
function resolveRosterPlayer(entry) {
    if (!entry) return null;
    const byId = DB.getPlayerById(entry);
    if (byId) return byId;
    const findName = String(entry).trim().toLowerCase();
    return DB.getPlayers().find(p => p.name && p.name.trim().toLowerCase() === findName) || null;
}

let pendingRosterSlotToRegister = null;
let pendingRosterName = null;

async function onRosterSlotClick(idx) {
    const t = getActiveRosterRoot();
    if (!t || !editingTeamName) return;

    const roster = t.rosters?.[editingTeamName] || [];
    const currentVal = roster[idx] || '';
    const currentPlayer = resolveRosterPlayer(currentVal);

    const namePrompt = await showInputModal(`Enter name for player slot ${idx + 1}:`, currentPlayer?.name || currentVal || '');
    if (namePrompt === null) return;
    const name = namePrompt.trim();
    
    if (!t.rosters) t.rosters = {};
    if (!t.rosters[editingTeamName]) t.rosters[editingTeamName] = [];
    const pid = upsertRosterPlayerByName(name, null);
    t.rosters[editingTeamName][idx] = pid || name;

    saveActiveRosterRoot(t);
    showToast('Player name assigned to slot ' + (idx + 1), 'success');
    openRosterEditor(editingTeamName);
}

window.onRosterPhotoClick = function(idx) {
    pendingRosterSlotToRegister = idx;
    const input = document.getElementById(`roster-name-${idx}`);
    pendingRosterName = input ? input.value : '';
    document.getElementById('roster-photo-file-input').click();
};

function assignRosterSlot(idx, playerOrId) {
    const t = getActiveRosterRoot();
    if (!t || !editingTeamName) return;
    if (!t.rosters) t.rosters = {};
    if (!t.rosters[editingTeamName]) t.rosters[editingTeamName] = [];
    t.rosters[editingTeamName][idx] = typeof playerOrId === 'string' ? playerOrId : playerOrId.playerId;
    saveActiveRosterRoot(t);
    openRosterEditor(editingTeamName);
}


function onRosterPhotoFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || pendingRosterSlotToRegister === null) {
        pendingRosterSlotToRegister = null;
        pendingRosterName = null;
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        const imageData = event.target.result;

        const t = getActiveRosterRoot();
        if (!t || !editingTeamName) return;

        const roster = t.rosters?.[editingTeamName] || [];
        const existingValue = roster[pendingRosterSlotToRegister] || '';
        let player = resolveRosterPlayer(existingValue);

        // If the input contains a name but not a player object, create on first upload
        if (!player && pendingRosterName) {
            player = DB.addPlayer({ name: pendingRosterName, photo: imageData, role: 'Player' });
        }
        
        if (player && pendingRosterSlotToRegister !== null) {
            localStorage.setItem('cricpro_photo_' + player.playerId, imageData);
            assignRosterSlot(pendingRosterSlotToRegister, player);
        }

        pendingRosterSlotToRegister = null;
        pendingRosterName = null;
    };
    reader.readAsDataURL(file);
}

function assignRosterSlot(idx, playerOrId) {
    const t = getActiveRosterRoot();
    if (!t || !editingTeamName) return;
    if (!t.rosters) t.rosters = {};
    if (!t.rosters[editingTeamName]) t.rosters[editingTeamName] = [];
    t.rosters[editingTeamName][idx] = typeof playerOrId === 'string' ? playerOrId : playerOrId.playerId;
    saveActiveRosterRoot(t);
    openRosterEditor(editingTeamName);
}

function openRosterEditor(teamName) {
    const t = getActiveRosterRoot();
    if (!t) return;
    
    editingTeamName = teamName || (t.teams && t.teams.length ? t.teams[0] : null);
    if (!editingTeamName) return;

    const m = currentMatch;
    if (m) {
        _fsrCurrentTeamIndex = m.team1 === editingTeamName ? 0 : m.team2 === editingTeamName ? 1 : _fsrCurrentTeamIndex;
    }

    const overlay = document.getElementById('full-screen-roster-overlay');
    if (!overlay) return;
    
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden'; 

    // Load Team Details
    const teamLogo = DB.getTeamPhoto(editingTeamName, t.id);
    const teamNameInput = document.getElementById('fsr-team-name-input');
    const teamLogoImg = document.getElementById('fsr-team-logo');
    const captainInput = document.getElementById('fsr-captain-input');
    const coachInput = document.getElementById('fsr-coach-input');
    const headerEl = document.getElementById('fsr-team-header');

    if (teamNameInput) teamNameInput.value = editingTeamName;
    if (teamLogoImg) teamLogoImg.src = teamLogo;

    // Load extended team details from tournament
    t.teamConfigs = t.teamConfigs || {};
    const config = t.teamConfigs[editingTeamName] || {};
    if (captainInput) captainInput.value = config.captain || '';
    if (coachInput) coachInput.value = config.coach || '';

    if (headerEl) {
        headerEl.innerHTML = `
            <div style="font-weight:950; font-size:24px; color:#fff">${editingTeamName.toUpperCase()}</div>
            <div style="font-size:11px; font-weight:700; color:var(--c-primary); text-transform:uppercase; letter-spacing:2px">SQUAD MANAGEMENT</div>
        `;
    }

    renderFSRosters();
}

function closeFullScreenRoster() {
    const overlay = document.getElementById('full-screen-roster-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
}

const FSR_GENERIC_PLAYER_NAME = /^Player\s*\d+$/i;

function isGenericFSRPlayerName(name) {
    return FSR_GENERIC_PLAYER_NAME.test((name || '').trim());
}

function fsrDisplayNameForSlot(player, slotValue) {
    if (player?.name && !isGenericFSRPlayerName(player.name)) return player.name;
    if (
        typeof slotValue === 'string' &&
        slotValue.trim() &&
        !/^CP\d/i.test(slotValue.trim()) &&
        !isGenericFSRPlayerName(slotValue)
    ) {
        return slotValue.trim();
    }
    return '';
}

function findGlobalPlayerByName(name) {
    const n = (name || '').trim().toLowerCase();
    if (!n) return null;
    return (
        DB.getPlayers().find((p) => p.name && p.name.trim().toLowerCase() === n) || null
    );
}

function refreshFsrPlayersDatalist() {
    const dl = document.getElementById('fsr-players-datalist');
    if (!dl) return;
    const seen = new Set();
    const opts = [];
    DB.getPlayers().forEach((p) => {
        const n = (p.name || '').trim();
        if (!n || isGenericFSRPlayerName(n) || seen.has(n.toLowerCase())) return;
        seen.add(n.toLowerCase());
        opts.push(`<option value="${escapeHTML(n)}"></option>`);
    });
    dl.innerHTML = opts.join('');
}

function onFSRPlayerNameChange(inputEl, idx) {
    const name = (inputEl.value || '').trim();
    const img = document.getElementById(`fsr-p-img-${idx}`);
    const statusEl = inputEl.closest('.fsr-player-card')?.querySelector('.fsr-p-status');
    const card = inputEl.closest('.fsr-player-card');

    if (!name) {
        inputEl.dataset.playerId = '';
        if (img) {
            delete img.dataset.userPhoto;
            img.src = DEFAULT_PLAYER_PHOTO;
        }
        if (statusEl) {
            statusEl.textContent = '🆕 Type player name first';
            statusEl.style.color = 'rgba(255,255,255,0.35)';
        }
        if (card) card.style.borderColor = 'rgba(255,255,255,0.05)';
        return;
    }

    const existing = findGlobalPlayerByName(name);
    if (existing) {
        inputEl.dataset.playerId = existing.playerId;
        if (img) {
            img.src = playerPhotoSrc(existing);
            img.dataset.userPhoto = '1';
        }
        if (statusEl) {
            statusEl.textContent = '✅ REGISTERED — photo loaded';
            statusEl.style.color = '#3b82f6';
        }
        if (card) card.style.borderColor = 'rgba(59, 130, 246, 0.3)';
    } else {
        inputEl.dataset.playerId = '';
        if (img && !img.dataset.userPhoto) img.src = DEFAULT_PLAYER_PHOTO;
        if (statusEl) {
            statusEl.textContent = '🆕 NEW — save to register';
            statusEl.style.color = 'rgba(255,255,255,0.45)';
        }
        if (card) card.style.borderColor = 'rgba(255,255,255,0.08)';
    }
}

function renderFSRosters() {
    const t = getActiveRosterRoot();
    if (!t || !editingTeamName) return;

    const m = currentMatch;
    const teamIdx =
        _fsrCurrentTeamIndex ?? (m && m.team1 === editingTeamName ? 0 : 1);
    const roster = getTeamRosterSlots(editingTeamName, teamIdx);
    const slotCount = Math.max(11, roster.length);
    const grid = document.getElementById('fsr-players-grid');
    if (!grid) return;

    let html = '';
    
    for (let i = 0; i < slotCount; i++) {
        const slotValue = roster[i] || '';
        const player = resolveRosterPlayer(slotValue);
        const displayName = fsrDisplayNameForSlot(player, slotValue);
        const photo = player && !isGenericFSRPlayerName(player.name)
            ? playerPhotoSrc(player)
            : DEFAULT_PLAYER_PHOTO;
        const playerIdAttr = player?.playerId && !isGenericFSRPlayerName(player.name)
            ? ` data-player-id="${escapeHTML(player.playerId)}"`
            : '';

        html += `
            <div class="card fsr-player-card" style="padding:20px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); border-radius:24px; display:flex; gap:15px; align-items:center; transition:0.3s">
                <div style="position:relative; width:70px; height:70px; flex-shrink:0; cursor:pointer" onclick="onFSRPlayerPhotoClick(${i})" title="Add photo (name required)">
                    <img id="fsr-p-img-${i}" src="${photo}" style="width:100%; height:100%; object-fit:cover; border-radius:18px; border:2px solid rgba(255,255,255,0.1)" onerror="this.src='${DEFAULT_PLAYER_PHOTO}'">
                    <div style="position:absolute; bottom:-4px; right:-4px; background:var(--c-primary); width:20px; height:20px; border-radius:50%; border:2px solid #000; font-size:10px; color:white; display:flex; align-items:center; justify-content:center">📷</div>
                </div>
                <div style="flex:1">
                    <div style="font-size:10px; color:var(--c-muted); font-weight:900; text-transform:uppercase; margin-bottom:4px">PLAYER ${(i + 1)}</div>
                    <input type="text" class="form-input fsr-p-name-input" list="fsr-players-datalist"
                           data-idx="${i}"${playerIdAttr} value="${escapeHTML(displayName)}"
                           placeholder="Type player name..."
                           autocomplete="off"
                           style="background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.1); border-radius:10px; height:44px; font-size:16px; font-weight:800; color:#fff" />
                    <div class="fsr-p-status" style="margin-top:6px; font-size:9px; font-weight:900; color:rgba(255,255,255,0.35)">🆕 Type player name first</div>
                </div>
            </div>
        `;
    }
    grid.innerHTML = html;
    refreshFsrPlayersDatalist();
    grid.querySelectorAll('.fsr-p-name-input').forEach((inp) => {
        const idx = parseInt(inp.dataset.idx, 10);
        if (Number.isNaN(idx)) return;
        inp.addEventListener('input', () => onFSRPlayerNameChange(inp, idx));
        inp.addEventListener('change', () => onFSRPlayerNameChange(inp, idx));
        onFSRPlayerNameChange(inp, idx);
    });
}

function onFSRPlayerPhotoClick(idx) {
    const inp = document.querySelector(`.fsr-p-name-input[data-idx="${idx}"]`);
    if (!inp?.value?.trim()) {
        showToast('Enter player name first — photo links to that name', 'error');
        inp?.focus();
        return;
    }
    window._pendingRosterSlot = idx;
    document.getElementById('fsr-player-photo-input').click();
}

function compressImageFile(file, maxW, quality, cb) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, maxW / img.width);
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            cb(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function upsertRosterPlayerByName(name, photoDataUrl) {
    const n = (name || '').trim();
    if (!n) return null;
    let p = DB.getPlayers().find(
        (x) => x.name && x.name.trim().toLowerCase() === n.toLowerCase()
    );
    if (!p) {
        p = DB.addPlayer({ name: n, photo: photoDataUrl || '', role: 'Player' });
    } else if (photoDataUrl && String(photoDataUrl).startsWith('data:')) {
        DB.savePlayerPhoto(p.playerId, photoDataUrl);
    }
    return p.playerId;
}

function onFSRPlayerPhotoSelected(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';

    compressImageFile(file, 400, 0.82, (dataUrl) => {
        const slotEl = window._fsrActivePhotoTarget
            ? document.getElementById(window._fsrActivePhotoTarget)
            : null;

        if (slotEl) {
            const nameInp = slotEl.querySelector('.fsr-p-name');
            const name = nameInp?.value?.trim() || 'Player';
            const pid = upsertRosterPlayerByName(name, dataUrl);
            const idInp = slotEl.querySelector('.fsr-p-id');
            if (idInp) idInp.value = pid;
            const img = slotEl.querySelector('.fsr-p-photo');
            if (img) img.src = dataUrl;
            showToast('Photo saved for ' + name, 'success');
            window._fsrActivePhotoTarget = null;
            return;
        }

        const idx = window._pendingRosterSlot;
        if (idx == null) return;

        const nameInp = document.querySelector(`.fsr-p-name-input[data-idx="${idx}"]`);
        const name = nameInp?.value?.trim();
        if (!name) {
            showToast('Enter player name first', 'error');
            window._pendingRosterSlot = null;
            return;
        }
        const pid = upsertRosterPlayerByName(name, dataUrl);
        if (nameInp) nameInp.dataset.playerId = pid;

        const imgEl = document.getElementById(`fsr-p-img-${idx}`);
        if (imgEl) {
            imgEl.src = dataUrl;
            imgEl.dataset.userPhoto = '1';
        }
        onFSRPlayerNameChange(nameInp, idx);
        showToast('Photo saved for ' + name, 'success');
        window._pendingRosterSlot = null;
    });
}

function onFSRTeamPhotoSelected(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';

    compressImageFile(file, 400, 0.8, (dataUrl) => {
        const m = currentMatch;
        const teamName =
            document.getElementById('fsr-team-name-input')?.value?.trim() ||
            editingTeamName ||
            (m && (_fsrCurrentTeamIndex === 0 ? m.team1 : m.team2)) ||
            '';
        const tournId = m?.tournamentId || (getActiveRosterRoot()?.id);
        DB.saveTeamPhoto(teamName, dataUrl, tournId);
        const logo = document.getElementById('fsr-team-logo');
        if (logo) logo.src = dataUrl;
        showToast('Team logo saved', 'success');
    });
}

function addRosterSlotFS() {
    if (!editingTeamName) return;
    const m = currentMatch;
    const teamIdx =
        _fsrCurrentTeamIndex ?? (m && m.team1 === editingTeamName ? 0 : 1);
    const slots = getTeamRosterSlots(editingTeamName, teamIdx);
    slots.push('');
    setTeamRosterIds(editingTeamName, teamIdx, slots, true);
    renderFSRosters();
}

function linkInningsPlayersToRoster(m, teamName, rosterIds) {
    if (!m?.innings || !teamName) return;
    const namesToId = {};
    rosterIds.forEach((pid) => {
        if (!pid) return;
        const p = DB.getPlayerById(pid);
        if (p?.name) namesToId[p.name.trim().toLowerCase()] = pid;
    });

    m.innings.forEach((inn) => {
        if (!inn) return;
        const linkList = (side) => {
            const list = side === 'bat' ? inn.batsmen : inn.bowlers;
            if (!list) return;
            const team = side === 'bat' ? inn.battingTeam : inn.bowlingTeam;
            if (team !== teamName) return;
            list.forEach((pl) => {
                if (!pl?.name) return;
                const pid = namesToId[pl.name.trim().toLowerCase()];
                if (pid) pl.playerId = pid;
            });
        };
        linkList('bat');
        linkList('bowl');
    });
}

function collectRosterIdsFromFSRGrid() {
    const ids = [];
    const m = currentMatch;
    const teamIdx =
        _fsrCurrentTeamIndex ?? (m && m.team1 === editingTeamName ? 0 : 1);
    const existingRoster = getTeamRosterSlots(editingTeamName, teamIdx);

    const gridA = document.querySelectorAll('.fsr-p-name-input');
    if (gridA.length) {
        gridA.forEach((inp, idx) => {
            const name = inp.value.trim();
            if (!name || isGenericFSRPlayerName(name)) {
                ids.push('');
                return;
            }
            const img = document.getElementById(`fsr-p-img-${idx}`);
            let photo = img?.src?.startsWith('data:') ? img.src : null;
            const linkedPid = inp.dataset.playerId || '';
            const linkedPlayer = linkedPid ? DB.getPlayerById(linkedPid) : null;
            if (
                linkedPlayer &&
                linkedPlayer.name &&
                linkedPlayer.name.trim().toLowerCase() === name.toLowerCase()
            ) {
                if (photo) DB.savePlayerPhoto(linkedPid, photo);
                ids.push(linkedPid);
                return;
            }
            const slotPid = existingRoster[idx] || '';
            const slotPlayer = slotPid ? DB.getPlayerById(slotPid) : null;
            if (!photo && slotPid) {
                const cached = DB.getPlayerPhoto(slotPid);
                if (cached && String(cached).startsWith('data:')) photo = cached;
            }
            if (
                slotPlayer &&
                slotPlayer.name &&
                !isGenericFSRPlayerName(slotPlayer.name) &&
                slotPlayer.name.trim().toLowerCase() === name.toLowerCase()
            ) {
                if (photo) DB.savePlayerPhoto(slotPid, photo);
                ids.push(slotPid);
            } else {
                ids.push(upsertRosterPlayerByName(name, photo));
            }
        });
        return ids;
    }

    document.querySelectorAll('.fsr-player-card').forEach((slot) => {
        const name = slot.querySelector('.fsr-p-name')?.value?.trim();
        if (!name) return;
        const photoEl = slot.querySelector('.fsr-p-photo');
        const photo = photoEl?.src?.startsWith('data:') ? photoEl.src : null;
        let pid = slot.querySelector('.fsr-p-id')?.value?.trim();
        if (!pid || !DB.getPlayerById(pid)) {
            pid = upsertRosterPlayerByName(name, photo);
        } else if (photo) {
            DB.savePlayerPhoto(pid, photo);
        }
        ids.push(pid);
    });
    return ids;
}

function saveRosterFromFS() {
    const m = currentMatch;
    if (!m) {
        showToast('No active match', 'error');
        return;
    }

    window._batchRosterSave = true;
    try {
        return _saveRosterFromFSImpl();
    } finally {
        window._batchRosterSave = false;
    }
}

function _saveRosterFromFSImpl() {
    const m = currentMatch;

    let teamName =
        document.getElementById('fsr-team-name-input')?.value?.trim() ||
        editingTeamName ||
        (_fsrCurrentTeamIndex === 0 ? m.team1 : m.team2);
    if (!teamName) {
        showToast('Enter team name', 'error');
        return;
    }

    const captain = document.getElementById('fsr-captain-input')?.value?.trim() || '';
    const coach = document.getElementById('fsr-coach-input')?.value?.trim() || '';
    const rosterIds = collectRosterIdsFromFSRGrid();

    let t = getActiveRosterRoot();
    if (t) {
        if (!t.rosters) t.rosters = {};
        if (editingTeamName && editingTeamName !== teamName && t.rosters[editingTeamName]) {
            t.rosters[teamName] = t.rosters[editingTeamName];
            delete t.rosters[editingTeamName];
        }
        t.teamConfigs = t.teamConfigs || {};
        t.teamConfigs[teamName] = { captain, coach };
        if (t.teams && !t.teams.includes(teamName)) t.teams.push(teamName);
        if (t.id && !String(t.id).startsWith('MATCH-')) {
            t.lastUpdated = Date.now();
            DB.saveTournament(t);
            currentTournament = t;
        }
        editingTeamName = teamName;
    }

    const teamIdx = _fsrCurrentTeamIndex ?? (m.team1 === teamName ? 0 : 1);
    setTeamRosterIds(teamName, teamIdx, rosterIds, true);

    linkInningsPlayersToRoster(m, teamName, rosterIds);

    const root = getActiveRosterRoot();
    if (root) saveActiveRosterRoot(root, false);
    DB.saveMatch(m, true, { skipPublish: false });

    if (window.desktopAPI) {
        window.desktopAPI.requestPersist();
    }

    populateSquadDatalist('batting');
    populateSquadDatalist('bowling');

    showToast('Squad saved on this PC — hotkeys can use these players', 'success');
    closeFullScreenRoster();
    if (typeof renderTournamentTeams === 'function') renderTournamentTeams();
    window._fsrMemRoster = null;
}


function showTeamOverlay(teamIdx) {
    const m = currentMatch;
    if (!m) return;
    const teamName = teamIdx === 0 ? m.team1 : m.team2;
    const t = m.tournamentId ? DB.getTournament(m.tournamentId) : m;
    const rosterIds = (t && t.rosters) ? (t.rosters[teamName] || []) : [];
    
    let html = `
        <div class="overlay-container show" id="overlay-team">
            <div class="overlay-card team-card">
                <div class="overlay-header">
                    <div class="overlay-title">${teamName}</div>
                    <div class="overlay-subtitle">TEAM ROSTER</div>
                </div>
                <div class="overlay-body roster-grid">
    `;
    
    if (rosterIds.length > 0) {
        rosterIds.forEach((pid, index) => {
            const p = DB.getPlayerById(pid);
            if (p) {
                const photoSrc = playerPhotoSrc(p);
                html += `
                    <div class="roster-item" style="animation: fadeInUp 0.4s ease forwards; animation-delay: ${index * 0.05}s">
                        <div class="roster-photo">
                            <img src="${photoSrc}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_PLAYER_PHOTO}'" />
                        </div>
                        <div class="roster-info">
                            <div class="roster-name">${p.name}</div>
                            <div class="roster-role">${capitalize(p.role || 'Player')}</div>
                        </div>
                    </div>
                `;
            }
        });
    } else {
        html += '<div style="grid-column: span 2; padding: 20px; text-align: center; color: rgba(255,255,255,0.5);">No registered players in roster</div>';
    }
    
    html += '</div></div></div>';
    renderOverlay(html);
}

function showPlayerOverlay(single, specificName) {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;
    
    let batters = [];
    if (specificName) {
        batters = [specificName];
    } else if (single) {
        batters = [getStrikerBatterName(inn)].filter(Boolean);
    } else {
        batters = getOnCreaseBatterNames(inn);
    }
    
    let html = `
        <div class="overlay-container show" id="overlay-players">
            <div class="overlay-card players-card" style="${batters.length === 1 ? 'max-width:500px' : ''}">
                <div class="overlay-header">
                    <div class="overlay-title">${batters.length === 1 ? 'Player Profile' : 'Current Batters'}</div>
                </div>
                <div class="overlay-body ${batters.length === 1 ? '' : 'player-stats-flex'}">
    `;
    
    batters.forEach(bName => {
        const p = resolvePlayerProfileForBatter(inn, bName);
        const stats = inn.batsmen.find(x => x.name === bName) || { runs:0, balls:0, fours:0, sixes:0 };
        const photoSrc = playerPhotoSrc(p);
        
        html += `
            <div class="player-stat-card" style="${batters.length === 1 ? 'margin-bottom:0' : ''}; animation: slideInLeft 0.5s ease forwards">
                <div class="player-main-info">
                    <div class="player-large-photo">
                        <img src="${photoSrc}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_PLAYER_PHOTO}'" />
                    </div>
                    <div>
                        <div class="player-lg-name">${bName}</div>
                        <div class="player-lg-role" style="font-size:16px; color:var(--c-primary)">${p ? capitalize(p.role || 'Player') : 'Batsman'}</div>
                    </div>
                </div>
                <div class="player-mini-stats">
                    <div class="m-stat"><div class="m-val">${stats.runs}</div><div class="m-lbl">Runs</div></div>
                    <div class="m-stat"><div class="m-val">${stats.balls}</div><div class="m-lbl">Balls</div></div>
                    <div class="m-stat"><div class="m-val">${stats.fours}</div><div class="m-lbl">4s</div></div>
                    <div class="m-stat"><div class="m-val">${stats.sixes}</div><div class="m-lbl">6s</div></div>
                </div>
            </div>
        `;
    });
    
    html += '</div></div></div>';
    renderOverlay(html);
}

function renderOverlay(html) {
    hideOverlay();
    const div = document.createElement('div');
    div.id = 'active-overlay-wrapper';
    div.innerHTML = html;
    document.body.appendChild(div);
    
    // Auto hide after 8 seconds
    activeOverlayId = setTimeout(() => hideOverlay(), 8000);
}

function hideOverlay() {
    if (activeOverlayId) {
        clearTimeout(activeOverlayId);
        activeOverlayId = null;
    }
    const el = document.getElementById('active-overlay-wrapper');
    if (el) {
        el.style.pointerEvents = 'none'; // Kill interaction immediately
        el.remove(); // Remove from DOM
    }
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[m]);
}

// ========== BROADCASTS ==========
function sendBroadcast(cmd, data) {
    if (!currentMatch) {
        if (typeof showToast === 'function') {
            showToast('Live match required — score a match first', 'error');
        }
        return;
    }
    const payload = { ...(data || {}) };
    if (cmd === 'SYNC_SCORE' || cmd === 'SYNC_MATCH' || cmd === 'FORCE_UPDATE') {
        payload.match = currentMatch;
        payload.matchId = currentMatch.id;
    }
    if (typeof Broadcast !== 'undefined' && typeof Broadcast.send === 'function') {
        Broadcast.send(cmd, payload);
        return;
    }
    const envelope = {
        cmd,
        data: payload,
        matchId: currentMatch.id,
        tournamentId: currentMatch.tournamentId,
        timestamp: Date.now(),
    };
    localStorage.setItem('cricpro_broadcast_cmd', JSON.stringify(envelope));
    if (typeof window.forwardBroadcastToPreviews === 'function') {
        window.forwardBroadcastToPreviews(envelope);
    } else {
        document.querySelectorAll('iframe').forEach((f) => {
            if (f.contentWindow) {
                f.contentWindow.postMessage({ type: 'cricpro_broadcast_cmd', payload: envelope }, '*');
            }
        });
    }
    if (window.desktopAPI) {
        window.desktopAPI.publishMatch(currentMatch);
        window.desktopAPI.broadcastCommand(envelope);
    }
    if (typeof socket !== 'undefined' && socket) socket.emit('broadcast_command', envelope);
}

function broadcastTeamRoster(teamIdx) {
    const m = currentMatch;
    if (!m) return;
    const teamName = teamIdx === 0 ? m.team1 : m.team2;
    const t = m.tournamentId ? DB.getTournament(m.tournamentId) : m;
    const rosterIds = (t && t.rosters) ? (t.rosters[teamName] || []) : [];
    
    const players = rosterIds.map(pid => DB.getPlayerById(pid)).filter(Boolean);
    sendBroadcast('SHOW_TEAM_ROSTER', { teamName, players });
}

function broadcastTeamCard(teamIdx) {
    if (typeof Broadcast !== 'undefined' && Broadcast.broadcastTeamCard) {
        return Broadcast.broadcastTeamCard(teamIdx);
    }
    const m = currentMatch;
    if (!m) return showToast('No active match', 'error');
    const teamName = teamIdx === 0 ? m.team1 : m.team2;
    if (typeof window.buildTeamSquadBroadcastPayload === 'function') {
        sendBroadcast('SHOW_TEAM_CARD', window.buildTeamSquadBroadcastPayload(m, teamName));
        showToast(`📋 ${teamName} squad published`, 'success');
    }
}

function broadcastBattingTeamSquad() {
    if (typeof Broadcast !== 'undefined' && Broadcast.broadcastBattingTeamSquad) {
        return Broadcast.broadcastBattingTeamSquad();
    }
    const m = currentMatch;
    if (!m) return showToast('No active match', 'error');
    const inn = m.innings?.[m.currentInnings || 0];
    const teamName = inn?.battingTeam || m.team1;
    if (typeof window.buildTeamSquadBroadcastPayload === 'function') {
        sendBroadcast('SHOW_TEAM_CARD', window.buildTeamSquadBroadcastPayload(m, teamName));
        showToast(`🏏 ${teamName} batting squad published`, 'success');
    }
}

function broadcastNextMatch() {
    const teamA = document.getElementById('next-match-teama').value.trim() || 'TBD';
    const teamB = document.getElementById('next-match-teamb').value.trim() || 'TBD';
    sendBroadcast('SHOW_NEXT_MATCH', { teamA, teamB });
    showToast('📺 Next Match Artwork Published!', 'success');
}

function broadcastCurrentBatters() {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;
    const batters = getOnCreaseBatterNames(inn); // [idx0, idx1]
    
    const profiles = batters.map((bName, index) => {
        let p = resolvePlayerProfileForBatter(inn, bName) || {};
        
        // Priority 1: Specific inline button
        if (window[`__photo_batter${index+1}`]) {
            p.photo = window[`__photo_batter${index+1}`];
            window[`__photo_batter${index+1}`] = null;
            const el = document.getElementById(`preview_batter${index+1}`);
            if(el) { el.innerHTML = '📷'; el.style.borderColor = 'rgba(255,255,255,0.3)'; }
        } else {
            // Priority 2: Global Striker / Non-Striker
            const isStriker = (inn.strikerIdx === index);
            if (isStriker && window.__photo_striker) {
                p.photo = window.__photo_striker; 
                // Note: Not clearing global striker photo so it remains active for other graphics
            } else if (!isStriker && window.__photo_nonstriker) {
                p.photo = window.__photo_nonstriker;
            }
        }
        
        const stats = inn.batsmen.find(x => x.name === bName) || { runs:0, balls:0, fours:0, sixes:0 };
        return { name: bName, profile: p, stats };
    });
    sendBroadcast('SHOW_BATTER_PROFILES', { profiles });
    showToast('🏏 Batters Published!', 'success');
}

function broadcastStrikerProfile() {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;
    const strikerName = getStrikerBatterName(inn);
    if (!strikerName) return;
    
    let p = resolvePlayerProfileForBatter(inn, strikerName);
    const stats = inn.batsmen.find(x => x.name === strikerName) || { runs:0, balls:0, fours:0, sixes:0 };
    
    if (!p) p = {};
    if (window.__photo_striker) {
        p.photo = window.__photo_striker;
        // Don't nullify window.__photo_striker so it stays for Partnership
        // window.__photo_striker = null;
        // document.getElementById('preview_striker').innerHTML = '📷';
    }
    
    const age = p.dob ? calculateAge(p.dob) : "";
    const payload =
        typeof window.buildPlayerProfileBroadcastData === 'function'
            ? window.buildPlayerProfileBroadcastData(
                  { ...stats, name: strikerName, playerId: p.playerId },
                  m,
                  'striker'
              )
            : {
                  playerName: strikerName,
                  teamName: inn.battingTeam || m.team1,
                  playerPhoto: p.photo || playerPhotoSrc(p),
                  playerRuns: stats.runs,
                  playerBalls: stats.balls,
                  playerSixes: stats.sixes || 0,
                  age,
              };
    if (payload && age) payload.age = age;
    sendBroadcast('SHOW_STRIKER_PROFILE', payload);
    showToast('⚡ Striker Profile Published!', 'success');
}

function broadcastNonStrikerProfile() {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;
    // Non-striker is whichever batter ISN'T the striker
    const [b0, b1] = getOnCreaseBatterNames(inn);
    const nonStrikerName = (inn.strikerIdx === 0) ? b1 : b0;
    if (!nonStrikerName) return;
    let p = resolvePlayerProfileForBatter(inn, nonStrikerName) || {};
    if (window.__photo_nonstriker) p.photo = window.__photo_nonstriker;
    const stats = inn.batsmen.find(x => x.name === nonStrikerName) || { runs:0, balls:0, fours:0, sixes:0 };
    const payload =
        typeof window.buildPlayerProfileBroadcastData === 'function'
            ? window.buildPlayerProfileBroadcastData(
                  { ...stats, name: nonStrikerName, playerId: p.playerId },
                  m,
                  'nonstriker'
              )
            : {
                  playerName: nonStrikerName,
                  teamName: inn.battingTeam || m.team1,
                  playerPhoto: p.photo || playerPhotoSrc(p),
                  playerRuns: stats.runs,
                  playerBalls: stats.balls,
                  playerSixes: stats.sixes || 0,
              };
    sendBroadcast('SHOW_NON_STRIKER_PROFILE', payload);
    showToast('🛡️ Non-Striker Profile Published!', 'success');
}

function broadcastBowlerProfile() {
    const m = currentMatch;
    if (!m) { showToast('No active match!', 'error'); return; }
    const inn = m.innings[m.currentInnings];
    if (!inn) { showToast('No active innings!', 'error'); return; }
    
    let bowler = inn.bowlers[inn.currentBowlerIdx];
    if (!bowler && inn.bowlers.length > 0) {
        // Fallback to latest bowler if current index is invalid
        bowler = inn.bowlers[inn.bowlers.length - 1];
    }
    
    if (!bowler) { showToast('No bowler found in innings!', 'error'); return; }
    
    // Resolve profile from DB if possible
    let p = null;
    if (bowler.playerId) p = DB.getPlayerById(bowler.playerId);
    else if (m.type === 'tournament' && m.tournamentId) {
        // Fallback: search tournament squads
        const t = DB.getTournament(m.tournamentId);
        if (t && t.rosters) {
            for (const team in t.rosters) {
                const pid = t.rosters[team].find(id => DB.getPlayerById(id)?.name === bowler.name);
                if (pid) { p = DB.getPlayerById(pid); break; }
            }
        }
    }
    
    if (!p) p = {};
    if (window.__photo_bowler) {
        p.photo = window.__photo_bowler;
        // Retain for multiple re-broadcasts
    }
    
    const bowlerPayload =
        typeof window.buildPlayerProfileBroadcastData === 'function'
            ? window.buildPlayerProfileBroadcastData(
                  { ...bowler, playerId: bowler.playerId || p.playerId },
                  m,
                  'bowler'
              )
            : {
                  playerName: bowler.name,
                  teamName: inn.bowlingTeam || m.team2,
                  playerPhoto: p.photo || playerPhotoSrc(p),
                  playerRuns: bowler.wickets || 0,
                  playerBalls: bowler.runs || 0,
                  playerSixes: formatOvers(bowler.balls, m.ballsPerOver),
              };
    sendBroadcast('SHOW_BOWLER_PROFILE', bowlerPayload);
    showToast('⚾ Bowler Profile Published!', 'success');
}

function triggerVisualBigEvent(type) {
    const m = currentMatch;
    if (!m) return;
    const inn = m.innings[m.currentInnings];
    if (!inn) return;

    const strikerName = getStrikerBatterName(inn);
    const strikerProfile = resolvePlayerProfileForBatter(inn, strikerName) || {};
    if (window.__photo_striker) strikerProfile.photo = window.__photo_striker;

    const strikerStats = inn.batsmen.find(x => x.name === strikerName) || { runs: 0, balls: 0 };
    const bowler = inn.bowlers[inn.currentBowlerIdx] || { name: 'Bowler' };
    
    const payload = {
        type: type.toUpperCase(), // 'FOUR', 'SIX', 'WICKET'
        playerName: strikerName,
        playerPhoto: playerPhotoSrc(strikerProfile),
        playerRuns: strikerStats.runs,
        playerBalls: strikerStats.balls,
        bowlerName: bowler.name,
        teamName: inn.battingTeam,
        matchScore: `${inn.runs}/${inn.wickets}`
    };

    sendBroadcast('SHOW_BIG_EVENT', payload);
    showToast(`📺 Visual Trigger: ${type}`, 'success');
}

function broadcastPartnership() {
    const m = currentMatch || window.currentMatch;
    if (!m) {
        showToast('No active match!', 'error');
        return;
    }
    if (typeof syncLivePlayerPhotoSlots === 'function') syncLivePlayerPhotoSlots(m);
    const payload =
        typeof window.buildPartnershipBroadcastData === 'function'
            ? window.buildPartnershipBroadcastData(m)
            : null;
    if (payload) {
        sendBroadcast('SHOW_PARTNERSHIP', payload);
    } else {
        showToast('No partnership data', 'error');
        return;
    }
    showToast('📺 Partnership published!', 'success');
}

// ========== GLOBAL SYNC HANDLERS ==========
window.renderOngoing = function() {
    // If scoring a match, ALWAYS pull fresh data into memory to allow multi-device sync
    if (typeof currentMatch !== 'undefined' && currentMatch && typeof DB !== 'undefined') {
        const fresh = DB.getMatch(currentMatch.id);
        if (fresh) currentMatch = fresh;
    }

    if (document.getElementById('screen-scoring') && document.getElementById('screen-scoring').style.display === 'block') {
        renderScoring();
    } else if (document.getElementById('modal-tournament-matches') && document.getElementById('modal-tournament-matches').style.display === 'flex') {
        if (typeof currentTournamentTab !== 'undefined' && currentTournamentTab === 'matches') renderTournamentMatches();
        else renderTournamentTeams();
    } else {
        // Always refresh the dashboard if not in a match
        if (typeof renderResumeMatches === 'function') renderResumeMatches();
    }
};

// --- BROADCAST CONTROLLER UI (Dedicated Tab for TV Overlays) ---
function renderBroadcastController(match) {
    // Premium Broadcast Controller CSS
    const styleId = 'broadcast-lockdown-css';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            body, html { 
                background: linear-gradient(135deg, #070b14 0%, #0d121f 100%) !important; 
                overflow-x: hidden !important; 
                margin: 0; padding: 0; 
                min-height: 100vh !important; 
                color: #e2e8f0;
                font-family: 'Outfit', 'Inter', sans-serif;
            }
            .broadcast-controller-content {
                max-width: 600px;
                margin: 0 auto;
                padding: 24px;
                padding-bottom: 100px;
            }
            .page-wrapper > *:not(.broadcast-controller-content) { display: none !important; }
            
            .b-card {
                background: rgba(255, 255, 255, 0.03);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 24px;
                padding: 20px;
                margin-bottom: 20px;
            }
            .b-section-title {
                font-size: 10px;
                font-weight: 800;
                color: rgba(255,255,255,0.4);
                text-transform: uppercase;
                letter-spacing: 1.5px;
                margin-bottom: 16px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .b-section-title::after {
                content: "";
                flex: 1;
                height: 1px;
                background: rgba(255,255,255,0.05);
            }
            .b-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 12px;
            }
            .b-btn {
                border: none;
                border-radius: 16px;
                padding: 10px 16px;
                color: white;
                cursor: pointer;
                text-align: left;
                transition: transform 0.2s, background 0.2s, box-shadow 0.2s;
                position: relative;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                justify-content: center;
                min-height: 55px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            }
            .b-btn:active { transform: scale(0.96); }
            .b-btn i { font-size: 20px; margin-bottom: 8px; opacity: 0.9; }
            .b-btn-title { font-size: 14px; font-weight: 800; line-height: 1.2; text-transform: uppercase; }
            .b-btn-sub { font-size: 10px; opacity: 0.7; font-weight: 500; margin-top: 4px; }
            
            /* Button Variants */
            .b-btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); }
            .b-btn-purple { background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); }
            .b-btn-emerald { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
            .b-btn-rose { background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%); }
            .b-btn-amber { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
            .b-btn-slate { background: linear-gradient(135deg, #475569 0%, #1e293b 100%); }
            .b-btn-black { background: #000; border: 1px solid rgba(255,255,255,0.1); }
            .b-btn-red { background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%); }
            
            .v-trigger {
                width: 100%;
                height: 60px;
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                font-weight: 950;
                cursor: pointer;
                transition: 0.2s;
            }
            .v-4 { border: 2px solid #3b82f6; color: #3b82f6; background: rgba(59, 130, 246, 0.1); }
            .v-6 { border: 2px solid #8b5cf6; color: #8b5cf6; background: rgba(139, 92, 246, 0.1); }
            .v-w { border: 2px solid #f43f5e; color: #f43f5e; background: rgba(244, 63, 94, 0.1); }
            
            .v-trigger:active { transform: scale(0.95); opacity: 0.7; }

            /* Toggle Switch Style */
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider:before {
                position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px;
                background-color: white; transition: .4s; border-radius: 50%;
            }
            input:checked + .slider { background-color: #3b82f6 !important; }
            input:checked + .slider:before { transform: translateX(22px); }

            /* Mobile Fixes for Broadcast Controller (Super Compact Mode) */
            @media (max-width: 900px) {
                .broadcast-controller-content {
                    padding: 12px;
                }
                .broadcast-main-grid {
                    grid-template-columns: 1fr !important;
                    gap: 12px !important;
                }
                .b-grid {
                    grid-template-columns: 1fr 1fr !important;
                    gap: 8px !important;
                }
                .b-btn {
                    min-height: 54px !important; /* Narrower buttons */
                    padding: 8px 12px !important;
                    border-radius: 12px !important;
                }
                .b-btn-title {
                    font-size: 11px !important;
                }
                .b-btn-sub {
                    font-size: 8px !important;
                    display: none; /* Hide subtext on small screens to save space */
                }
                .b-btn-hotkey {
                    display: none; /* Hide hotkey guide on small mobile */
                }
                .v-trigger {
                    height: 50px !important;
                    font-size: 20px !important;
                }
                .b-card {
                    padding: 12px !important;
                    margin-bottom: 0 !important;
                }
                .b-section-title {
                    font-size: 10px !important;
                    margin-bottom: 8px !important;
                }
                .broadcast-header {
                    margin-bottom: 12px !important;
                }
            }

            @media (max-width: 600px) {
                .broadcast-header {
                    flex-direction: row !important;
                    justify-content: space-between !important;
                    align-items: center !important;
                    gap: 8px;
                }
                .broadcast-header h2, .broadcast-header .logo-text-animated {
                    display: none; /* Save space in header */
                }
                .b-grid {
                    grid-template-columns: 1fr 1fr !important; /* Keep 2 columns on mobile */
                }
            }
        `;
        document.head.appendChild(style);
    }

    const wrapper = document.querySelector('.page-wrapper');
    if (!wrapper) return;
    
    // Cleanup existing intervals/listeners if any
    if (window._broadcastSyncInterval) clearInterval(window._broadcastSyncInterval);
    if (window._handleRemoteHotkey) document.removeEventListener('keydown', window._handleRemoteHotkey);

        // Resolve current score for header
        const inn = (match.innings && match.innings[match.currentInnings || 0]) || { runs:0, wickets:0, balls:0 };
        const scoreStr = `${inn.runs}/${inn.wickets} (${typeof formatOvers === 'function' ? formatOvers(inn.balls, match.ballsPerOver || 6) : inn.balls})`;

        wrapper.innerHTML = `
    <div class="broadcast-controller-content" style="max-width:1100px;">
        <!-- Header -->
        <div class="broadcast-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
            <div>
                <div style="font-size: 10px; font-weight: 900; color: #3b82f6; text-transform: uppercase; letter-spacing: 2px;">Remote Station</div>
                <div style="font-size: 24px; font-weight: 950; letter-spacing: -0.5px; color: #fff;">BROADCAST MASTER</div>
            </div>
            <div style="display:flex; align-items:center; gap:12px">
                <div style="background: rgba(0, 230, 118, 0.1); border: 1px solid rgba(0, 230, 118, 0.2); padding: 8px 16px; border-radius: 12px; color: #00e676; font-weight: 900; font-size: 11px;">
                    LIVE • ${match.team1} vs ${match.team2}
                </div>
            </div>
        </div>

        <div class="broadcast-main-grid" style="display: grid; grid-template-columns: 320px 1fr 320px; gap: 24px; align-items: start;">
            
            <!-- LEFT COLUMN: MASTER CONTROL & SCOREBAR -->
            <div style="display: flex; flex-direction: column; gap: 20px;">
                <!-- MASTER CONTROLS -->
                <div class="b-card" style="margin-bottom:0; background: linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%);">
                    <div class="b-section-title">🎮 MASTER CONTROL</div>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <button class="b-btn b-btn-red" style="min-height:65px; border: 2px solid rgba(255,255,255,0.1);" onclick="if(typeof Broadcast !== 'undefined') Broadcast.stopAll(); else sendBroadcast('STOP_OVERLAY')">
                            <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                                <div>
                                    <div class="b-btn-title" style="font-size:16px">⏹ STOP ALL</div>
                                    <div class="b-btn-sub">Clear all active overlays</div>
                                </div>
                                <div style="background:rgba(255,255,255,0.2); padding:4px 8px; border-radius:6px; font-size:10px; font-weight:900">ESC</div>
                            </div>
                        </button>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <button class="b-btn b-btn-slate" style="min-height:50px" onclick="location.reload()">
                                <div class="b-btn-title" style="font-size:11px">🔌 RECONNECT</div>
                            </button>
                            <button class="b-btn b-btn-emerald" style="min-height:50px" onclick="if(window.SLCRICK_DESKTOP&&window.openObsOverlayForMatch){openObsOverlayForMatch('${match.id}','${match.tournamentId || ''}'); showToast('📺 OBS overlay opened — OBS එකේ Window Capture දාන්න','success');}else{const obsUrl=window.location.origin+window.location.pathname.replace('score-match.html','overlay.html')+'?match=${match.id}';navigator.clipboard.writeText(obsUrl);showToast('✅ OBS URL Copied!','success');}">
                                <div class="b-btn-title" style="font-size:11px">${window.SLCRICK_DESKTOP ? '📺 OPEN OBS' : '🔗 OBS URL'}</div>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- SCOREBAR CONTROL -->
                <div class="b-card" style="margin-bottom:0">
                    <div class="b-section-title">👁️ SCOREBAR CONTROL</div>
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        <button class="b-btn b-btn-emerald" id="btn-toggle-scorebar" style="min-height:55px; box-shadow:0 0 15px rgba(0,255,0,0.3);" onclick="if(typeof Broadcast !== 'undefined') Broadcast.toggleScorebar(); else sendBroadcast('TOGGLE_SCOREBAR')">
                            <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                                <div class="b-btn-title" id="txt-toggle-scorebar">LIVE SCOREBAR: ON</div>
                                <div class="b-btn-hotkey" style="background:rgba(0,0,0,0.3); padding:2px 6px; border-radius:4px; font-size:9px">S+V</div>
                            </div>
                        </button>

                        <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 12px;">
                            <label style="font-size:9px; font-weight:900; color:rgba(255,255,255,0.4); text-transform:uppercase; display:block; margin-bottom:8px; letter-spacing:1px;">ACTIVE THEME</label>
                            <select id="scorebar-style-select" onchange="if(typeof Broadcast !== 'undefined') Broadcast.changeOverlayTheme(this.value); else sendBroadcast('SET_OVERLAY_MODE', { mode: this.value })" 
                                style="width:100%; background:#0f172a; border:1px solid rgba(255,255,255,0.1); color:#fff; padding:10px; border-radius:8px; font-weight:700; font-size:12px;">
                                <option value="theme1">Classic Scoreboard (Default)</option>
                                <option value="theme2">Scorecard 2 (Modern)</option>
                                <option value="theme3">Manual Input Scorecard</option>
                                <option value="theme4">Classic Scoreboard (Alt)</option>
                            </select>
                        </div>

                        <!-- SUB-MODES FOR MODE 4 -->
                        <div id="submode-controls" style="display:none; background: rgba(59, 130, 246, 0.05); padding: 12px; border-radius: 12px; border: 1px dashed rgba(59, 130, 246, 0.2);">
                            <label style="font-size:9px; font-weight:900; color:#3b82f6; text-transform:uppercase; display:block; margin-bottom:8px; letter-spacing:1px;">Score Bar 2 - Dynamic Modes</label>
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
                                <button class="b-btn b-btn-slate" style="min-height:40px; padding:5px;" onclick="Broadcast.setOverlaySubMode(1)">
                                    <div class="b-btn-title" style="font-size:9px; text-align:center;">TOURNEY</div>
                                </button>
                                <button class="b-btn b-btn-slate" style="min-height:40px; padding:5px;" onclick="Broadcast.setOverlaySubMode(2)">
                                    <div class="b-btn-title" style="font-size:9px; text-align:center;">CRR</div>
                                </button>
                                <button class="b-btn b-btn-slate" style="min-height:40px; padding:5px;" onclick="Broadcast.setOverlaySubMode(3)">
                                    <div class="b-btn-title" style="font-size:9px; text-align:center;">CHASING</div>
                                </button>
                            </div>
                        </div>

                    </div>
                </div>

                <!-- QUICK TRIGGERS -->
                <div class="b-card" style="margin-bottom:0">
                    <div class="b-section-title">⚡ QUICK TRIGGERS</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
                        <div class="v-trigger v-4" onclick="triggerVisualBigEvent('FOUR')">4</div>
                        <div class="v-trigger v-6" onclick="triggerVisualBigEvent('SIX')">6</div>
                        <div class="v-trigger v-w" onclick="triggerVisualBigEvent('WICKET')">W</div>
                    </div>
                </div>
            </div>

            <!-- CENTER COLUMN: LIVE PREVIEW & CINEMATICS -->
            <div style="display: flex; flex-direction: column; gap: 20px;">
                <!-- LIVE PREVIEW AREA -->
                <div style="position: relative;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
                        <div style="display:flex; align-items:center; gap:8px">
                            <div style="width:10px; height:10px; background:#f43f5e; border-radius:50%; animation: pulse 1.5s infinite"></div>
                            <div style="font-size:11px; font-weight:900; color:#fff; text-transform:uppercase; letter-spacing:1px;">REAL-TIME OUTPUT PREVIEW</div>
                        </div>
                        <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.4)">1920 × 1080 (SCALED)</div>
                    </div>
                    
                    <div id="broadcast-preview-container" style="background:#000; border:4px solid rgba(255,255,255,0.1); border-radius:16px; overflow:hidden; width:100%; aspect-ratio:16/9; position:relative; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
                        <iframe id="broadcast-preview-frame" src="overlay.html?match=${match.id}${match.tournamentId ? '&tournament='+match.tournamentId : ''}&preview=true" style="width:1920px; height:1080px; border:none; pointer-events:none; position:absolute; top:0; left:0; transform-origin: top left;" scrolling="no"></iframe>
                    </div>
                    
                    <div style="margin-top:12px; display:flex; justify-content:center; gap:20px">
                        <div style="font-size: 10px; font-weight: 800; color: rgba(255,255,255,0.3); text-transform: uppercase;">🔴 Live Feed Active</div>
                        <div style="font-size: 10px; font-weight: 800; color: rgba(255,255,255,0.3); text-transform: uppercase;">⚡ Zero Latency Sync</div>
                        <div style="font-size: 10px; font-weight: 800; color: rgba(255,255,255,0.3); text-transform: uppercase;">📺 OBS/VMIX READY</div>
                    </div>
                </div>

                <!-- CINEMATIC GRAPHICS -->
                <div class="b-card" style="margin-bottom:0; background: rgba(59, 130, 246, 0.03); border-color: rgba(59, 130, 246, 0.15);">
                    <div class="b-section-title" style="color: #60a5fa;">🎬 CINEMATIC PRODUCTIONS</div>
                    <div class="b-grid" style="grid-template-columns: repeat(3, 1fr);">
                        <button class="b-btn b-btn-primary" onclick="fireProfileBroadcast('striker')">
                            <div class="b-btn-title">⚡ STRIKER</div>
                            <div class="b-btn-sub">S+B</div>
                        </button>
                        <button class="b-btn" style="background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;" onclick="fireProfileBroadcast('nonstriker')">
                            <div class="b-btn-title">🛡️ NON-STR</div>
                            <div class="b-btn-sub">S+N</div>
                        </button>
                        <button class="b-btn b-btn-emerald" onclick="broadcastCurrentBatters()">
                            <div class="b-btn-title">🏏 BATTERS</div>
                            <div class="b-btn-sub">S+P</div>
                        </button>
                        <button class="b-btn b-btn-amber" onclick="broadcastPartnership()">
                            <div class="b-btn-title">🤝 PARTNER</div>
                            <div class="b-btn-sub">S+H</div>
                        </button>
                        <button class="b-btn b-btn-purple" onclick="fireProfileBroadcast('bowler')">
                            <div class="b-btn-title">⚾ BOWLER</div>
                            <div class="b-btn-sub">S+L</div>
                        </button>
                        <button class="b-btn b-btn-black" onclick="broadcastTeamCard(0)">
                            <div class="b-btn-title">👕 ${getShortName(match.team1)}</div>
                            <div class="b-btn-sub">S+K</div>
                        </button>
                    </div>
                </div>

            </div>

            <!-- RIGHT COLUMN: MATCH DATA & PHOTOS -->
            <div style="display: flex; flex-direction: column; gap: 20px;">
                <!-- PHOTO INJECTORS -->
                <div class="b-card" style="margin-bottom:0">
                    <div class="b-section-title">📸 PLAYER PHOTOS</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:12px">
                        <div style="text-align:center">
                            <div style="position:relative">
                                <div id="preview_striker" onclick="triggerManualPhoto('striker')" style="width:100%; height:75px; background:rgba(59,130,246,0.07); border:2px dashed rgba(59,130,246,0.4); border-radius:12px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:0.2s">📷</div>
                                <button type="button" title="Hide on overlay" onclick="event.stopPropagation();clearPlayerPhotoSlot('striker')" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:#e53935;color:#fff;font-size:11px;font-weight:900;cursor:pointer;z-index:2">×</button>
                            </div>
                            <div style="font-size:9px; font-weight:900; margin-top:6px; color:#3b82f6; text-transform:uppercase">Striker</div>
                        </div>
                        <div style="text-align:center">
                            <div style="position:relative">
                                <div id="preview_nonstriker" onclick="triggerManualPhoto('nonstriker')" style="width:100%; height:75px; background:rgba(244,63,94,0.07); border:2px dashed rgba(244,63,94,0.4); border-radius:12px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:0.2s">📷</div>
                                <button type="button" title="Hide on overlay" onclick="event.stopPropagation();clearPlayerPhotoSlot('nonstriker')" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:#e53935;color:#fff;font-size:11px;font-weight:900;cursor:pointer;z-index:2">×</button>
                            </div>
                            <div style="font-size:9px; font-weight:900; margin-top:6px; color:#f43f5e; text-transform:uppercase">Non-Str</div>
                        </div>
                        <div style="text-align:center">
                            <div style="position:relative">
                                <div id="preview_bowler" onclick="triggerManualPhoto('bowler')" style="width:100%; height:75px; background:rgba(139,92,246,0.07); border:2px dashed rgba(139,92,246,0.4); border-radius:12px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:0.2s">📷</div>
                                <button type="button" title="Hide on overlay" onclick="event.stopPropagation();clearPlayerPhotoSlot('bowler')" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:#e53935;color:#fff;font-size:11px;font-weight:900;cursor:pointer;z-index:2">×</button>
                            </div>
                            <div style="font-size:9px; font-weight:900; margin-top:6px; color:#8b5cf6; text-transform:uppercase">Bowler</div>
                        </div>
                    </div>
                    <input type="file" id="manual-photo-input" style="display:none" accept="image/*" onchange="onManualPhotoSelected(event)">
                </div>

                <!-- MATCH STATS OVERLAYS -->
                <div class="b-card" style="margin-bottom:0">
                    <div class="b-section-title">📊 DATA OVERLAYS</div>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                        <button class="b-btn b-btn-primary" onclick="if(typeof Broadcast !== 'undefined') Broadcast.showRunsNeeded(); else sendBroadcast('SHOW_RUNS_BALLS')">
                            <div class="b-btn-title">🚀 NEEDED</div>
                            <div class="b-btn-sub">S+R</div>
                        </button>
                        <button class="b-btn b-btn-emerald" onclick="if(typeof Broadcast !== 'undefined') Broadcast.showCRR(); else sendBroadcast('SHOW_CRR')">
                            <div class="b-btn-title">📈 RRATE</div>
                            <div class="b-btn-sub">S+C</div>
                        </button>
                        <button class="b-btn" style="min-height:50px;background:linear-gradient(135deg,#0d4d2e,#1b6b3a);border:1px solid rgba(255,255,255,0.15);color:#fff;grid-column:1/-1" onclick="showLastWicketBroadcast()">
                            <div class="b-btn-title">🎯 LAST WICKET</div>
                            <div class="b-btn-sub">Shift+O — last out + stats (blue/silver card)</div>
                        </button>
                        <button class="b-btn b-btn-purple" onclick="if(typeof Broadcast !== 'undefined') Broadcast.showScorecard(); else sendBroadcast('SHOW_SCORECARD')">
                            <div class="b-btn-title">📄 CARD</div>
                            <div class="b-btn-sub">S+S</div>
                        </button>
                        <button class="b-btn b-btn-amber" onclick="if(typeof Broadcast !== 'undefined') Broadcast.showSummary(); else sendBroadcast('SHOW_SUMMARY')">
                            <div class="b-btn-title">🏆 SUMRY</div>
                            <div class="b-btn-sub">S+T</div>
                        </button>
                    </div>
                </div>

                <!-- TEAM ROSTER EDITOR -->
                <div class="b-card" style="margin-bottom:0; border:1px solid rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.05);">
                    <div class="b-section-title" style="color: #60a5fa;">📋 TEAM ROSTERS</div>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                        <button class="b-btn b-btn-slate" style="min-height:50px; border-color:rgba(255,255,255,0.1)" onclick="openFullScreenRoster(0)">
                            <div class="b-btn-title" style="font-size:10px">${match.team1}</div>
                            <div class="b-btn-sub">EDIT ROSTER</div>
                        </button>
                        <button class="b-btn b-btn-slate" style="min-height:50px; border-color:rgba(255,255,255,0.1)" onclick="openFullScreenRoster(1)">
                            <div class="b-btn-title" style="font-size:10px">${match.team2}</div>
                            <div class="b-btn-sub">EDIT ROSTER</div>
                        </button>
                    </div>
                </div>

                <!-- PROMO / NEXT MATCH -->
                <div class="b-card" style="margin-bottom:0">
                    <div class="b-section-title">📺 PROMOTIONS</div>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="next-teama" placeholder="Team A" value="TEAM A" style="flex:1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; color: white; font-weight: 700; font-size: 11px; text-align: center;">
                            <input type="text" id="next-teamb" placeholder="Team B" value="TEAM B" style="flex:1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; color: white; font-weight: 700; font-size: 11px; text-align: center;">
                        </div>
                        <button class="b-btn b-btn-primary" style="width: 100%; align-items: center; justify-content: center; min-height: 45px;"
                                onclick="const a=document.getElementById('next-teama').value; const b=document.getElementById('next-teamb').value; sendBroadcast('SHOW_NEXT_MATCH', { teamA: a, teamB: b }); showToast('📺 Animation Published!', 'success');">
                            <div class="b-btn-title">NEXT MATCH PREVIEW</div>
                        </button>
                    </div>
                </div>

                <button onclick="window.close()" style="margin-top:20px; width: 100%; background: transparent; border: 1px solid rgba(255,255,255,0.05); color: rgba(255,255,255,0.2); padding: 12px; border-radius: 12px; cursor: pointer; font-weight: 800; font-size: 10px; text-transform: uppercase; letter-spacing: 1px;">Terminate Broadcast Session</button>
            </div>
            
        </div>
    </div>
    <style>
        @keyframes pulse {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.2); opacity: 0.5; }
            100% { transform: scale(1); opacity: 1; }
        }
    </style>
    `;

    // Integrated hotkey helper
    if (typeof setupIntegratedHotkeys === 'function') {
        // Ensure global hotkeys are active and recognize we are in Master Control mode
        document.body.classList.add('broadcast-controller-active');
    }

    // Scaling Preview Logic (Replaced innerHTML script with real JS)
    const frame = document.getElementById('broadcast-preview-frame');
    const container = document.getElementById('broadcast-preview-container');
    const scalePreview = () => {
        if (!frame || !container) return;
        const scaleVal = container.offsetWidth / 1920;
        frame.style.transform = 'scale(' + scaleVal + ')';
    };
    window.addEventListener('resize', scalePreview);
    setTimeout(scalePreview, 300);
    setInterval(scalePreview, 1500);

    // Submode visibility logic
    const themeSelect = document.getElementById('scorebar-style-select');
    const submodeContainer = document.getElementById('submode-controls');
    if (themeSelect && submodeContainer) {
        themeSelect.addEventListener('change', function() {
            submodeContainer.style.display = (this.value === 'theme4') ? 'block' : 'none';
        });
    }


    // Dynamic Live Sync Function
    const updatePreviewSync = (m) => {
        // 1. Sync to iframe preview
        const frame = document.getElementById('broadcast-preview-frame');
        if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage({ 
                type: 'cricpro_broadcast_cmd', 
                payload: { cmd: 'SYNC_SCORE', data: { match: m } } 
            }, '*');
        }
    };

    // Listen for Sync Requests from remote TV/OBS
    if (typeof socket !== 'undefined' && socket) {
        socket.on('request_sync', (data) => {
            const m = currentMatch;
            if (data && m && (data.matchId === m.id || (data.tournId && data.tournId === m.tournamentId))) {
                console.log('📡 Received Sync Request from TV/OBS, responding...');
                sendBroadcast('SYNC_SCORE', { match: m });
            }
        });
    }

    // Auto-sync state (Real-Time Socket + Polling Fallback)
    if (typeof socket !== 'undefined' && socket) {
        socket.on('scoreUpdate', (updatedData) => {
            if (updatedData.id === match.id) {
                currentMatch = updatedData;
                updatePreviewSync(updatedData);
            }
        });
    }

    const syncInterval = setInterval(async () => {
        if (document.hidden) return;
        const activeMatch = DB.getMatch(match.id);
        if (activeMatch) {
            currentMatch = activeMatch;
            updatePreviewSync(activeMatch);
        }
    }, 3000);
    window._broadcastSyncInterval = syncInterval;

    // Initial Sync
    setTimeout(() => updatePreviewSync(match), 500);

    // JOIN REAL-TIME ROOM
    if (typeof socket !== 'undefined' && socket) {
        socket.emit('join_match', match.id);
        console.log('📡 Remote Controller Joined:', match.id);
    }

    // Manual Photo Override Logic
    window._pendingManualPhotoType = null;
    window.triggerManualPhoto = function(type) {
        window._pendingManualPhotoType = type;
        document.getElementById('manual-photo-input').click();
    };

    window.compressImageUtility = function(file, callback) {
        if (!file) { callback(null); return; }
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 600;
                const MAX_HEIGHT = 600;
                let width = img.width;
                let height = img.height;
                
                if (width > height) {
                    if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                } else {
                    if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
                }
                
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                callback(dataUrl);
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    };

    window.onManualPhotoSelected = function(e) {
        const file = e.target.files[0];
        if (!file || !window._pendingManualPhotoType) return;
        
        window.compressImageUtility(file, (data) => {
            if (!data) return;
            try {
                const m = currentMatch;
                const inn = m ? m.innings[m.currentInnings] : null;

                if (window._pendingManualPhotoType === 'striker') {
                    window.__photo_cleared_striker = false;
                    window.__photo_striker = data;
                    const el = document.getElementById('preview_striker');
                    if(el) el.innerHTML = `<img src="${data}" style="width:100%; height:100%; object-fit:contain; border-radius:10px">`;
                    
                    if (inn) {
                        const strikerName = getStrikerBatterName(inn);
                        const p = resolvePlayerProfileForBatter(inn, strikerName);
                        if (p && p.playerId) { 
                            DB.updatePlayer({ ...p, photo: data }); 
                            showToast(`Saved photo to ${p.name || 'Striker'}`, 'success'); 
                        }
                    }
                } else if (window._pendingManualPhotoType === 'nonstriker') {
                    window.__photo_cleared_nonstriker = false;
                    window.__photo_nonstriker = data;
                    const el = document.getElementById('preview_nonstriker');
                    if(el) el.innerHTML = `<img src="${data}" style="width:100%; height:100%; object-fit:contain; border-radius:10px">`;
                    
                    if (inn) {
                        const nonStrikerIdx = (inn.strikerIdx === 0) ? inn.currentBatsmenIdx[1] : inn.currentBatsmenIdx[0];
                        const nonStrikerB = inn.batsmen[nonStrikerIdx];
                        if (nonStrikerB && nonStrikerB.name) {
                            const p = resolvePlayerProfileForBatter(inn, nonStrikerB.name);
                            if (p && p.playerId) { 
                                DB.updatePlayer({ ...p, photo: data }); 
                                showToast(`Saved photo to ${p.name || 'Non-Striker'}`, 'success'); 
                            }
                        }
                    }
                } else if (window._pendingManualPhotoType === 'bowler') {
                    window.__photo_cleared_bowler = false;
                    window.__photo_bowler = data;
                    const el = document.getElementById('preview_bowler');
                    if(el) el.innerHTML = `<img src="${data}" style="width:100%; height:100%; object-fit:contain; border-radius:10px">`;
                    
                    if (inn) {
                        const bowler = inn.bowlers[inn.currentBowlerIdx];
                        let p = null;
                        if (bowler && bowler.playerId) p = DB.getPlayerById(bowler.playerId);
                        if (p && p.playerId) { 
                            DB.updatePlayer({ ...p, photo: data }); 
                            showToast(`Saved photo to ${p.name || 'Bowler'}`, 'success'); 
                        }
                    }
                }
                if (m && typeof syncLivePlayerPhotoSlots === 'function') syncLivePlayerPhotoSlots(m);
            } catch (err) {
                console.error("Photo Error:", err);
                showToast('Failed to apply photo', 'error');
            }
        });
    };

    if (typeof syncLivePlayerPhotoSlots === 'function') syncLivePlayerPhotoSlots(match);

    window.overrideLiveScore = function() {
        const m = currentMatch;
        if (!m || !m.innings) return;
        const curInn = m.innings[m.currentInnings || 0];

        const rVal = document.getElementById('manual-run').value;
        const wVal = document.getElementById('manual-wkt').value;
        
        if (rVal !== '') curInn.runs = parseInt(rVal) || 0;
        if (wVal !== '') curInn.wickets = parseInt(wVal) || 0;
        
        if (typeof DB !== 'undefined' && DB.saveMatch) {
            DB.saveMatch(m);
        }
        updatePreviewSync(m);
        showToast('Live Score Forced!', 'success');
        document.getElementById('manual-run').value = '';
        document.getElementById('manual-wkt').value = '';
    };
}

// ─── INTEGRATED HOTKEY SYSTEM ───
function isBroadcastHotkeyContext() {
    if (document.body.classList.contains('broadcast-controller-active')) return true;
    if (document.body.classList.contains('hotkey-panel-active')) return true;
    const panel = document.getElementById('panel-hotkeys');
    if (!panel) return false;
    return window.getComputedStyle(panel).display !== 'none';
}

function hotkeyShouldIgnoreTarget(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
    if (e.shiftKey && isBroadcastHotkeyContext()) return false;
    return true;
}

function runBroadcastHotkey(fn) {
    const m = currentMatch || window.currentMatch;
    if (!m) {
        if (typeof showToast === 'function') {
            showToast('Open a live match first (Hotkeys tab needs active match)', 'error');
        }
        return;
    }
    if (!currentMatch && window.currentMatch) currentMatch = window.currentMatch;
    if (typeof syncLivePlayerPhotoSlots === 'function') syncLivePlayerPhotoSlots(m);
    fn();
}

function fireProfileBroadcast(role) {
    const m = currentMatch || window.currentMatch;
    if (!m) {
        showToast('No active match', 'error');
        return;
    }
    if (!currentMatch && window.currentMatch) currentMatch = window.currentMatch;
    if (typeof syncLivePlayerPhotoSlots === 'function') syncLivePlayerPhotoSlots(m);
    if (role === 'striker') {
        if (typeof Broadcast !== 'undefined' && Broadcast.broadcastStrikerProfile) {
            Broadcast.broadcastStrikerProfile();
        } else {
            broadcastStrikerProfile();
        }
    } else if (role === 'nonstriker') {
        if (typeof Broadcast !== 'undefined' && Broadcast.broadcastNonStrikerProfile) {
            Broadcast.broadcastNonStrikerProfile();
        } else {
            broadcastNonStrikerProfile();
        }
    } else if (role === 'bowler') {
        if (typeof Broadcast !== 'undefined' && Broadcast.broadcastBowlerProfile) {
            Broadcast.broadcastBowlerProfile();
        } else {
            broadcastBowlerProfile();
        }
    }
}
window.fireProfileBroadcast = fireProfileBroadcast;

// Centralized hotkey listener for production & scoring
function setupIntegratedHotkeys() {
    if (window._integratedHotkeysBound) return;
    window._integratedHotkeysBound = true;

    document.addEventListener(
        'keydown',
        (e) => {
            if (hotkeyShouldIgnoreTarget(e)) return;

            const code = e.code;
            const isMasterControl = isBroadcastHotkeyContext();

            if (!e.shiftKey && !e.ctrlKey && !e.altKey) {
                let handled = true;
                if (code === 'Digit4' || code === 'Numpad4') {
                    if (isMasterControl) runBroadcastHotkey(() => triggerVisualBigEvent('FOUR'));
                    else recordBall({ type: 'four', runs: 4 });
                } else if (code === 'Digit6' || code === 'Numpad6') {
                    if (isMasterControl) runBroadcastHotkey(() => triggerVisualBigEvent('SIX'));
                    else recordBall({ type: 'six', runs: 6 });
                } else if (code === 'KeyW') {
                    if (isMasterControl) runBroadcastHotkey(() => triggerVisualBigEvent('WICKET'));
                    else openWicketModal();
                } else if (code === 'Digit0' || code === 'Numpad0') {
                    if (!isMasterControl) recordBall({ type: 'dot', runs: 0 });
                    else handled = false;
                } else if (code === 'Escape') {
                    if (typeof Broadcast !== 'undefined') Broadcast.stopAll();
                    else sendBroadcast('STOP_ALL');
                } else {
                    handled = false;
                }
                if (handled) e.preventDefault();
            }

            if (e.shiftKey && !e.ctrlKey && !e.altKey) {
                let handled = true;
                switch (code) {
                    case 'KeyB':
                        runBroadcastHotkey(() => fireProfileBroadcast('striker'));
                        break;
                    case 'KeyN':
                        runBroadcastHotkey(() => fireProfileBroadcast('nonstriker'));
                        break;
                    case 'KeyP':
                        runBroadcastHotkey(() =>
                            typeof Broadcast !== 'undefined' && Broadcast.broadcastCurrentBatters
                                ? Broadcast.broadcastCurrentBatters()
                                : broadcastCurrentBatters()
                        );
                        break;
                    case 'KeyH':
                        runBroadcastHotkey(() => {
                            if (typeof Broadcast !== 'undefined' && Broadcast.broadcastPartnership) {
                                Broadcast.broadcastPartnership();
                            } else {
                                broadcastPartnership();
                            }
                        });
                        break;
                    case 'KeyL':
                        runBroadcastHotkey(() => fireProfileBroadcast('bowler'));
                        break;
                    case 'KeyG':
                        runBroadcastHotkey(() =>
                            typeof Broadcast !== 'undefined' && Broadcast.broadcastBattingTeamSquad
                                ? Broadcast.broadcastBattingTeamSquad()
                                : broadcastBattingTeamSquad()
                        );
                        break;
                    case 'KeyK':
                        runBroadcastHotkey(() => broadcastTeamCard(0));
                        break;
                    case 'KeyJ':
                        runBroadcastHotkey(() => broadcastTeamCard(1));
                        break;
                    case 'KeyS':
                        runBroadcastHotkey(() =>
                            typeof Broadcast !== 'undefined'
                                ? Broadcast.showScorecard()
                                : sendBroadcast('SHOW_SCORECARD')
                        );
                        break;
                    case 'KeyR':
                        runBroadcastHotkey(() =>
                            typeof Broadcast !== 'undefined'
                                ? Broadcast.showRunsNeeded()
                                : sendBroadcast('SHOW_RUNS_BALLS')
                        );
                        break;
                    case 'KeyC':
                        runBroadcastHotkey(() =>
                            typeof Broadcast !== 'undefined' ? Broadcast.showCRR() : sendBroadcast('SHOW_CRR')
                        );
                        break;
                    case 'KeyO':
                        runBroadcastHotkey(() => showLastWicketBroadcast());
                        break;
                    case 'KeyT':
                        runBroadcastHotkey(() =>
                            typeof Broadcast !== 'undefined'
                                ? Broadcast.showSummary()
                                : sendBroadcast('SHOW_SUMMARY')
                        );
                        break;
                    case 'KeyV':
                        runBroadcastHotkey(() =>
                            typeof Broadcast !== 'undefined'
                                ? Broadcast.toggleScorebar()
                                : sendBroadcast('TOGGLE_SCOREBAR')
                        );
                        break;
                    default:
                        handled = false;
                }
                if (handled) e.preventDefault();
            }
        },
        true
    );
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    setupIntegratedHotkeys();
});

function forceEndMatchInHub(mId) {
    if (!confirm('🛑 Danger: Officially end this match NOW? This will freeze the score and update standings.')) return;
    const m = DB.getMatch(mId);
    if (!m) return;
    m.status = 'completed';
    m.completedAt = Date.now();
    if (!m.result) m.result = 'End Match forced via Hub';
    const i0 = m.innings?.[0];
    const i1 = m.innings?.[1];
    if (!m.winner && i0 && i1) {
        if (i1.runs > i0.runs) m.winner = i1.battingTeam || m.team2;
        else if (i1.runs < i0.runs) m.winner = i0.battingTeam || m.team1;
    }
    DB.saveMatch(m);
    
    // Recalculate tournament standings
    if (m.tournamentId) {
        const t = DB.getTournament(m.tournamentId);
        if (t && t.format !== 'knockout') {
            if (typeof window.computeTournamentStandings === 'function') {
                window.computeTournamentStandings(t);
            } else if (typeof computeStandings === 'function') {
                computeStandings(t);
                DB.saveTournament(t);
            }
        }
    }
    try {
        localStorage.setItem('cricpro_force_update', Date.now().toString());
    } catch (_) {}
    if (typeof renderTournamentMatches === 'function') renderTournamentMatches();
    showToast('🛑 Match marked as completed.', 'success');
}

// ========== EMBEDDED FULL SCORECARD ==========
function renderEmbeddedScorecard(innIdx = 0) {
    const m = currentMatch;
    if (!m) return;
    
    // If innIdx is invalid, default to current innings
    if (!m.innings[innIdx]) innIdx = m.currentInnings;
    const inn = m.innings[innIdx];
    
    const btn0 = document.getElementById('btn-inn-0');
    const btn1 = document.getElementById('btn-inn-1');
    if(btn0) btn0.className = (innIdx === 0) ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
    if(btn1) btn1.className = (innIdx === 1) ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
    
    const contentDiv = document.getElementById('embedded-scorecard-content');
    if (!contentDiv) return;
    
    if (!inn || inn.runs === undefined) {
        contentDiv.innerHTML = '<div style="text-align:center;color:gray;padding:20px;">Innings not started yet</div>';
        return;
    }
    
    // Get full roster to show 11 players
    let roster = [];
    let t = m.tournamentId ? DB.getTournament(m.tournamentId) : m;
    if (t && t.rosters && t.rosters[inn.battingTeam]) {
        roster = t.rosters[inn.battingTeam];
    }
    
    let battedPlayers = inn.batsmen || [];
    let allPlayersList = [];
    
    if (roster.length > 0) {
        roster.forEach(r => {
            if(!r) return;
            const pObj = resolveRosterPlayer(r);
            let pName = pObj?.name || r;
            let pId = null;
            if (pObj?.playerId) pId = pObj.playerId;
            
            let batted = battedPlayers.find(b => (b.playerId && b.playerId === pId) || (b.name && b.name.toLowerCase() === pName.toLowerCase()));
            if (batted) {
                allPlayersList.push(batted);
            } else {
                allPlayersList.push({ name: pName, playerId: pId, didNotBat: true });
            }
        });
    } else {
        allPlayersList = battedPlayers;
    }
    
    // Append any batted players that were somehow not in the roster
    battedPlayers.forEach(b => {
        if (!allPlayersList.find(a => (a.playerId && a.playerId === b.playerId) || (a.name && a.name.toLowerCase() === b.name.toLowerCase()))) {
            allPlayersList.push(b);
        }
    });

    const ex = inn.extras || {};
    const totalEx = (ex.wides || 0) + (ex.noBalls || 0) + (ex.byes || 0) + (ex.legByes || 0);

    let html = `
      <div style="font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-muted);margin-bottom:10px;font-size:12px; display:flex; justify-content:space-between">
        <span>${innIdx === 0 ? '1st' : '2nd'} Innings – ${inn.battingTeam}</span>
        <span style="color:#fff;font-size:16px">${inn.runs}/${inn.wickets} (${formatOvers(inn.balls, m.ballsPerOver)} ov)</span>
      </div>
      <table class="data-table" style="margin-bottom:16px">
        <thead><tr><th>Batsman</th><th>How Out</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
        <tbody>
          ${allPlayersList.map(b => `<tr>
            <td><strong style="cursor:pointer; color:#7ecbff" onclick="showPlayerProfile('${b.playerId || ''}', '${escapeHTML(b.name)}')">${b.name}</strong></td>
            <td style="font-size:12px;color:var(--c-muted)">${b.didNotBat ? 'did not bat' : (b.dismissal || (b.notOut ? 'not out' : 'not out'))}</td>
            <td><strong>${b.didNotBat ? '-' : (b.runs || 0)}</strong></td>
            <td>${b.didNotBat ? '-' : (b.balls || 0)}</td>
            <td>${b.didNotBat ? '-' : (b.fours || 0)}</td>
            <td>${b.didNotBat ? '-' : (b.sixes || 0)}</td>
            <td>${b.didNotBat ? '-' : formatSR(b.runs || 0, b.balls || 0)}</td>
          </tr>`).join('')}
          <tr style="border-top:1px solid var(--c-border)">
            <td colspan="2" style="color:var(--c-muted)">Extras (${totalEx})</td>
            <td colspan="5" style="font-size:12px;color:var(--c-muted)">
              Wd:${ex.wides || 0} Nb:${ex.noBalls || 0} By:${ex.byes || 0} Lb:${ex.legByes || 0}
            </td>
          </tr>
        </tbody>
      </table>
      <table class="data-table">
        <thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead>
        <tbody>
          ${(inn.bowlers || []).map(b => `<tr>
            <td><strong style="cursor:pointer; color:#7ecbff" onclick="showPlayerProfile('${b.playerId || ''}', '${escapeHTML(b.name)}')">${b.name}</strong></td>
            <td>${formatOvers(b.balls || 0, m.ballsPerOver)}</td><td>${b.maidens || 0}</td>
            <td>${b.runs || 0}</td><td><strong>${b.wickets || 0}</strong></td>
            <td>${formatEcon(b.runs || 0, b.balls || 0, m.ballsPerOver)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${inn.fallOfWickets && inn.fallOfWickets.length ? `
      <div style="margin-top:10px;font-size:12px">
        <span style="color:var(--c-muted);font-weight:700">FOW: </span>
        ${inn.fallOfWickets.map((fw, j) => `${j + 1}-${fw.runs} (${fw.batsmanName}, ${formatOvers(fw.balls, m.ballsPerOver)} ov)`).join(', ')}
      </div>`: ''}
    `;

    contentDiv.innerHTML = html;
}

// ========== PLAYER PROFILE POPUP ==========
let currentPlayerProfileId = null;
let currentProfileTempPhoto = null;

window.showPlayerProfile = function(playerId, defaultName) {
    let p = null;
    if (playerId) p = DB.getPlayerById(playerId);
    if (!p && defaultName) {
        p = DB.getPlayers().find(x => x.name.toLowerCase() === defaultName.toLowerCase());
    }

    currentPlayerProfileId = p ? p.playerId : null;
    currentProfileTempPhoto = null;

    document.getElementById('pp-name').value = p ? p.name : (defaultName || '');
    document.getElementById('pp-name').readOnly = true;
    document.getElementById('pp-team').value = p && p.team ? p.team : (currentMatch ? currentMatch.team1 : 'Unknown Team');
    document.getElementById('pp-team').readOnly = true;
    
    if (p && p.photo) {
        document.getElementById('pp-photo').src = p.photo;
        document.getElementById('pp-photo').style.display = 'block';
        document.getElementById('pp-photo-placeholder').style.display = 'none';
    } else {
        document.getElementById('pp-photo').style.display = 'none';
        document.getElementById('pp-photo-placeholder').style.display = 'flex';
    }

    // Reset view
    document.getElementById('pp-name').style.border = "none";
    document.getElementById('pp-name').style.background = "transparent";
    document.getElementById('pp-team').style.border = "none";
    document.getElementById('pp-team').style.background = "transparent";
    
    document.getElementById('pp-view-actions').style.display = 'grid';
    document.getElementById('pp-edit-actions').style.display = 'none';

    // File upload handler
    document.getElementById('pp-photo-upload').onchange = function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(evt) {
                currentProfileTempPhoto = evt.target.result;
                document.getElementById('pp-photo').src = currentProfileTempPhoto;
                document.getElementById('pp-photo').style.display = 'block';
                document.getElementById('pp-photo-placeholder').style.display = 'none';
            }
            reader.readAsDataURL(file);
        }
    };

    openModal('modal-player-profile');
};

window.enablePlayerProfileEdit = function() {
    document.getElementById('pp-name').readOnly = false;
    document.getElementById('pp-name').style.border = "1px solid var(--c-border)";
    document.getElementById('pp-name').style.background = "rgba(255,255,255,0.05)";
    
    document.getElementById('pp-team').readOnly = false;
    document.getElementById('pp-team').style.border = "1px solid var(--c-border)";
    document.getElementById('pp-team').style.background = "rgba(255,255,255,0.05)";

    document.getElementById('pp-view-actions').style.display = 'none';
    document.getElementById('pp-edit-actions').style.display = 'grid';
};

window.savePlayerProfile = function() {
    const newName = document.getElementById('pp-name').value.trim();
    const newTeam = document.getElementById('pp-team').value.trim();

    if (!newName) return showToast('Name is required', 'error');

    let p = null;
    let oldName = null;
    if (currentPlayerProfileId) {
        p = DB.getPlayerById(currentPlayerProfileId);
        oldName = p.name;
    } else {
        p = { playerId: 'P' + Date.now() + Math.floor(Math.random()*1000) };
    }

    p.name = newName;
    p.team = newTeam;
    if (currentProfileTempPhoto) {
        p.photo = currentProfileTempPhoto;
    }

    DB.updatePlayer(p);
    
    // Global update across match state
    if (currentMatch) {
        let updated = false;
        currentMatch.innings.forEach(inn => {
            if(!inn) return;
            inn.batsmen.forEach(b => {
                if (b.playerId === p.playerId || (oldName && b.name === oldName)) {
                    b.name = newName; b.playerId = p.playerId; updated = true;
                }
            });
            inn.bowlers.forEach(b => {
                if (b.playerId === p.playerId || (oldName && b.name === oldName)) {
                    b.name = newName; b.playerId = p.playerId; updated = true;
                }
            });
        });

        // Update roster
        const t = currentMatch.tournamentId ? DB.getTournament(currentMatch.tournamentId) : currentMatch;
        if (t && t.rosters) {
             Object.keys(t.rosters).forEach(team => {
                 let arr = t.rosters[team];
                 for(let i=0; i<arr.length; i++) {
                     if (arr[i] === p.playerId || (oldName && arr[i] === oldName)) {
                         arr[i] = p.playerId; 
                     }
                 }
             });
             DB.saveTournament(t);
        }

        if (updated) {
            saveAndRender();
        }
    }
    
    // Broadcast for TV overlay update
    if (typeof sendBroadcast === 'function') sendBroadcast('FORCE_UPDATE');
    
    showToast('Player Profile Updated Live!', 'success');
    closeModal('modal-player-profile');
    
    // Re-render embedded scorecard if we are viewing it
    renderEmbeddedScorecard(currentMatch.currentInnings);
};

// ============================================================
//  FULL SCREEN ROSTER MANAGEMENT (FSR) — exports
// ============================================================
window.openFullScreenRoster = function (teamIndex) {
    const m = currentMatch;
    if (!m) return;
    _fsrCurrentTeamIndex = teamIndex;
    editingTeamName = teamIndex === 0 ? m.team1 : m.team2;
    if (m.tournamentId) {
        const t = DB.getTournament(m.tournamentId);
        if (t) currentTournament = t;
    }
    openRosterEditor(editingTeamName);
};

window.closeFullScreenRoster = closeFullScreenRoster;
window.saveRosterFromFS = saveRosterFromFS;
window.onFSRPlayerPhotoClick = onFSRPlayerPhotoClick;
window.onFSRPlayerNameChange = onFSRPlayerNameChange;
window.onFSRPlayerPhotoSelected = onFSRPlayerPhotoSelected;
window.onFSRTeamPhotoSelected = onFSRTeamPhotoSelected;
window.addRosterSlotFS = addRosterSlotFS;
window.applySquadNameInput = applySquadNameInput;
window.pickSquadBowlerName = pickSquadBowlerName;
window.populateSquadDatalist = populateSquadDatalist;
window.renderSquadQuickPick = renderSquadQuickPick;
window.pickSquadBatsmanName = pickSquadBatsmanName;
window.ensurePlayerOnTeamRoster = ensurePlayerOnTeamRoster;
window.triggerFSRPhoto = function (slotId) {
    window._fsrActivePhotoTarget = slotId;
    document.getElementById('fsr-player-photo-input')?.click();
};

window.publishPlayerProfileToBroadcast = function() {
    const pId = currentPlayerProfileId;
    if (!pId) return showToast('No player profile selected', 'error');
    
    const p = DB.getPlayerById(pId);
    if (!p) return showToast('Player data not found', 'error');
    
    // Get latest stats
    const m = currentMatch;
    let stats = { runs: 0, balls: 0, sixes: 0, wickets: 0 };
    
    if (m) {
        m.innings.forEach(inn => {
            if (!inn) return;
            const b = inn.batsmen.find(bx => bx.playerId === pId);
            if (b) {
                stats.runs += (b.runs || 0);
                stats.balls += (b.balls || 0);
                stats.sixes += (b.sixes || 0);
            }
            const bl = inn.bowlers.find(blx => blx.playerId === pId);
            if (bl) {
                stats.wickets += (bl.wickets || 0);
            }
        });
    }

    const payload = {
        name: p.name,
        profile: { ...p, photo: DB.getPlayerPhoto(pId) },
        stats: stats
    };
    
    if (typeof sendBroadcast === 'function') {
        // Send as striker profile by default (it uses the same graphic)
        sendBroadcast('SHOW_STRIKER_PROFILE', payload);
        showToast('📺 Publishing Profile to Broadcast...', 'success');
        closeModal('modal-player-profile');
    }
};

// Expose for desktop popup / IPC scoring bridge
window.applyDesktopMatchSnapshot = applyDesktopMatchSnapshot;
window.recordBall = recordBall;
window.recordExtra = recordExtra;
window.openWicketModal = openWicketModal;
window.undoAction = undoAction;
window.swapBatsmenEnds = swapBatsmenEnds;
window.loadMatch = loadMatch;
window.renderScoring = renderScoring;
