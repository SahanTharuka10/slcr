/**
 * Match Draw — open builder / preview from score-match tournament & hotkeys.
 */
(function (global) {
    'use strict';

    const STORAGE_PREFIX = 'cricpro_match_draw_';
    const IMPORT_PREFIX = 'cricpro_match_draw_import_';

    function getMatchDrawTournamentId() {
        if (typeof currentTournament !== 'undefined' && currentTournament?.id) {
            return currentTournament.id;
        }
        if (typeof currentMatch !== 'undefined' && currentMatch?.tournamentId) {
            return currentMatch.tournamentId;
        }
        if (typeof getActiveRosterRoot === 'function') {
            const root = getActiveRosterRoot();
            if (root?.id) return root.id;
        }
        return 'default';
    }

    function collectTournamentTeamNames() {
        const root = typeof getActiveRosterRoot === 'function' ? getActiveRosterRoot() : null;
        if (!root) return [];
        if (Array.isArray(root.teams) && root.teams.length) {
            return root.teams.filter(Boolean).map((n) => String(n).trim()).filter(Boolean);
        }
        return [root.team1, root.team2].filter(Boolean).map((n) => String(n).trim());
    }

    function hasSavedDraw(tournamentId) {
        const tid = tournamentId || getMatchDrawTournamentId();
        try {
            if (localStorage.getItem(STORAGE_PREFIX + tid)) return true;
            if (typeof currentMatch !== 'undefined' && currentMatch?.id &&
                localStorage.getItem(STORAGE_PREFIX + 'match-' + currentMatch.id)) return true;
        } catch (_) { /* ignore */ }
        const st = getMatchDrawState(tid);
        return !!(st && ((st.teams && st.teams.length) || (st.slots && Object.keys(st.slots).length)));
    }

    function getMatchDrawState(tournamentId) {
        const tid = tournamentId || getMatchDrawTournamentId();
        try {
            if (typeof currentMatch !== 'undefined' && currentMatch?.id) {
                const mk = localStorage.getItem(STORAGE_PREFIX + 'match-' + currentMatch.id);
                if (mk) return JSON.parse(mk);
            }
            const raw = localStorage.getItem(STORAGE_PREFIX + tid);
            if (raw) return JSON.parse(raw);
        } catch (_) { /* ignore */ }
        if (typeof DB !== 'undefined' && tid && tid !== 'default') {
            const t = DB.getTournament(tid);
            if (t?.matchDraw) return t.matchDraw;
            if (typeof currentMatch !== 'undefined' && currentMatch?.matchDraw) {
                return currentMatch.matchDraw;
            }
        }
        return null;
    }

    function saveMatchDrawState(drawState) {
        const tid = getMatchDrawTournamentId();
        const payload = Object.assign({}, drawState, {
            savedAt: Date.now(),
            tournamentId: tid,
        });
        try {
            localStorage.setItem(STORAGE_PREFIX + tid, JSON.stringify(payload));
            if (typeof currentMatch !== 'undefined' && currentMatch?.tournamentId) {
                localStorage.setItem(STORAGE_PREFIX + currentMatch.tournamentId, JSON.stringify(payload));
            }
            if (typeof currentMatch !== 'undefined' && currentMatch?.id) {
                localStorage.setItem(STORAGE_PREFIX + 'match-' + currentMatch.id, JSON.stringify(payload));
            }
        } catch (e) { console.warn('[MatchDraw] localStorage save failed', e); }
        if (typeof DB !== 'undefined' && tid && tid !== 'default') {
            const t = DB.getTournament(tid);
            if (t) {
                t.matchDraw = payload;
                DB.saveTournament(t, true, { skipPublish: false });
            }
        }
        if (typeof currentMatch !== 'undefined' && currentMatch?.id && typeof DB !== 'undefined') {
            currentMatch.matchDraw = payload;
            DB.saveMatch(currentMatch, true, { skipPublish: false });
        }
        return payload;
    }

    function openMatchDraw() {
        const tid = getMatchDrawTournamentId();
        const teams = collectTournamentTeamNames();
        try {
            if (teams.length) {
                sessionStorage.setItem(IMPORT_PREFIX + tid, JSON.stringify(teams));
            }
        } catch (_) { /* ignore */ }
        let url = 'match-draw.html?tournament=' + encodeURIComponent(tid);
        if (typeof currentMatch !== 'undefined' && currentMatch?.id) {
            url += '&matchId=' + encodeURIComponent(currentMatch.id);
        }
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    function openMatchDrawPreview() {
        const tid = getMatchDrawTournamentId();
        if (!hasSavedDraw(tid)) {
            if (typeof showToast === 'function') {
                showToast('Save Match Draw first (editor → 💾 Save)', 'default');
            } else {
                alert('Save Match Draw first');
            }
            return;
        }
        const url = 'match-draw.html?preview=1&tournament=' + encodeURIComponent(tid);
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    /** Send saved draw full-screen to OBS / overlay */
    function shareMatchDrawOverlay() {
        const tid = getMatchDrawTournamentId();
        const draw = getMatchDrawState(tid);
        const hasContent = draw && (
            (Array.isArray(draw.teams) && draw.teams.length > 0) ||
            (draw.slots && Object.keys(draw.slots).length > 0)
        );
        if (!hasContent) {
            if (typeof showToast === 'function') {
                showToast('Save Match Draw first — open 🎯 Edit Match Draw → 💾 Save', 'default');
            } else {
                alert('Save Match Draw first');
            }
            return;
        }
        if (typeof Broadcast === 'undefined' || !Broadcast.send) {
            openMatchDrawPreview();
            return;
        }
        Broadcast.send('SHOW_MATCH_DRAW', { draw, tournamentId: tid });
        if (typeof showToast === 'function') {
            showToast('🏆 Match Draw sent to overlay (full screen)', 'success');
        }
    }

    function hideMatchDrawOverlay() {
        if (typeof Broadcast !== 'undefined' && Broadcast.send) {
            Broadcast.send('STOP_MATCH_DRAW', {});
            if (typeof showToast === 'function') showToast('Draw hidden from overlay', 'default');
        }
    }

    global.saveMatchDrawState = saveMatchDrawState;

    global.getMatchDrawTournamentId = getMatchDrawTournamentId;
    global.hasSavedDraw = hasSavedDraw;
    global.getMatchDrawState = getMatchDrawState;
    global.openMatchDraw = openMatchDraw;
    global.openMatchDrawPreview = openMatchDrawPreview;
    global.shareMatchDrawOverlay = shareMatchDrawOverlay;
    global.hideMatchDrawOverlay = hideMatchDrawOverlay;
})(typeof window !== 'undefined' ? window : global);
