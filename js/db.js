// ================================================
//  SLCRICKPRO – Central Database (localStorage)
// ================================================

// ============================================================
//  BROWSER POLICY FIXES (Permissions Policy & Unload Warnings)
// ============================================================
(function() {
    // Modern browsers (Chrome 115+) are phasing out 'unload' events.
    // Instead of just swallowing them, we now use 'pagehide' and 'visibilitychange'.
    const originalAddEventListener = window.addEventListener;
    window.addEventListener = function(type, listener, options) {
        if (type === 'unload') {
            console.warn('⚠️ [SLCRICKPRO] Redirecting "unload" listener to "pagehide" due to browser policy.');
            return originalAddEventListener.call(this, 'pagehide', listener, options);
        }
        return originalAddEventListener.apply(this, arguments);
    };

    // Global persistence on visibility change (modern best practice)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && window.desktopAPI) {
            window.desktopAPI.requestPersist();
        }
    });

    window.addEventListener('pagehide', () => {
        if (window.desktopAPI) window.desktopAPI.requestPersist();
    });
})();

const DB_KEYS = {
    PLAYERS: 'cricpro_players',
    TEAMS: 'cricpro_teams',
    MATCHES: 'cricpro_matches',
    TOURNAMENTS: 'cricpro_tournaments',
    PRODUCTS: 'cricpro_products',
    ORDERS: 'cricpro_orders',
    SETTINGS: 'cricpro_settings',
    POSTS: 'cricpro_posts',
    REPORTS: 'cricpro_reports',
};

const LOCAL_MATCH_STORE_MAX = () => (window.SLCRICK_DESKTOP ? 100 : 32);

/** Site-root asset URL — works from /pages/* and index (avoids /pages/assets/ 404). */
function resolveAssetUrl(url) {
    if (url == null || url === '') return '';
    const s = String(url).trim();
    if (!s) return '';
    if (/^(data:|blob:|https?:)/i.test(s)) return s;
    const m = s.match(/(?:^|\/)(?:\.\.\/)*assets\/(.+)$/i);
    if (m) return `/assets/${m[1]}`;
    if (s.startsWith('/')) return s;
    if (s.startsWith('assets/')) return `/${s}`;
    return s;
}

function defaultTeamPhotoUrl() {
    return '/assets/default-team.svg';
}

function defaultPlayerPhotoUrl() {
    return '/assets/default-player.svg';
}

function stripDataUrlFields(obj) {
    if (!obj || typeof obj !== 'object') return;
    ['photo', 'team1Photo', 'team2Photo', 'banner', 'logo'].forEach((key) => {
        const v = obj[key];
        if (typeof v === 'string' && v.startsWith('data:')) delete obj[key];
    });
}

/** Light copy for localStorage — keeps live score, drops undo stacks & huge photos */
function slimMatchForLocalStorage(match) {
    if (!match || typeof match !== 'object') return match;
    let copy;
    try {
        copy = JSON.parse(JSON.stringify(match));
    } catch (_) {
        return match;
    }
    delete copy._scoringUi;
    delete copy._pendingUiConsumer;
    delete copy._isSyncing;
    delete copy._isBackgroundSync;
    delete copy._authRetried;
    delete copy.history;
    delete copy.redoStack;
    stripDataUrlFields(copy);
    if (copy.teamPhotos && typeof copy.teamPhotos === 'object') {
        Object.keys(copy.teamPhotos).forEach((k) => {
            const p = copy.teamPhotos[k];
            if (typeof p === 'string' && p.startsWith('data:')) delete copy.teamPhotos[k];
        });
        if (!Object.keys(copy.teamPhotos).length) delete copy.teamPhotos;
    }
    if (Array.isArray(copy.innings)) {
        copy.innings = copy.innings.map((inn) => {
            if (!inn) return inn;
            const i = { ...inn };
            if (Array.isArray(i.overHistory) && i.overHistory.length > 2) {
                i.overHistory = i.overHistory.slice(-2);
            }
            if (Array.isArray(i.batsmen)) {
                i.batsmen = i.batsmen.map((b) => {
                    const x = { ...b };
                    if (x.photo && String(x.photo).startsWith('data:')) delete x.photo;
                    return x;
                });
            }
            if (Array.isArray(i.bowlers)) {
                i.bowlers = i.bowlers.map((b) => {
                    const x = { ...b };
                    if (x.photo && String(x.photo).startsWith('data:')) delete x.photo;
                    return x;
                });
            }
            return i;
        });
    }
    return copy;
}

function pruneMatchesForStorage(arr) {
    const MAX = LOCAL_MATCH_STORE_MAX();
    const list = (arr || []).filter((m) => m && m.id);
    const live = list.filter((m) => m.status === 'live' || m.status === 'paused');
    const liveIds = new Set(live.map((m) => m.id));
    const published = list.filter(
        (m) => !liveIds.has(m.id) && m.publishLive !== false
    );
    const pubIds = new Set(published.map((m) => m.id));
    const rest = list.filter((m) => !liveIds.has(m.id) && !pubIds.has(m.id));
    const byTs = (a, b) => (b.lastUpdated || b.scoringStartedAt || 0) - (a.lastUpdated || a.scoringStartedAt || 0);
    published.sort(byTs);
    rest.sort(byTs);
    const out = [];
    const seen = new Set();
    [...live, ...published, ...rest].forEach((m) => {
        if (seen.has(m.id) || out.length >= MAX) return;
        seen.add(m.id);
        out.push(m);
    });
    return out;
}

function shouldStoreRemoteMatchLocally(m) {
    if (!m || !m.id || m.deleted) return false;
    if (m.status === 'live' || m.status === 'paused') return true;
    if (m.publishLive === true) return true;
    const ts = m.lastUpdated || m.scoringStartedAt || 0;
    if (Date.now() - ts < 21 * 86400000) return true;
    return false;
}

