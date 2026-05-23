/**
 * SLCRICKPRO – Broadcast Control Logic
 * Handles communication between Scorer and TV Display Overlay
 */

const BROADCAST_KEYS = {
    COMMAND: 'cricpro_broadcast_cmd',
    DATA: 'cricpro_broadcast_data'
};

function getBroadcastMatch() {
    if (typeof currentMatch !== 'undefined' && currentMatch) return currentMatch;
    if (window.currentMatch) return window.currentMatch;
    return null;
}

function getBroadcastTournament() {
    if (typeof currentTournament !== 'undefined' && currentTournament) return currentTournament;
    if (window.currentTournament) return window.currentTournament;
    return null;
}

function isGenericSquadPlayerName(name) {
    return /^Player\s*\d+$/i.test((name || '').trim());
}

/** Resolve roster slot → { name, playerId, photo, ... } */
function resolveSquadEntryForOverlay(entry) {
    if (entry == null || entry === '') return null;
    if (typeof entry === 'object' && entry !== null) {
        const pid = entry.playerId || entry.id || '';
        const inlineName = (entry.name || entry.playerName || '').trim();
        if (pid && typeof DB !== 'undefined' && DB.getPlayerById) {
            const byId = DB.getPlayerById(pid);
            if (byId) {
                return {
                    ...byId,
                    name: byId.name || inlineName,
                    photo: entry.photo || DB.getPlayerPhoto(byId.playerId) || '',
                };
            }
        }
        if (inlineName) return { ...entry, name: inlineName };
        return entry;
    }
    const key = String(entry).trim();
    if (!key) return null;
    if (typeof DB !== 'undefined') {
        const byId = DB.getPlayerById(key);
        if (byId) return byId;
        const byName = DB.getPlayers().find(
            (x) => x.name && x.name.trim().toLowerCase() === key.toLowerCase()
        );
        if (byName) return byName;
    }
    if (/^CP\d/i.test(key)) return { name: '', playerId: key };
    return { name: key, playerId: '' };
}

