window.renderOngoing = function() {
    console.log("🔄 Home Ticker refreshing from Global Sync...");
    updateTicker();
};

function runHomeAutoSync() {
    if (window.SLCRICK_SYNC?.syncCloudData) {
        window.SLCRICK_SYNC.syncCloudData({ silent: true }).catch(() => {});
        return;
    }
    if (typeof window.pullGlobalData === 'function') {
        window.pullGlobalData(false).catch(() => {});
    }
}

function hasActiveLiveOnSite() {
    if (typeof DB === 'undefined' || !DB?.getMatches) return false;
    return DB.getMatches().some((m) =>
        DB.isActivelyScoredMatch ? DB.isActivelyScoredMatch(m) : m.status === 'live' || m.status === 'paused'
    );
}

document.addEventListener('DOMContentLoaded', () => {
    runHomeAutoSync();
    const syncTick = () => {
        runHomeAutoSync();
        const ms = hasActiveLiveOnSite() ? 3500 : 20000;
        setTimeout(syncTick, ms);
    };
    setTimeout(syncTick, 3500);
    window.addEventListener('storage', (e) => {
        if (e.key === 'cricpro_force_update') updateTicker();
    });
    window.addEventListener('slcrick-live-update', () => updateTicker());
    initParticles();
    updateClock();
    setInterval(updateClock, 1000);
    updateTicker();
    setInterval(() => {
        if (hasActiveLiveOnSite()) updateTicker();
    }, 4000);
});

function initParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    
    // Reduce particle count on mobile (15 vs 40)
    const isMobile = window.innerWidth < 768;
    const count = isMobile ? 15 : 40;

    for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const size = Math.random() * 3 + 1;
        p.style.cssText = `
      left: ${Math.random() * 100}%;
      top: ${Math.random() * 100}%;
      width: ${size}px;
      height: ${size}px;
      opacity: ${Math.random() * 0.5 + 0.1};
      animation-duration: ${Math.random() * 20 + 10}s;
      animation-delay: ${Math.random() * -20}s;
    `;
        container.appendChild(p);
    }
}

function updateClock() {
    // Check both potential IDs used in different templates
    const el = document.getElementById('live-clock') || document.getElementById('current-time') || document.getElementById('overlay-live-clock');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function getTickerInnings(m) {
    const innings = Array.isArray(m?.innings) ? m.innings.filter(Boolean) : [];
    const idx =
        Number.isFinite(m?.currentInnings) && m.currentInnings >= 0
            ? m.currentInnings
            : 0;
    return { innings, inn: innings[idx] || innings[0] || null, idx };
}

function updateTicker() {
    const container = document.getElementById('live-cards-container');
    const panel = document.getElementById('top-live-panel');
    if (!container || !panel) return;
    if (typeof DB === 'undefined' || !DB?.getMatches) return;

    const matches = DB.getMatches()
        .filter((m) => (DB.isActivelyScoredMatch ? DB.isActivelyScoredMatch(m) : false))
        .sort(
            (a, b) =>
                (b.lastUpdated || b.scoringStartedAt || 0) - (a.lastUpdated || a.scoringStartedAt || 0)
        );

    if (!matches.length) {
        panel.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    panel.style.display = 'block';
    
    container.innerHTML = matches.map(m => {
        const { innings, inn, idx: currentInnings } = getTickerInnings(m);
        if (!inn) return '';

        let innText = '';
        {
            if (currentInnings === 0) innText = '1ST INNINGS IN PROGRESS';
            else if (currentInnings === 1) innText = '2ND INNINGS IN PROGRESS';
            else innText = 'INNINGS IN PROGRESS';

            if (currentInnings === 1 && innings[0]) {
                const target = (innings[0].runs || 0) + 1;
                const needs = target - (inn.runs || 0);
                if (needs > 0) {
                    innText = `${inn.battingTeam || 'Batting side'} NEEDS ${needs} RUNS`;
                } else if (needs <= 0) {
                    innText = 'SCORES LEVEL';
                }
            }
        }

        const teamA = m.team1 || 'Team 1';
        const teamB = m.team2 || 'Team 2';
        
        // Determine scores for Team A and Team B
        let aScoreHTML = '<span class="live-yet-to-bat">YET TO BAT</span>';
        let bScoreHTML = '<span class="live-yet-to-bat">YET TO BAT</span>';

        if (inn.battingTeam === teamA) {
                aScoreHTML = `${inn.runs}-${inn.wickets} <span class="live-team-overs">(${formatOvers(inn.balls, m.ballsPerOver)} ov)</span>`;
                if (currentInnings === 1 && innings[0]) {
                    const prevInn = innings[0];
                    bScoreHTML = `${prevInn.runs}-${prevInn.wickets} <span class="live-team-overs">(${formatOvers(prevInn.balls, m.ballsPerOver)} ov)</span>`;
                }
            } else if (inn.battingTeam === teamB) {
                bScoreHTML = `${inn.runs}-${inn.wickets} <span class="live-team-overs">(${formatOvers(inn.balls, m.ballsPerOver)} ov)</span>`;
                if (currentInnings === 1 && innings[0]) {
                    const prevInn = innings[0];
                    aScoreHTML = `${prevInn.runs}-${prevInn.wickets} <span class="live-team-overs">(${formatOvers(prevInn.balls, m.ballsPerOver)} ov)</span>`;
                }
            }

        let tournName = (m.tournamentName || 'Live match') + ' - LIVE';

        const matchId = m.id || '';
        const linkURL = `pages/score-match.html?matchId=${matchId}`;

        return `
        <div class="live-match-card" onclick="if('${linkURL}' !== '#') window.location.href='${linkURL}'">
            <div class="live-card-header">${tournName}</div>
            <div class="live-card-body">
                <div class="live-team-row">
                    <div class="live-team-name">${teamA}</div>
                    <div class="live-team-score">${aScoreHTML}</div>
                </div>
                <div class="live-team-row">
                    <div class="live-team-name">${teamB}</div>
                    <div class="live-team-score">${bScoreHTML}</div>
                </div>
            </div>
            <div class="live-card-footer">${innText}</div>
        </div>
        `;
    }).join('');
}

function formatOvers(balls, bpo = 6) {
    return `${Math.floor(balls / bpo)}.${balls % bpo}`;
}

function formatCRR(runs, balls, bpo = 6) {
    return balls ? (runs / (balls / bpo)).toFixed(2) : '0.00';
}

// ========== GLOBAL SYNC HANDLER ==========
window.renderOngoing = updateTicker;

// Handle cross-tab updates (e.g. from score-match.html)
window.addEventListener('storage', (e) => {
    if (e.key === 'cricpro_force_update') {
        updateTicker();
    }
});

// Instant live score from cloud (desktop scorer → Render → Socket.IO)
window.addEventListener('slcrick-live-update', () => updateTicker());