// SLCRICKPRO – Theme Logic is now handled via inline scripts in HTML files to prevent FOUC

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('img').forEach((img) => {
        if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy');
        if (!img.getAttribute('decoding')) img.setAttribute('decoding', 'async');
    });
});

window.toggleTheme = function() {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    if (typeof showToast === 'function') {
        showToast(`🌓 Switched to ${isLight ? 'Light' : 'Dark'} mode`, 'default');
    }
};

function showErrorInsideProgram(msg, url, line) {
    console.error("Critical Error:", msg, "at", url, ":", line);
    showToast("⚠️ Operation Error: " + msg, "error");
}

// --- GLOBAL UI HELPERS ---
window.showModal = function(id) {
    const m = document.getElementById(id);
    if (m) m.style.display = 'flex';
};
window.closeModal = function(id) {
    const m = document.getElementById(id);
    if (m) m.style.display = 'none';
};
window.showToast = function(msg, type = 'default') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerText = msg;
    t.className = 'toast show ' + type;
    setTimeout(() => { t.className = 'toast'; }, 3000);
};

// ── SAFE INPUT MODAL (replaces unsupported prompt()) ──
window.showInputModal = function(message, defaultValue = '') {
    return new Promise((resolve) => {
        // Create modal container
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            font-family: Outfit, sans-serif;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: white;
            padding: 24px;
            border-radius: 12px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
            max-width: 400px;
            min-width: 300px;
            z-index: 10001;
        `;

        const title = document.createElement('p');
        title.textContent = message;
        title.style.cssText = `
            margin: 0 0 16px 0;
            font-size: 16px;
            font-weight: 500;
            color: #333;
        `;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue;
        input.style.cssText = `
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            font-family: Outfit, sans-serif;
            box-sizing: border-box;
            margin-bottom: 16px;
        `;
        input.focus();

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 12px;
            justify-content: flex-end;
        `;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            padding: 10px 20px;
            border: 1px solid #ddd;
            background: #f0f0f0;
            border-radius: 6px;
            cursor: pointer;
            font-family: Outfit, sans-serif;
            font-size: 14px;
            font-weight: 500;
            transition: background 0.2s;
        `;
        cancelBtn.onmouseover = () => cancelBtn.style.background = '#e0e0e0';
        cancelBtn.onmouseout = () => cancelBtn.style.background = '#f0f0f0';
        cancelBtn.onclick = () => {
            document.body.removeChild(modal);
            resolve(null);
        };

        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = `
            padding: 10px 20px;
            border: none;
            background: #007bff;
            color: white;
            border-radius: 6px;
            cursor: pointer;
            font-family: Outfit, sans-serif;
            font-size: 14px;
            font-weight: 500;
            transition: background 0.2s;
        `;
        okBtn.onmouseover = () => okBtn.style.background = '#0056b3';
        okBtn.onmouseout = () => okBtn.style.background = '#007bff';
        okBtn.onclick = () => {
            document.body.removeChild(modal);
            resolve(input.value);
        };

        input.onkeypress = (e) => {
            if (e.key === 'Enter') okBtn.onclick();
            if (e.key === 'Escape') cancelBtn.onclick();
        };

        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(okBtn);
        box.appendChild(title);
        box.appendChild(input);
        box.appendChild(buttonContainer);
        modal.appendChild(box);
        document.body.appendChild(modal);
    });
};

function _persistEntityFiles(type, entity) {
    if (!window.SLCRICK_DESKTOP || !window.desktopAPI || !entity?.id) return;
    try {
        if (type === 'match' && window.desktopAPI.saveMatchFile) {
            window.desktopAPI.saveMatchFile(entity);
        }
        if (type === 'tournament' && window.desktopAPI.saveTournamentFile) {
            window.desktopAPI.saveTournamentFile(entity);
        }
    } catch (e) {
        console.warn('[DB] file save', e);
    }
}

const DB = {
    getCloudURL() {
        if (window.SLCRICK_SYNC) return window.SLCRICK_SYNC.getBackendUrl();
        return '';
    },

    // ---------- SECURE STORAGE ----------
    _recoverStorageQuota(key, val) {
        let recovered = false;
        if (key === DB_KEYS.MATCHES && Array.isArray(val)) {
            const slim = pruneMatchesForStorage(val.map(slimMatchForLocalStorage));
            try {
                const str = JSON.stringify(slim);
                localStorage.setItem(key, 'SECURE_' + btoa(encodeURIComponent(str)));
                recovered = true;
            } catch (_) {}
        }
        if (!recovered) {
            const n = this._clearPhotoCacheKeys();
            if (n > 0 && key === DB_KEYS.MATCHES) {
                try {
                    const slim = pruneMatchesForStorage(
                        (Array.isArray(val) ? val : this.getMatches()).map(slimMatchForLocalStorage)
                    );
                    const str = JSON.stringify(slim);
                    localStorage.setItem(key, 'SECURE_' + btoa(encodeURIComponent(str)));
                    recovered = true;
                } catch (_) {}
            }
        }
        if (!recovered && key === DB_KEYS.MATCHES) {
            const live = this.getMatches().filter(
                (m) => m.status === 'live' || m.status === 'paused'
            );
            try {
                const str = JSON.stringify(live.map(slimMatchForLocalStorage));
                localStorage.setItem(key, 'SECURE_' + btoa(encodeURIComponent(str)));
                recovered = true;
            } catch (_) {}
        }
        return recovered;
    },
    _secureSet(key, val) {
        const write = (data) => {
            const str = JSON.stringify(data);
            const enc = btoa(encodeURIComponent(str));
            localStorage.setItem(key, 'SECURE_' + enc);
        };
        try {
            let payload = val;
            if (key === DB_KEYS.MATCHES && Array.isArray(val)) {
                payload = pruneMatchesForStorage(val.map(slimMatchForLocalStorage));
            }
            write(payload);
            if (window.SLCRICK_DESKTOP && window.desktopAPI) {
                window.desktopAPI.requestPersist();
            }
        } catch (e) {
            const isQuota =
                e &&
                (e.name === 'QuotaExceededError' ||
                    e.code === 22 ||
                    e.code === 1014 ||
                    /quota/i.test(String(e.message || e)));
            if (isQuota && this._recoverStorageQuota(key, val)) {
                if (typeof showToast === 'function') {
                    showToast('Storage was full — old match data trimmed. Live scores kept.', 'default');
                }
                if (window.SLCRICK_DESKTOP && window.desktopAPI) {
                    window.desktopAPI.requestPersist();
                }
                return;
            }
            console.error('Storage err', e);
            if (typeof showToast === 'function') {
                showToast(
                    '❌ Save failed (browser storage full). Settings → Clear completed matches, or clear photo cache.',
                    'error'
                );
            }
        }
    },
    slimMatchForLocalStorage,
    pruneMatchesForStorage,
    shouldStoreRemoteMatchLocally,
    _secureGet(key, def) {
        const raw = localStorage.getItem(key);
        if (!raw) return def;
        if (raw.startsWith('SECURE_')) {
            try { return JSON.parse(decodeURIComponent(atob(raw.substring(7)))); } catch(e) { return def; }
        } else {
            try { return JSON.parse(raw); } catch(e) { return def; }
        }
    },

    // ---------- PLAYERS ----------
    getPlayers() {
        return this._secureGet(DB_KEYS.PLAYERS, []);
    },
    savePlayers(arr) {
        this._secureSet(DB_KEYS.PLAYERS, arr);
        // Track the highest ID seen to prevent collisions even if cache is temporarily empty
        if (arr && arr.length > 0) {
            const ids = arr.map(p => {
                const m = (p.playerId || '').match(/CP-?(\d+)/);
                return m ? parseInt(m[1]) || 0 : 0;
            });
            const max = Math.max(...ids);
            const currentLast = parseInt(localStorage.getItem('cricpro_last_pid')) || 0;
            if (max > currentLast) {
                localStorage.setItem('cricpro_last_pid', max.toString());
            }
        }
    },
    _syncAllPlayers(arr) {
        // Bulk push all players to MongoDB
    },
    addPlayer(player) {
        const arr = this.getPlayers();
        const id = this.generatePlayerId(arr);
        player.playerId = id;
        player.createdAt = Date.now();
        player.stats = player.stats || {
            matches: 0, innings: 0,
            runs: 0, balls: 0, fours: 0, sixes: 0, notOuts: 0,
            highScore: 0, hundreds: 0, fifties: 0, thirties: 0,
            wickets: 0, overs: 0, bowlingRuns: 0, maidens: 0, bestBowling: "0/0",
            catches: 0, stumpings: 0,
        };

        // Persistent photo storage (localStorage vault)
        if (player.photo && String(player.photo).startsWith('data:')) {
            localStorage.setItem('cricpro_photo_' + id, player.photo);
            player.photo = ''; // Keep the player record light
        }

        arr.push(player);
        this.savePlayers(arr);

        // Ensure last ID is tracked immediately
        const m = (player.playerId || '').match(/CP-?(\d+)/);
        if (m) {
            localStorage.setItem('cricpro_last_pid', (parseInt(m[1]) || 0).toString());
        }

        // Sync to MongoDB
        const syncPayload = { ...player, photo: localStorage.getItem('cricpro_photo_' + id) || '' };
        return player;
    },
    generatePlayerId(arr) {
        const lastPid = parseInt(localStorage.getItem('cricpro_last_pid')) || 0;
        let max = lastPid;

        if (arr && arr.length > 0) {
            const nums = arr.map(p => {
                const match = (p.playerId || '').match(/CP-?(\d+)/);
                return match ? parseInt(match[1]) || 0 : 0;
            });
            max = Math.max(max, ...nums);
        }
        
        return 'CP' + String(max + 1).padStart(4, '0');
    },
    getPlayerById(id) {
        const arr = this.getPlayers();
        const p = arr.find(p => p.playerId === id);
        if (!p) return null;
        
        // Retrieve from persistent photo vault if missing in record
        if (!p.photo || p.photo === '') {
            const cached = localStorage.getItem('cricpro_photo_' + id);
            if (cached) p.photo = cached;
        }
        return p;
    },
    updatePlayer(player) {
        if (!player || !player.playerId) return null;
        const arr = this.getPlayers();
        const idx = arr.findIndex(p => p.playerId === player.playerId);
        
        if (idx === -1) {
            return this.addPlayer(player);
        }

        const id = player.playerId;
        // Handle persistent photo storage
        if (player.photo && String(player.photo).startsWith('data:')) {
            localStorage.setItem('cricpro_photo_' + id, player.photo);
            player.photo = ''; 
        }

        arr[idx] = { ...arr[idx], ...player };
        this.savePlayers(arr);

        const syncPayload = { ...arr[idx], photo: localStorage.getItem('cricpro_photo_' + id) || '' };

        return arr[idx];
    },
    updatePlayerStats(playerId, stats) {
        const arr = this.getPlayers();
        const idx = arr.findIndex(p => p.playerId === playerId);
        if (idx !== -1) {
            arr[idx].stats = { ...arr[idx].stats, ...stats };
            this.savePlayers(arr);
            // Also sync updated stats to MongoDB
        }
    },

    // ---------- TEAMS ----------
    getTeams() {
        return this._secureGet(DB_KEYS.TEAMS, []);
    },
    saveTeams(arr) {
        this._secureSet(DB_KEYS.TEAMS, arr);
    },
    _syncAllTeams(arr) {
        // Bulk push all teams to MongoDB
    },
    updateTeamStats(teamName, stats) {
        const arr = this.getTeams();
        const idx = arr.findIndex(t => t.name === teamName);
        if (idx !== -1) {
            arr[idx].stats = { ...arr[idx].stats, ...stats };
            this.saveTeams(arr);
        }
    },
    addTeam(team) {
        const arr = this.getTeams();
        team.id = 'TEAM-' + Date.now();
        team.createdAt = Date.now();
        team.stats = team.stats || {
            played: 0, won: 0, lost: 0, tied: 0,
            runsScored: 0, ballsFaced: 0,
            runsConceded: 0, ballsBowled: 0,
            prizeMoney: 0
        };
        
        // Persistent photo storage
        if (team.photo && String(team.photo).startsWith('data:')) {
            localStorage.setItem('cricpro_team_photo_' + team.id, team.photo);
            team.photo = ''; 
        }

        arr.push(team);
        this.saveTeams(arr);
        // Sync to MongoDB
        return team;
    },

    getTeamPhoto(teamIdOrName, tournamentId = '') {
        const key = `cricpro_team_photo_${teamIdOrName}${tournamentId ? '_' + tournamentId : ''}`;
        const photo = localStorage.getItem(key);
        if (photo) return resolveAssetUrl(photo) || photo;

        const globalKey = `cricpro_team_photo_${teamIdOrName}`;
        const globalPhoto = localStorage.getItem(globalKey);
        if (globalPhoto) return resolveAssetUrl(globalPhoto) || globalPhoto;

        return defaultTeamPhotoUrl();
    },

    saveTeamPhoto(teamIdOrName, dataUrl, tournamentId = '') {
        if (!dataUrl) return;
        const key = `cricpro_team_photo_${teamIdOrName}${tournamentId ? '_' + tournamentId : ''}`;
        localStorage.setItem(key, dataUrl);
        if (window.desktopAPI) window.desktopAPI.requestPersist();
    },

    getPlayerPhoto(playerId) {
        const fallback = defaultPlayerPhotoUrl();
        if (!playerId) return fallback;
        const stored = localStorage.getItem('cricpro_photo_' + playerId);
        return stored ? resolveAssetUrl(stored) || stored : fallback;
    },

    resolveAssetUrl,
    defaultTeamPhotoUrl,
    defaultPlayerPhotoUrl,

    savePlayerPhoto(playerId, dataUrl) {
        if (!playerId || !dataUrl) return;
        localStorage.setItem('cricpro_photo_' + playerId, dataUrl);
        if (window.desktopAPI) window.desktopAPI.requestPersist();
    },

    // ---------- MATCHES ----------
    getMatches() {
        return this._secureGet(DB_KEYS.MATCHES, []);
    },
    saveMatches(arr) {
        this._secureSet(DB_KEYS.MATCHES, arr || []);
    },
    getMatch(id) {
        return this.getMatches().find(m => m.id === id);
    },
    saveMatch(match, skipCloud = false, options = {}) {
        match.lastUpdated = Date.now();
        if ((match.status === 'live' || match.status === 'paused') && match.publishLive !== false) {
            match.publishLive = true;
        }
        const arr = this.getMatches();
        const idx = arr.findIndex(m => m.id === match.id);
        const prev = idx !== -1 ? arr[idx] : null;
        const nowScoring =
            match.status === 'live' || match.status === 'paused';
        const wasScoring =
            prev &&
            (prev.status === 'live' ||
                prev.status === 'paused' ||
                prev.status === 'completed');
        if (nowScoring && !wasScoring && !match.scoringStartedAt) {
            match.scoringStartedAt = Date.now();
        }
        if (idx !== -1) arr[idx] = match;
        else arr.push(match);
        this._secureSet(DB_KEYS.MATCHES, arr);
        if (!options.skipForceUpdate) {
            localStorage.setItem('cricpro_force_update', Date.now().toString());
        }
        const skipPublish =
            options.skipPublish ||
            window._batchRosterSave ||
            window._desktopApplyingRemoteMatch;
        if (window.desktopAPI && !skipPublish) {
            DB._schedulePublishMatch(match);
        }
        if (!skipCloud && typeof window.syncToDB === 'function') {
            window.syncToDB('match', match);
        }
        if (!options.skipFilePersist) {
            _persistEntityFiles('match', match);
        }
    },
    _publishMatchTimer: null,
    _publishMatchQueued: null,
    _schedulePublishMatch(match) {
        DB._publishMatchQueued = match;
        clearTimeout(DB._publishMatchTimer);
        const delay = window.SLCRICK_DESKTOP ? 0 : 450;
        DB._publishMatchTimer = setTimeout(() => {
            const m = DB._publishMatchQueued;
            DB._publishMatchQueued = null;
            if (m && window.desktopAPI) window.desktopAPI.publishMatch(m);
        }, delay);
    },
    // New: specialized save that ensures we get a token back for new tournaments
    async saveTournamentWithAuth(tourn) {
        tourn.lastUpdated = Date.now();
        const pw = tourn.scoringPassword || tourn.password;
        if (tourn.id && pw) {
            try {
                localStorage.setItem(`tourn_pw_${tourn.id}`, pw);
            } catch (_) {}
        }
        const arr = this.getTournaments();
        const idx = arr.findIndex(t => t.id === tourn.id);
        if (idx !== -1) arr[idx] = tourn; else arr.push(tourn);
        this._secureSet(DB_KEYS.TOURNAMENTS, arr);

        localStorage.setItem('cricpro_force_update', Date.now().toString());
        if (window.desktopAPI) window.desktopAPI.publishTournament(tourn);
        if (typeof window.renderResumeMatches === 'function') window.renderResumeMatches();
        if (typeof window.syncToDB === 'function') {
            window.syncToDB('tournament', tourn);
        }
        _persistEntityFiles('tournament', tourn);
    },
    deleteMatch(id) {
        let arr = this.getMatches();
        arr = arr.filter(m => m.id !== id);
        this.saveMatches(arr);
        // Also remove reference from related tournament
        const tourns = this.getTournaments();
        tourns.forEach(t => {
            if (t.matches && t.matches.includes(id)) {
                t.matches = t.matches.filter(mId => mId !== id);
                this.saveTournament(t);
            }
        });
        if (window.desktopAPI?.deleteMatchFile) {
            window.desktopAPI.deleteMatchFile(id).catch(() => {});
        }
    },
    deleteMatchFromCloud(id) {},
    createMatch(config) {
        const match = {
            id: 'MATCH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            createdAt: Date.now(),
            status: 'setup', // setup | live | paused | completed
            publishLive: true, // Default to true so matches show up on mobile/others by default
            type: config.type || 'single', // single | tournament
            tournamentId: config.tournamentId || null,
            tournamentName: config.tournamentName || null,
            scoringPassword: config.scoringPassword || null,
            scorerName: config.scorerName || '',
            venue: config.venue || '',
            overs: parseInt(config.overs) || 20,
            ballsPerOver: parseInt(config.ballsPerOver) || 6,
            playersPerSide: parseInt(config.playersPerSide) || 11,
            team1: config.team1 || 'Team 1',
            team2: config.team2 || 'Team 2',
            tossWinner: config.tossWinner || config.team1,
            tossDecision: config.tossDecision || 'bat',
            // batting order
            battingFirst: config.battingFirst || config.team1,
            fieldingFirst: config.fieldingFirst || config.team2,
            // innings data
            matchFormat: config.matchFormat || 'limited',
            totalInnings: config.matchFormat === 'test' ? 4 : 2,
            innings: new Array(config.matchFormat === 'test' ? 4 : 2).fill(null),
            currentInnings: 0,
            // history stack for undo/redo
            history: [],
            redoStack: [],
        };
        // init first innings
        match.innings[0] = this.createInnings(match.battingFirst, match.fieldingFirst);
        this.saveMatch(match);
        return match;
    },

    // ---------- REPORTS ----------
    getMatchReports(matchId) {
        const all = this._secureGet(DB_KEYS.REPORTS, []);
        return all.filter(r => r.matchId === matchId).sort((a,b) => b.generatedAt - a.generatedAt);
    },

    saveMatchReport(report) {
        const all = this._secureGet(DB_KEYS.REPORTS, []);
        all.push(report);
        this._secureSet(DB_KEYS.REPORTS, all);
    },

    createInnings(battingTeam, bowlingTeam) {
        return {
            battingTeam,
            bowlingTeam,
            runs: 0, wickets: 0,
            balls: 0, // legal balls
            extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
            overHistory: [], // array of overs, each over = array of ball events
            currentOver: [],
            batsmen: [], // list of batsman objects
            bowlers: [], // list of bowling summary objects
            currentBatsmenIdx: [0, 1], // indices into batsmen[]
            strikerIdx: 0,
            currentBowlerIdx: null,
            fallOfWickets: [],
            partnerships: [],
            isDone: false,
            result: null,
        };
    },

    // ---------- REQUESTS ----------
    getRequests() {
        return this._secureGet('cricpro_requests', []);
    },
    saveRequests(arr) {
        this._secureSet('cricpro_requests', arr);
    },
    addRequest(req) {
        const arr = this.getRequests();
        req.id = 'REQ-' + Date.now();
        req.createdAt = Date.now();
        req.status = 'pending';
        arr.push(req);
        this.saveRequests(arr);
        return req;
    },

    // ---------- TOURNAMENTS ----------
    getTournaments() {
        return this._secureGet(DB_KEYS.TOURNAMENTS, []);
    },
    saveTournaments(arr) {
        this._secureSet(DB_KEYS.TOURNAMENTS, arr);
    },
    getTournament(id) {
        return this.getTournaments().find(t => t.id === id);
    },
    saveTournament(tourn, skipCloud = false, options = {}) {
        tourn.lastUpdated = Date.now();
        const pw = tourn.scoringPassword || tourn.password;
        if (tourn.id && pw) {
            try {
                localStorage.setItem(`tourn_pw_${tourn.id}`, pw);
            } catch (_) {}
        }
        const arr = this.getTournaments();
        const idx = arr.findIndex(t => t.id === tourn.id);
        if (idx !== -1) arr[idx] = tourn; else arr.push(tourn);
        this._secureSet(DB_KEYS.TOURNAMENTS, arr);
        if (!options.skipForceUpdate) {
            localStorage.setItem('cricpro_force_update', Date.now().toString());
        }
        const skipPublish = options.skipPublish || window._batchRosterSave;
        if (window.desktopAPI && !skipPublish) {
            window.desktopAPI.publishTournament(tourn);
        }
        if (!skipCloud && typeof window.syncToDB === 'function') {
            window.syncToDB('tournament', tourn);
        }
        if (!options.skipFilePersist) {
            _persistEntityFiles('tournament', tourn);
        }
    },
    deleteTournament(id) {
        // Cascade delete all matches belonging to this tournament
        let mArr = this.getMatches();
        const matchesToDelete = mArr.filter(m => m.tournamentId === id);
        mArr = mArr.filter(m => m.tournamentId !== id);
        this.saveMatches(mArr);
        
        // Sync match deletions to cloud

        // Delete the tournament record
        let arr = this.getTournaments();
        arr = arr.filter(t => t.id !== id);
        this.saveTournaments(arr);
    },
    deleteTournamentFromCloud(id) {},
    async createTournament(cfg) {
        const t = {
            id: 'TOURN-' + Date.now(),
            name: cfg.name,
            format: cfg.format || 'league',
            overs: cfg.overs || 20,
            ballsPerOver: cfg.ballsPerOver || 6,
            startDate: cfg.startDate || '',
            teams: cfg.teams || [],
            matches: [],
            standings: {},
            createdAt: Date.now(),
            status: 'scheduled',
            isOfficial: cfg.isOfficial || false,
            matchCount: cfg.matchCount || 0,
            totalTeams: cfg.totalTeams || cfg.teams.length,
            prizes: cfg.prizes || { first: '', second: '', third: '' },
            scoringPassword: cfg.scoringPassword || null,
            rosters: {},
        };

        if (t.format === 'knockout') {
            this._generateKnockoutMatches(t);
        } else if (cfg.matchCount > 0 || (t.format === 'league' && (cfg.teams || []).length >= 2)) {
            this._generateLeagueMatches(t, cfg);
        }
        
        // Save tournament and preserve scoring token if any
        await this.saveTournamentWithAuth(t);
        
        // Force UI refresh if available
        if (typeof renderOngoing === 'function') renderOngoing();
        if (typeof window.renderResumeMatches === 'function') window.renderResumeMatches();

        return t;
    },

    _generateLeagueMatches(t, cfg) {
        const teams = cfg.teams || t.teams || [];
        const pairs = [];
        for (let i = 0; i < teams.length; i++) {
            for (let j = i + 1; j < teams.length; j++) {
                pairs.push([teams[i], teams[j]]);
            }
        }
        const total = Math.max(cfg.matchCount || 0, pairs.length) || pairs.length;
        for (let i = 0; i < total; i++) {
            const pair = pairs[i];
            const match = this.createMatch({
                type: 'tournament',
                tournamentId: t.id,
                tournamentName: t.name,
                team1: pair ? pair[0] : 'TBD',
                team2: pair ? pair[1] : 'TBD',
                overs: t.overs,
                ballsPerOver: t.ballsPerOver,
                scoringPassword: t.scoringPassword,
            });
            match.status = 'scheduled';
            match.scheduledName = pair
                ? `${pair[0]} vs ${pair[1]}`
                : (i < pairs.length ? `Match ${i + 1}` : `Playoff / Final ${i - pairs.length + 1}`);
            match.publishLive = true;
            this.saveMatch(match);
            t.matches.push(match.id);
        }
    },

    _generateKnockoutMatches(t) {
        const N = t.totalTeams;
        const rounds = Math.ceil(Math.log2(N));
        const totalMatches = N - 1;
        
        let matchIndex = 1;
        let currentRoundTeams = [];
        
        // Populate initial teams (fill with 'TBD' if needed)
        for (let i = 0; i < N; i++) {
            currentRoundTeams.push(t.teams[i] || `Team ${i + 1}`);
        }

        let roundNodes = []; // Tracks matches in current round to link to next
        let prevRoundMatches = currentRoundTeams.map(name => ({ type: 'team', name }));

        for (let r = 1; r <= rounds; r++) {
            const nextRoundMatches = [];
            const roundMatchCount = Math.floor(prevRoundMatches.length / 2);
            
            for (let i = 0; i < roundMatchCount; i++) {
                const node1 = prevRoundMatches[i * 2];
                const node2 = prevRoundMatches[i * 2 + 1];
                
                const mName = (r === rounds) ? "Final 🏆" : 
                             (r === rounds - 1) ? `Semi-Final ${i + 1}` : 
                             `Round ${r} - Match ${matchIndex}`;
                
                const match = this.createMatch({
                    type: 'tournament', tournamentId: t.id, tournamentName: t.name,
                    team1: node1.type === 'team' ? node1.name : 'TBD',
                    team2: node2.type === 'team' ? node2.name : 'TBD',
                    overs: t.overs, ballsPerOver: t.ballsPerOver,
                    scoringPassword: t.scoringPassword
                });

                match.status = 'scheduled';
                match.scheduledName = mName;
                match.publishLive = true; // Tournament matches should be visible to everyone
                match.knockout = { round: r, matchNum: matchIndex, nextMatchIndex: null, slot: null };
                
                // Link predecessors to this match
                if (node1.type === 'match') { node1.ref.knockout.nextMatchId = match.id; node1.ref.knockout.slot = 1; this.saveMatch(node1.ref); }
                if (node2.type === 'match') { node2.ref.knockout.nextMatchId = match.id; node2.ref.knockout.slot = 2; this.saveMatch(node2.ref); }

                this.saveMatch(match);
                t.matches.push(match.id);
                nextRoundMatches.push({ type: 'match', id: match.id, ref: match });
                matchIndex++;
            }

            // Handle Byes (if odd numbered nodes)
            if (prevRoundMatches.length % 2 === 1) {
                nextRoundMatches.push(prevRoundMatches[prevRoundMatches.length - 1]);
            }
            prevRoundMatches = nextRoundMatches;
        }
    },

    // ---------- PRODUCTS ----------
    getProducts() {
        return this._secureGet(DB_KEYS.PRODUCTS, []);
    },
    saveProducts(arr, options = {}) {
        this._secureSet(DB_KEYS.PRODUCTS, arr);
        // Skip cloud push when data came from cloud polling to avoid sync loops.
        if (options.skipSync) return;
        // Sync every product to MongoDB so all devices see updates
        arr.forEach(p => syncProductToDB(p));
    },
    deleteProductFromCloud(id) {},

    deletePlayerFromCloud(id) {},
    // ---------- ORDERS ----------
    getOrders() {
        return this._secureGet(DB_KEYS.ORDERS, []);
    },
    saveOrders(arr) {
        this._secureSet(DB_KEYS.ORDERS, arr);
    },
    addOrder(order) {
        const arr = this.getOrders();
        order.id = 'ORD-' + Date.now();
        order.date = Date.now();
        order.status = 'pending';
        arr.push(order);
        this.saveOrders(arr);
        return order;
    },
    addTeamToSheets(team) {
    },

    // ---------- SETTINGS ----------
    getSettings() {
        return this._secureGet(DB_KEYS.SETTINGS, {});
    },
    saveSetting(key, val) {
        const s = this.getSettings();
        s[key] = val;
        this._secureSet(DB_KEYS.SETTINGS, s);
    },

    // ---------- POSTS ----------
    getPosts() {
        return this._secureGet(DB_KEYS.POSTS, []);
    },
    savePosts(arr) {
        this._secureSet(DB_KEYS.POSTS, arr);
        // Sync to cloud if needed
    },
    addPost(post) {
        const arr = this.getPosts();
        if (!post.id) post.id = 'POST-' + Date.now();
        if (!post.createdAt) post.createdAt = Date.now();
        arr.unshift(post); // Newest first
        this.savePosts(arr);
        return post;
    },
    clearMatchData(id) {
        if (!id) return;
        localStorage.removeItem('hotkey_match_id');
        localStorage.removeItem('hotkey_mode');
        // Clear local grants for this specific match
        const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
        delete grants[id];
        localStorage.setItem('cricpro_grants', JSON.stringify(grants));
        console.log(`🧹 Session data cleared for match: ${id}`);
    },

    _clearPhotoCacheKeys() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith('cricpro_photo_') || k.startsWith('cricpro_team_photo_'))) {
                keys.push(k);
            }
        }
        keys.forEach((k) => localStorage.removeItem(k));
        return keys.length;
    },

    _clearMatchDrawCache() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && /matchdraw|match_draw|matchDraw/i.test(k)) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
        return keys.length;
    },

    getStorageStats() {
        let photoBytes = 0;
        let dataBytes = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k) || '';
            const b = v.length * 2;
            if (k.startsWith('cricpro_photo_') || k.startsWith('cricpro_team_photo_')) {
                photoBytes += b;
            } else if (k.startsWith('cricpro_')) {
                dataBytes += b;
            }
        }
        return {
            matchCount: this.getMatches().length,
            tournamentCount: this.getTournaments().length,
            photoCacheMB: (photoBytes / 1024 / 1024).toFixed(2),
            dataMB: (dataBytes / 1024 / 1024).toFixed(2),
        };
    },

  /** Remove match data locally (+ cloud if connected). Keeps DB/sync settings intact. */
    async purgeAllMatchData(options = {}) {
        const {
            completedOnly = false,
            clearPhotos = true,
            clearReports = true,
            deleteFromCloud = true,
            syncTournaments = true,
        } = options;

        let matches = this.getMatches();
        const removing = completedOnly
            ? matches.filter((m) => m.status === 'completed')
            : matches.slice();
        const removedIds = new Set(removing.map((m) => m.id));

        for (const m of removing) {
            if (deleteFromCloud && typeof this.deleteMatchFromCloud === 'function') {
                this.deleteMatchFromCloud(m.id);
            }
            if (window.desktopAPI?.deleteMatchFile) {
                try {
                    await window.desktopAPI.deleteMatchFile(m.id);
                } catch (_) {}
            }
        }

        matches = matches.filter((m) => !removedIds.has(m.id));
        this.saveMatches(matches);

        if (syncTournaments) {
            this.getTournaments().forEach((t) => {
                if (!t.matches?.length) return;
                const next = t.matches.filter((id) => !removedIds.has(id));
                if (next.length !== t.matches.length) {
                    t.matches = next;
                    this.saveTournament(t, true);
                }
            });
        }

        if (clearReports) {
            if (completedOnly) {
                const reports = this._secureGet(DB_KEYS.REPORTS, []).filter(
                    (r) => !removedIds.has(r.matchId)
                );
                this._secureSet(DB_KEYS.REPORTS, reports);
            } else {
                this._secureSet(DB_KEYS.REPORTS, []);
            }
        }

        if (clearPhotos && !completedOnly) {
            this._clearPhotoCacheKeys();
        }

        if (!completedOnly) {
            this._clearMatchDrawCache();
            localStorage.removeItem('hotkey_match_id');
            localStorage.removeItem('hotkey_mode');
            if (window.desktopAPI?.purgeAllMatchFiles) {
                try {
                    await window.desktopAPI.purgeAllMatchFiles();
                } catch (_) {}
            }
        }

        localStorage.setItem('cricpro_force_update', Date.now().toString());
        if (window.desktopAPI?.requestPersist) window.desktopAPI.requestPersist();

        return { deletedCount: removing.length, remaining: matches.length };
    },

    clearPhotoCache() {
        const n = this._clearPhotoCacheKeys();
        if (window.desktopAPI?.requestPersist) window.desktopAPI.requestPersist();
        return n;
    },
};

window.DB = DB;
globalThis.DB = DB;

// ============================================================
//  Cloud sync — optional (js/sync-client.js, load after db.js)
// ============================================================
window.BACKEND_BASE_URL = window.BACKEND_BASE_URL || '';
window._isGlobalSyncCompleted = false;

DB.handshake = async function (id, password) {
    if (window.SLCRICK_SYNC?.handshake) return window.SLCRICK_SYNC.handshake(id, password);
    const pwd = String(password || '').trim();
    const stored = localStorage.getItem(`tourn_pw_${id}`);
    if (stored && String(stored).trim() === pwd) {
        const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
        grants[id] = true;
        localStorage.setItem('cricpro_grants', JSON.stringify(grants));
        return { ok: true, offline: true };
    }
    const type = id.startsWith('MATCH') ? 'match' : 'tournament';
    const obj = type === 'match' ? DB.getMatch(id) : DB.getTournament(id);
    if (!obj) return { ok: false, error: 'Not found' };
    const pw = obj.scoringPassword || obj.password;
    if (pw && String(pw).trim() === pwd) {
        const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
        grants[id] = true;
        localStorage.setItem('cricpro_grants', JSON.stringify(grants));
        if (type === 'tournament') localStorage.setItem(`tourn_pw_${id}`, pwd);
        return { ok: true };
    }
    if (!pw && !obj.isLocked) {
        const grants = JSON.parse(localStorage.getItem('cricpro_grants') || '{}');
        grants[id] = true;
        localStorage.setItem('cricpro_grants', JSON.stringify(grants));
        return { ok: true };
    }
    return { ok: false, error: 'Wrong password' };
};

window.pullGlobalData = async function (showFeedback) {
    if (window.SLCRICK_SYNC) return window.SLCRICK_SYNC.pullGlobalData(showFeedback);
    window._isGlobalSyncCompleted = true;
    if (typeof window.renderResumeMatches === 'function') window.renderResumeMatches();
    if (typeof renderOngoing === 'function') renderOngoing();
    return { ok: true, offline: true };
};

window.syncToDB = function () {};

// ================================================
// UTILITY FUNCTIONS (used across all pages)
// ================================================

function escapeHTML(str) {
    if (typeof str !== 'string') return str || '';
    return str.replace(/[&<>'"]/g, (tag) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag] || tag));
}

// Global Security: Sanitize all innerHTML assignments
const originalInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
if (originalInnerHTML) {
    Object.defineProperty(Element.prototype, 'innerHTML', {
        set: function(value) {
            let clean = typeof value === 'string' ? value : String(value);
            clean = clean.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
            clean = clean.replace(/<(object|embed|iframe|applet|meta|base)\b[^>]*>/gi, '');
            clean = clean.replace(/href\s*=\s*(['"]?)javascript:[^'"]*\1/gi, 'href="javascript:void(0);"');
            clean = clean.replace(/\bon(?!(click|change|input)\b)\w+\s*=\s*(['"])(.*?)\2/gi, '');
            return originalInnerHTML.set.call(this, clean);
        },
        get: function() { return originalInnerHTML.get.call(this); }
    });
}

function showToast(msg, type = 'default') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show ' + type; // Using space for simpler class handling
    if (type === 'error') t.classList.add('toast-error');
    if (type === 'success') t.classList.add('toast-success');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function formatCRR(runs, balls) { 
    const r = parseFloat(runs) || 0;
    const b = parseFloat(balls) || 0;
    if (!b) return '0.00'; 
    return ((r / b) * 6).toFixed(2); 
}
function formatOvers(balls, bpo = 6) { 
    const bls = parseInt(balls) || 0;
    const ov = Math.floor(bls/bpo); 
    const b = bls%bpo; 
    return `${ov}.${b}`; 
}
function formatSR(runs, balls) { 
    const r = parseFloat(runs) || 0;
    const b = parseFloat(balls) || 0;
    if (!b) return '0.0'; 
    return ((r / b) * 100).toFixed(1); 
}
function formatEcon(runs, balls, bpo = 6) { 
    const r = parseFloat(runs) || 0;
    const b = parseFloat(balls) || 0;
    if (!b) return '0.0'; 
    return ((r / b) * bpo).toFixed(1); 
}

function formatRRR(target, currentRuns, ballsLeft, bpo = 6) {
    const need = target - currentRuns;
    if (need <= 0) return '0.00';
    if (ballsLeft <= 0) return '∞';
    return ((need / ballsLeft) * bpo).toFixed(2);
}

// Global Image Error Handler
window.addEventListener('error', function(e) {
    if (e.target.tagName && e.target.tagName.toLowerCase() === 'img') {
        const img = e.target;
        img.style.display = 'none';
        const fallback = img.nextElementSibling;
        if (fallback && (fallback.classList.contains('product-svg-wrap') || fallback.classList.contains('svg-fallback-wrap'))) {
            fallback.style.display = 'flex';
        }
    }
}, true);

function timeSince(ts) {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return Math.round(d) + 's ago';
    if (d < 3600) return Math.round(d / 60) + 'm ago';
    if (d < 86400) return Math.round(d / 3600) + 'h ago';
    return Math.round(d / 86400) + 'd ago';
}

function showErrorInsideProgram(msg, url, lineNo) {
    let errBox = document.getElementById('cricpro-global-error');
    if (!errBox && document.body) {
        errBox = document.createElement('div');
        errBox.id = 'cricpro-global-error';
        errBox.style = 'position:fixed;top:20px;right:20px;z-index:99999;background:#d32f2f;color:#fff;padding:15px;border-radius:6px;width:300px;box-shadow:0 10px 30px rgba(0,0,0,0.5);font-size:12px;';
        errBox.innerHTML = `<div style="font-weight:900;mb:5px;display:flex;justify-content:space-between"><span>SYSTEM ERROR</span><span style="cursor:pointer" onclick="this.parentElement.parentElement.remove()">✖</span></div><div id="cricpro-error-text"></div>`;
        document.body.appendChild(errBox);
        setTimeout(() => errBox.remove(), 10000);
    }
    const txt = document.getElementById('cricpro-error-text');
    if (txt) txt.innerHTML += `<div>↳ ${msg} @ ${lineNo||'?'}</div>`;
}

/* Offline desktop — no service worker */