/** Full squad with photos for team lineup overlay */
function collectSquadPlayersForTeam(m, teamName) {
    if (!m || !teamName || typeof DB === 'undefined') return [];
    const players = [];
    const seen = new Set();
    const pushPlayer = (entry, idx) => {
        const resolved = resolveSquadEntryForOverlay(entry);
        if (!resolved) return;
        let name = (resolved.name || resolved.playerName || '').trim();
        if (!name && resolved.playerId) {
            const again = DB.getPlayerById(resolved.playerId);
            if (again?.name) name = again.name.trim();
        }
        if (!name || isGenericSquadPlayerName(name) || seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        const pid = resolved.playerId || resolved.id || '';
        let photo = resolved.photo || '';
        if (!photo && pid) photo = DB.getPlayerPhoto(pid) || '';
        if (!photo && name) {
            const pl = DB.getPlayers().find(
                (x) => x.name && x.name.trim().toLowerCase() === name.toLowerCase()
            );
            if (pl?.playerId) photo = DB.getPlayerPhoto(pl.playerId) || '';
        }
        players.push({
            name,
            role: resolved.role || 'Player',
            photo: photo || '',
            isCaptain: !!(resolved.captain || resolved.isCaptain || entry?.captain || entry?.isCaptain || idx === 0),
        });
    };

    const tourn = getBroadcastTournament();
    const rosterIds = tourn?.rosters?.[teamName];
    if (Array.isArray(rosterIds) && rosterIds.length) {
        rosterIds.forEach((pid, idx) => {
            if (pid === '' || pid == null) return;
            if (typeof pid === 'object' && pid !== null) {
                pushPlayer(pid, idx);
                return;
            }
            const p = DB.getPlayerById(pid);
            pushPlayer(p || { playerId: pid, name: '' }, idx);
        });
    }

    if (players.length === 0 && Array.isArray(m.rosters)) {
        const teamIdx = teamName === m.team1 ? 0 : teamName === m.team2 ? 1 : -1;
        if (teamIdx >= 0 && Array.isArray(m.rosters[teamIdx])) {
            m.rosters[teamIdx].forEach((entry, idx) => {
                if (!entry) return;
                if (typeof entry === 'object') {
                    pushPlayer(
                        {
                            name: entry.name || '',
                            playerId: entry.id || entry.playerId || '',
                            photo: entry.photo || '',
                            isCaptain: entry.isCaptain,
                        },
                        idx
                    );
                } else {
                    pushPlayer(entry, idx);
                }
            });
        }
    }

    if (players.length === 0 && tourn?.teams) {
        const teamObj = tourn.teams.find((t) => t.name === teamName);
        if (teamObj?.players) {
            teamObj.players.forEach((p, idx) => {
                const name = p.name || p;
                pushPlayer(
                    {
                        name,
                        role: p.role || 'Player',
                        playerId: p.id,
                        photo: p.id ? DB.getPlayerPhoto(p.id) : '',
                    },
                    idx
                );
            });
        }
    }

    if (players.length === 0 && Array.isArray(m.innings)) {
        m.innings.filter(Boolean).forEach((inn) => {
            if (!inn) return;
            const bat = inn.battingTeam || '';
            const bowl = inn.bowlingTeam || '';
            if (bat !== teamName && bowl !== teamName) return;
            [...(inn.batsmen || []), ...(inn.bowlers || [])].forEach((p, idx) =>
                pushPlayer(p, idx)
            );
        });
    }

    return players.slice(0, 11);
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

const BROADCAST_DEFAULT_PLAYER_PHOTO = '../assets/default-player.svg';

function getBroadcastPhotoForRole(role, player) {
    if (window[`__photo_cleared_${role}`]) return '';
    const pid = String(player?.playerId || player?.name || '');
    const bound = String(window[`__photo_bound_${role}`] || '');
    let override = '';
    if (role === 'bowler') override = window.__photo_bowler || '';
    else if (role === 'nonstriker') override = window.__photo_nonstriker || '';
    else override = window.__photo_striker || '';
    if (override && (!bound || bound === pid)) return override;
    if (player?.playerId && typeof DB !== 'undefined' && DB.getPlayerPhoto) {
        const ph = DB.getPlayerPhoto(player.playerId) || '';
        if (ph && !String(ph).includes('default-player')) return ph;
    }
    return '';
}

function getInningsPlayersForPhotoSlots(m) {
    const inn = m?.innings?.[m.currentInnings ?? 0];
    if (!inn || !inn.currentBatsmenIdx) {
        return { striker: null, nonstriker: null, bowler: null };
    }
    const sIdx = inn.currentBatsmenIdx[inn.strikerIdx ?? 0];
    const nsIdx = inn.currentBatsmenIdx[inn.strikerIdx === 0 ? 1 : 0];
    return {
        striker: sIdx != null ? inn.batsmen?.[sIdx] : null,
        nonstriker: nsIdx != null ? inn.batsmen?.[nsIdx] : null,
        bowler:
            inn.currentBowlerIdx != null ? inn.bowlers?.[inn.currentBowlerIdx] : null,
    };
}

function buildPartnershipBroadcastData(m) {
    const inn = m.innings?.[m.currentInnings ?? 0];
    if (!inn) return {};
    const b0 = inn.batsmen?.[inn.currentBatsmenIdx?.[0]];
    const b1 = inn.batsmen?.[inn.currentBatsmenIdx?.[1]];
    const p =
        inn.currentPartnership ||
        (inn.partnerships?.length
            ? inn.partnerships[inn.partnerships.length - 1]
            : null) ||
        { runs: 0, balls: 0 };
    const photo0 = getBroadcastPhotoForRole(
        inn.strikerIdx === 0 ? 'striker' : 'nonstriker',
        b0
    );
    const photo1 = getBroadcastPhotoForRole(
        inn.strikerIdx === 1 ? 'striker' : 'nonstriker',
        b1
    );
    return {
        player1: b0?.name || 'Batter 1',
        player2: b1?.name || 'Batter 2',
        player1Photo: photo0 || BROADCAST_DEFAULT_PLAYER_PHOTO,
        player2Photo: photo1 || BROADCAST_DEFAULT_PLAYER_PHOTO,
        runs: p.runs || 0,
        balls: p.balls || 0,
        wicketNumber: (inn.wickets || 0) + 1,
        battingTeam: inn.battingTeam || m.team1,
        teamName: inn.battingTeam || m.team1,
    };
}

function formatOversForProfile(balls, ballsPerOver) {
    if (typeof formatOvers === 'function') return formatOvers(balls, ballsPerOver || 6);
    const b = balls || 0;
    const per = ballsPerOver || 6;
    return `${Math.floor(b / per)}.${b % per}`;
}

function buildPlayerProfileBroadcastData(player, m, role) {
    if (!player || !m) return {};
    const inn = m.innings?.[m.currentInnings || 0];
    const isBowler = role === 'bowler';
    const teamName = isBowler
        ? inn?.bowlingTeam || m.team2
        : inn?.battingTeam || m.team1;
    const dbp =
        player.playerId && typeof DB !== 'undefined' && DB.getPlayerById
            ? DB.getPlayerById(player.playerId)
            : null;
    const cs = dbp?.stats || {};
    const careerRuns = cs.runs || 0;
    const careerBalls = cs.balls || 0;
    const innings = Math.max(1, (cs.innings || cs.matches || 1) - (cs.notOuts || 0));
    const strikeRate =
        careerBalls > 0 ? ((careerRuns / careerBalls) * 100).toFixed(1) : '—';
    const average = careerRuns > 0 ? (careerRuns / innings).toFixed(1) : '—';

    const photoRole = isBowler ? 'bowler' : role === 'nonstriker' ? 'nonstriker' : 'striker';
    const photo = getBroadcastPhotoForRole(photoRole, player);

    const tourn = getBroadcastTournament();
    const profSettings = getBroadcastProfileSettings();
    let economy = '—';
    const bowlOvers = parseFloat(cs.overs) || 0;
    if (bowlOvers > 0 && (cs.bowlingRuns || cs.bowlingRuns === 0)) {
        economy = (cs.bowlingRuns / bowlOvers).toFixed(2);
    }
    const base = {
        playerName: player.name || 'PLAYER',
        teamName: teamName || m.team1 || 'TEAM',
        playerPhoto: photo,
        profileWithData: profSettings.withData,
        careerMatches: cs.matches || 0,
        careerRuns,
        careerWickets: cs.wickets || 0,
        highScore: cs.highScore || 0,
        fifties: cs.fifties || 0,
        hundreds: cs.hundreds || 0,
        strikeRate,
        average,
        economy,
        tournamentName: m.tournamentName || tourn?.name || '',
        roleLabel: isBowler ? 'BOWLER' : role === 'nonstriker' ? 'NON-STRIKER' : 'STRIKER',
    };

    if (isBowler) {
        const overs = formatOversForProfile(player.balls, m.ballsPerOver || 6);
        return {
            ...base,
            playerRuns: player.wickets ?? 0,
            playerBalls: player.runs ?? 0,
            playerSixes: overs,
        };
    }
    return {
        ...base,
        playerRuns: player.runs ?? 0,
        playerBalls: player.balls ?? 0,
        playerSixes: player.sixes ?? 0,
    };
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

function batterToWicketOverlayEntry(bat, fw, wicketNum, isLatest) {
    const extra = computeBatterOverlayStats(bat || {});
    return {
        wicketNum,
        name: (fw?.batsmanName || bat?.name || '?').toUpperCase(),
        runs: bat?.runs ?? 0,
        balls: bat?.balls ?? 0,
        dismissal: (bat?.dismissal || fw?.wicketType || 'out').toLowerCase(),
        fours: extra.fours,
        sixes: extra.sixes,
        dots: extra.dots,
        strikeRate: extra.strikeRate,
        isLatest,
    };
}

function buildLastWicketBroadcastData(m) {
    if (!m) return null;
    const innIdx = m.currentInnings ?? 0;
    const inn = m.innings?.[innIdx];
    if (!inn) return null;

    const innNum = innIdx + 1;
    const ord =
        innNum === 1 ? '1st' : innNum === 2 ? '2nd' : innNum === 3 ? '3rd' : `${innNum}th`;
    const inningsLabel = `${ord} INNS`;
    const teamName = inn.battingTeam || m.team1 || 'TEAM';
    const teamLogo =
        (typeof DB !== 'undefined' && DB.getTeamPhoto
            ? DB.getTeamPhoto(teamName, m.tournamentId)
            : '') || '';

    const batters = [];
    const seen = new Set();

    if (Array.isArray(inn.fallOfWickets) && inn.fallOfWickets.length) {
        inn.fallOfWickets.forEach((fw, i) => {
            const key = (fw.batsmanName || '').trim().toLowerCase();
            if (!key || seen.has(key)) return;
            seen.add(key);
            const bat = inn.batsmen?.find((b) => b && b.name === fw.batsmanName) || null;
            batters.push(
                batterToWicketOverlayEntry(bat, fw, i + 1, i === inn.fallOfWickets.length - 1)
            );
        });
    }

    if (!batters.length && Array.isArray(inn.batsmen)) {
        inn.batsmen.forEach((b) => {
            if (!b || b.notOut !== false) return;
            const key = (b.name || '').trim().toLowerCase();
            if (!key || seen.has(key)) return;
            seen.add(key);
            batters.push(
                batterToWicketOverlayEntry(b, { batsmanName: b.name }, batters.length + 1, false)
            );
        });
        if (batters.length) batters[batters.length - 1].isLatest = true;
    }

    if (!batters.length) return null;

    const latest = batters[batters.length - 1];
    return {
        batters,
        focus: latest,
        inningsLabel,
        teamName,
        teamLogo,
        name: latest.name,
        runs: latest.runs,
        balls: latest.balls,
        dismissal: latest.dismissal,
        fours: latest.fours,
        sixes: latest.sixes,
        dots: latest.dots,
        strikeRate: latest.strikeRate,
    };
}

function buildTeamSquadBroadcastPayload(m, teamName) {
    const inn = m.innings?.[m.currentInnings ?? 0] || null;
    const opponent = inn
        ? (inn.battingTeam === teamName ? inn.bowlingTeam : inn.battingTeam)
        : teamName === m.team1
          ? m.team2
          : m.team1;
    const tourn = getBroadcastTournament();
    const meta = [];
    if (m.tournamentName || tourn?.name) meta.push(m.tournamentName || tourn.name);
    if (m.venue) meta.push(m.venue);
    if (m.round || m.group) meta.push(m.round || m.group);

    return {
        teamName,
        opponentName: opponent || 'OPPONENT',
        teamLogo: DB.getTeamPhoto(teamName, m.tournamentId) || '',
        players: collectSquadPlayersForTeam(m, teamName),
        subtitle: meta.join(', ') || 'Live Match Presentation',
        tossWinner: m.tossWinner || teamName,
        tossDecision: m.tossDecision || 'bat',
        formatLabel: m.format || m.matchFormat || 'T20',
        siteLabel: 'SLCRICKPRO',
    };
}

const Broadcast = {
    _buildBroadcastData(cmd, data = {}) {
        if (data && Object.keys(data).length > 0) return data;
        const m = getBroadcastMatch();
        if (!m) return data;
        const inn = m.innings?.[m.currentInnings || 0];
        if (!inn) return data;

        const strikerIdx = inn.currentBatsmenIdx ? inn.currentBatsmenIdx[inn.strikerIdx || 0] : null;
        const nonStrikerIdx = inn.currentBatsmenIdx ? inn.currentBatsmenIdx[inn.strikerIdx === 0 ? 1 : 0] : null;
        const striker = strikerIdx != null ? inn.batsmen?.[strikerIdx] : null;
        const nonStriker = nonStrikerIdx != null ? inn.batsmen?.[nonStrikerIdx] : null;
        const bowler = (inn.currentBowlerIdx != null) ? inn.bowlers?.[inn.currentBowlerIdx] : null;

        const avatar = (player) => {
            if (!player) return null;
            return (typeof DB !== 'undefined' && DB.getPlayerPhoto) ? DB.getPlayerPhoto(player.playerId) : null;
        };

        switch (cmd) {
            case 'SHOW_STRIKER_PROFILE':
                return striker ? buildPlayerProfileBroadcastData(striker, m, 'striker') : data;
            case 'SHOW_NON_STRIKER_PROFILE':
                return nonStriker
                    ? buildPlayerProfileBroadcastData(nonStriker, m, 'nonstriker')
                    : data;
            case 'SHOW_BOWLER_PROFILE':
                return bowler ? buildPlayerProfileBroadcastData(bowler, m, 'bowler') : data;
            case 'SHOW_BATTER_PROFILES':
                return {
                    profiles: [striker, nonStriker].filter(Boolean).map((player, idx) => ({
                        playerName: player.name || `BATSMAN ${idx + 1}`,
                        stats: { runs: player.runs || 0, balls: player.balls || 0, sixes: player.sixes || 0 },
                        profile: { photo: avatar(player) }
                    }))
                };
            case 'SHOW_PARTNERSHIP':
                return buildPartnershipBroadcastData(m);
            case 'SHOW_LAST_WICKET':
                return buildLastWicketBroadcastData(m) || data;
            default:
                return data;
        }
    },

    /**
     * Send a command to the TV Display
     * @param {string} cmd - Command name (e.g., 'SHOW_RUNS_BALLS')
     * @param {object} data - Optional data payload
     */
    send(cmd, data = {}) {
        data = this._buildBroadcastData(cmd, data);
        const bm = getBroadcastMatch();
        const bt = getBroadcastTournament();
        const scopeTournamentId = (bm && bm.tournamentId) || (bt && bt.id) || null;
        const scopeMatchId = (bm && bm.id) || null;
        const payload = {
            cmd,
            data,
            tournamentId: scopeTournamentId,
            matchId: scopeMatchId,
            timestamp: Date.now()
        };
        // Use a unique key with timestamp to ensure the 'storage' event fires even if command is same
        localStorage.setItem(BROADCAST_KEYS.COMMAND, JSON.stringify(payload));
        console.log(`📡 Broadcast Sent (Local): ${cmd}`, data);

        if (typeof window.forwardBroadcastToPreviews === 'function') {
            window.forwardBroadcastToPreviews(payload);
        } else {
            document.querySelectorAll('iframe').forEach((f) => {
                if (f.contentWindow) {
                    f.contentWindow.postMessage({ type: 'cricpro_broadcast_cmd', payload }, '*');
                }
            });
        }

        if (window.desktopAPI) {
            window.desktopAPI.broadcastCommand(payload);
            if (bm) window.desktopAPI.publishMatch(bm);
        }

        const rtSock = window.SLCRICK_REALTIME?.socket;
        if (rtSock?.connected) {
            rtSock.emit('broadcast_command', payload);
        } else if (typeof socket !== 'undefined' && socket) {
            socket.emit('broadcast_command', payload);
        }

        const apiBase =
            (window.SLCRICK_SYNC?.getBackendUrl && window.SLCRICK_SYNC.getBackendUrl()) ||
            window.BACKEND_BASE_URL ||
            (typeof DB !== 'undefined' ? DB.getCloudURL?.() : '') ||
            window.CRICPRO_CLOUD_CONFIG?.backendUrl ||
            '';
        const syncOn = window.SLCRICK_SYNC?.isEnabled ? window.SLCRICK_SYNC.isEnabled() : !!apiBase;
        if (syncOn && apiBase) {
            fetch(String(apiBase).replace(/\/$/, '') + '/sync/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).catch(() => {});
        }
    },

    /**
     * Trigger the "Runs Needed" motion graphic
     */
    showRunsNeeded() {
        const currentMatch = getBroadcastMatch();
        if (!currentMatch) return;
        const inn0 = currentMatch.innings[0];
        const inn1 = currentMatch.innings[1];
        if (currentMatch.currentInnings !== 1 || !inn0 || !inn1) {
            showToast('Only available in 2nd Innings!', 'error');
            return;
        }

        const target = inn0.runs + 1;
        const runsNeeded = target - inn1.runs;
        const ballsRemaining = (currentMatch.overs * currentMatch.ballsPerOver) - inn1.balls;

        this.send('SHOW_RUNS_BALLS', {
            runs: runsNeeded,
            balls: ballsRemaining
        });
        showToast('🚀 Graphic Published to TV!', 'success');
    },

    /**
     * Set the "Coming Up Next" graphic
     */
    publishNextMatch() {
        // Support multiple possible input IDs from different UI layouts
        const aEl = document.getElementById('broadcast-next-a') ||
                    document.getElementById('next-match-teama') ||
                    document.getElementById('next-teama');
        const bEl = document.getElementById('broadcast-next-b') ||
                    document.getElementById('next-match-teamb') ||
                    document.getElementById('next-teamb');
        const teamA = (aEl && aEl.value.trim()) || '';
        const teamB = (bEl && bEl.value.trim()) || '';
        if (!teamA || !teamB) {
            showToast('Enter both team names!', 'error');
            return;
        }

        this.send('SHOW_NEXT_MATCH', { teamA, teamB });
        showToast('📅 Next Match Published!', 'success');
    },

    setOverlayMode(mode) {
        this.send('SET_OVERLAY_MODE', { mode });
    },

    setOverlaySubMode(subMode) {
        this.send('SET_OVERLAY_SUBMODE', { subMode });
    },

    /**
     * Show Current Run Rate graphic
     */
    showCRR() {
        const m = getBroadcastMatch();
        if (!m) return;
        const inn = m.innings?.[m.currentInnings ?? 0];
        if (!inn) return;
        const bpo = m.ballsPerOver || 6;
        const crr = inn.balls ? ((inn.runs / inn.balls) * bpo).toFixed(2) : '0.00';
        let rrr = null;
        if (m.currentInnings === 1 && m.innings[0]) {
            const target = m.innings[0].runs + 1;
            const need = target - inn.runs;
            const ballsLeft = m.overs * bpo - inn.balls;
            if (ballsLeft > 0 && need > 0) {
                rrr = ((need / ballsLeft) * bpo).toFixed(2);
            }
        }
        this.send('SHOW_CRR', { crr, rrr });
        showToast('📈 Run rate highlighted on TV', 'success');
    },

    showLastWicket() {
        const m = getBroadcastMatch();
        const payload = buildLastWicketBroadcastData(m);
        if (!payload) {
            showToast('No wicket recorded yet in this match', 'error');
            return;
        }
        this.send('SHOW_LAST_WICKET', payload);
        showToast(
            `🎯 ${payload.batters.length} wicket${payload.batters.length !== 1 ? 's' : ''} on TV`,
            'success'
        );
    },

    // Milestone Option Removed as per User Request

    /**
     * Stop all overlays and return to live score
     */
    stopAll() {
        this.send('STOP_ALL');
        this.syncToggleUI(true);
        showToast('⏹ All Overlays Cleared', 'default');
    },

    /**
     * Show Striker Profile
     */
    broadcastStrikerProfile() {
        if (!getBroadcastMatch() || !window.DB) return showToast('No active match', 'error');
        const m = getBroadcastMatch();
        const inn = m.innings[m.currentInnings];
        if (!inn || !inn.currentBatsmenIdx) return showToast('No innings active', 'error');
        const strikerIdx = inn.currentBatsmenIdx[inn.strikerIdx];
        const striker = inn.batsmen[strikerIdx];
        if (!striker) return showToast('No striker found', 'error');

        this.send('SHOW_STRIKER_PROFILE', buildPlayerProfileBroadcastData(striker, m, 'striker'));
        showToast('⚡ Striker Profile Published!', 'success');
    },

    /**
     * Show Non-Striker Profile
     */
    broadcastNonStrikerProfile() {
        if (!getBroadcastMatch() || !window.DB) return showToast('No active match', 'error');
        const m = getBroadcastMatch();
        const inn = m.innings[m.currentInnings];
        if (!inn || !inn.currentBatsmenIdx) return showToast('No innings active', 'error');
        const nonStrikerIdx = inn.currentBatsmenIdx[inn.strikerIdx === 0 ? 1 : 0];
        const nonStriker = inn.batsmen[nonStrikerIdx];
        if (!nonStriker) return showToast('No non-striker found', 'error');

        this.send(
            'SHOW_NON_STRIKER_PROFILE',
            buildPlayerProfileBroadcastData(nonStriker, m, 'nonstriker')
        );
        showToast('🛡️ Non-Striker Profile Published!', 'success');
    },

    /**
     * Show Both Batters
     */
    broadcastCurrentBatters() {
        if (!getBroadcastMatch() || !window.DB) return showToast('No active match', 'error');
        const m = getBroadcastMatch();
        const inn = m.innings[m.currentInnings];
        if (!inn || !inn.currentBatsmenIdx) return showToast('No innings active', 'error');
        const b1 = inn.batsmen[inn.currentBatsmenIdx[0]];
        const b2 = inn.batsmen[inn.currentBatsmenIdx[1]];
        if (!b1 && !b2) return showToast('No batters found', 'error');

        const profiles = [];
        if (b1) {
            profiles.push({
                ...buildPlayerProfileBroadcastData(b1, m, inn.strikerIdx === 0 ? 'striker' : 'nonstriker'),
            });
        }
        if (b2) {
            profiles.push({
                ...buildPlayerProfileBroadcastData(b2, m, inn.strikerIdx === 1 ? 'striker' : 'nonstriker'),
            });
        }

        this.send('SHOW_BATTER_PROFILES', { profiles });
        showToast('🏏 Batters Published!', 'success');
    },

    /**
     * Show Partnership
     */
    broadcastPartnership() {
        if (!getBroadcastMatch() || !window.DB) return showToast('No active match', 'error');
        const m = getBroadcastMatch();
        const inn = m.innings?.[m.currentInnings];
        if (!inn || !inn.currentBatsmenIdx) return showToast('No innings active', 'error');

        const b1 = inn.batsmen?.[inn.currentBatsmenIdx[0]];
        const b2 = inn.batsmen?.[inn.currentBatsmenIdx[1]];
        if (!b1 && !b2) return showToast('No batters on crease', 'error');

        const currentPartnership =
            inn.currentPartnership ||
            (inn.partnerships?.length ? inn.partnerships[inn.partnerships.length - 1] : null) ||
            { runs: 0, balls: 0 };

        this.send('SHOW_PARTNERSHIP', buildPartnershipBroadcastData(m));
        showToast('🤝 Partnership Published!', 'success');
    },

    /**
     * Show Bowler Profile
     */
    broadcastBowlerProfile() {
        if (!getBroadcastMatch() || !window.DB) return showToast('No active match', 'error');
        const m = getBroadcastMatch();
        const inn = m.innings[m.currentInnings];
        if (!inn || inn.currentBowlerIdx == null) return showToast('No bowler active', 'error');
        const bowler = inn.bowlers[inn.currentBowlerIdx];
        if (!bowler) return showToast('No bowler found', 'error');

        this.send('SHOW_BOWLER_PROFILE', buildPlayerProfileBroadcastData(bowler, m, 'bowler'));
        showToast('⚾ Bowler Profile Published!', 'success');
    },


    /**
     * Show Team Card (squad card with player photos)
     */
    broadcastTeamCard(teamIdx) {
        if (!getBroadcastMatch() || !window.DB) return showToast('No active match', 'error');
        const m = getBroadcastMatch();
        const teamName = teamIdx === 0 ? m.team1 : m.team2;
        if (!teamName) return showToast('Team not found', 'error');
        const payload = buildTeamSquadBroadcastPayload(m, teamName);
        if (!payload.players.length) {
            return showToast('No players in squad — add roster in Squad Management', 'error');
        }
        this.send('SHOW_TEAM_CARD', payload);
        showToast(`📋 ${teamName} lineup on air (Stop All to hide)`, 'success');
    },

    /** Batting team squad — full photo grid (stays until Stop Overlay) */
    broadcastBattingTeamSquad() {
        if (!getBroadcastMatch() || !window.DB) return showToast('No active match', 'error');
        const m = getBroadcastMatch();
        const inn = m.innings?.[m.currentInnings || 0];
        const teamName = inn?.battingTeam || m.team1;
        if (!teamName) return showToast('Batting team not set', 'error');
        const payload = buildTeamSquadBroadcastPayload(m, teamName);
        if (!payload.players.length) {
            return showToast('No players found for batting team', 'error');
        }
        this.send('SHOW_TEAM_CARD', payload);
        showToast(`🏏 ${teamName} batting squad on air`, 'success');
    },

    /**
     * Show Special Guest Overlay
     */
    broadcastSpecialGuest(photoUrl, name) {
        if (!name) {
            showToast('Please enter guest name', 'error');
            return;
        }
        this.send('SHOW_GUEST', { photo: photoUrl, name: name });
        showToast('👤 Special Guest Published!', 'success');
    },

    /**
     * Toggle full scorecard overlay
     */
    showScorecard() {
        this.send('SHOW_SCORECARD');
        showToast('📋 Scorecard Published!', 'success');
    },

    /**
     * Toggle tournament summary overlay
     */
    showSummary() {
        this.send('SHOW_SUMMARY');
        showToast('🏆 Summary Published!', 'success');
    },

    /**
     * Toggle Live Scorebar visibility
     */
    toggleScorebar() {
        const btn = document.getElementById('btn-toggle-scorebar');
        const txt = document.getElementById('txt-toggle-scorebar');
        const checkbox = document.getElementById('scorebar-toggle');
        
        // Detect current state: if text includes ':ON' or '(ON)' it is currently ON → we want to turn OFF
        let currentlyOn = true;
        if (txt) {
            const t = txt.innerText || '';
            currentlyOn = t.includes(': ON') || t.includes('(ON)') || t.includes(':ON');
        } else if (checkbox) {
            currentlyOn = checkbox.checked;
        }
        const newState = !currentlyOn;

        this.send('SET_SCOREBAR_VISIBILITY', { visible: newState });
        this.syncToggleUI(newState);
        showToast(newState ? 'Scorebar Visible!' : 'Scorebar Hidden!', newState ? 'success' : 'default');
    },

    /**
     * Keep the Controller UI in sync with the broadcast state
     */
    syncToggleUI(isVisible) {
        const btn = document.getElementById('btn-toggle-scorebar');
        const txt = document.getElementById('txt-toggle-scorebar');
        const checkbox = document.getElementById('scorebar-toggle');

        if (btn && txt) {
            const isBBtn = btn.classList.contains('b-btn'); // Broadcast Controller style
            if (isVisible) {
                txt.innerText = isBBtn ? 'LIVE SCOREBAR: ON' : '👁 LIVE SCOREBAR (ON)';
                if (!isBBtn) {
                    btn.className = 'btn btn-green btn-full';
                    btn.style.boxShadow = '0 0 10px rgba(0,255,0,0.3)';
                } else {
                    btn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
                    btn.style.boxShadow = '0 0 15px rgba(0,255,0,0.3)';
                }
            } else {
                txt.innerText = isBBtn ? 'LIVE SCOREBAR: OFF' : '👁 LIVE SCOREBAR (OFF)';
                if (!isBBtn) {
                    btn.className = 'btn btn-red btn-full';
                    btn.style.boxShadow = '0 0 10px rgba(255,0,0,0.3)';
                } else {
                    btn.style.background = 'linear-gradient(135deg, #991b1b, #ef4444)';
                    btn.style.boxShadow = '0 0 15px rgba(255,0,0,0.3)';
                }
            }
        }
        if (checkbox) {
            checkbox.checked = isVisible;
        }
    },

    /**
     * Change active Scorebar Overlay Theme
     */
    changeOverlayTheme(themeValue, opts = {}) {
        const themeMap = { theme1: 4, theme2: 2, theme3: 3, theme4: 4 };
        const modeNum = themeMap[themeValue] || parseInt(String(themeValue).replace('theme', ''), 10) || 4;
        try {
            localStorage.setItem('cricpro_scorebar_theme', themeValue);
        } catch (_) {}
        const manual = document.getElementById('manual-input-section');
        if (manual) manual.style.display = themeValue === 'theme3' ? 'block' : 'none';
        const sel = document.getElementById('broadcast-theme-select');
        const sel2 = document.getElementById('scorebar-style-select');
        if (sel && sel.value !== themeValue) sel.value = themeValue;
        if (sel2 && sel2.value !== themeValue) sel2.value = themeValue;
        this.send('SET_OVERLAY_MODE', { mode: modeNum });
        if (typeof window.refreshObsScorebarUrls === 'function') {
            window.refreshObsScorebarUrls();
        }
        if (!opts.silent) showToast('🎨 Theme Updated!', 'success');
    },

    restoreOverlayThemeSelect() {
        try {
            const saved = localStorage.getItem('cricpro_scorebar_theme') || 'theme1';
            this.changeOverlayTheme(saved, { silent: true });
        } catch (_) {}
    },

    showMatchDraw() {
        if (typeof shareMatchDrawOverlay === 'function') {
            shareMatchDrawOverlay();
            return;
        }
        showToast('Match Draw not available', 'error');
    },

    hideMatchDraw() {
        if (typeof hideMatchDrawOverlay === 'function') {
            hideMatchDrawOverlay();
        } else {
            this.send('STOP_MATCH_DRAW', {});
        }
    },
};

window.buildTeamSquadBroadcastPayload = buildTeamSquadBroadcastPayload;
window.collectSquadPlayersForTeam = collectSquadPlayersForTeam;
window.buildPlayerProfileBroadcastData = buildPlayerProfileBroadcastData;
window.buildPartnershipBroadcastData = buildPartnershipBroadcastData;
window.buildLastWicketBroadcastData = buildLastWicketBroadcastData;
window.getBroadcastProfileSettings = getBroadcastProfileSettings;
window.getBroadcastPhotoForRole = getBroadcastPhotoForRole;
