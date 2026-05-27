/**
 * SLCRICKPRO — Manual stat report bundle (desktop export → site admin upload)
 * Format: slcrickpro-stat-bundle v1
 */
(function (global) {
  const FORMAT = 'slcrickpro-stat-bundle';
  const VERSION = 1;

  function sanitizeFilenamePart(s) {
    return String(s || 'match')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'match';
  }

  function validate(bundle) {
    if (!bundle || typeof bundle !== 'object') throw new Error('Invalid file — not JSON object');
    if (bundle.format !== FORMAT) {
      throw new Error('Wrong file type — use a .slcrick-stat.json exported from SLCRICKPRO desktop');
    }
    if (bundle.version !== VERSION) {
      throw new Error('Unsupported stat bundle version: ' + bundle.version);
    }
    if (!bundle.match || !bundle.match.id) throw new Error('Bundle missing match data');
    if (bundle.match.status !== 'completed') {
      throw new Error('Only completed match stat reports can be imported');
    }
    if (!bundle.match.innings || !bundle.match.innings[0]) {
      throw new Error('Bundle match has no innings data');
    }
    return true;
  }

  function exportFromMatch(matchId) {
    if (!global.DB) throw new Error('Database not loaded');
    const m = global.DB.getMatch(matchId);
    if (!m) throw new Error('Match not found');
    if (m.status !== 'completed') {
      throw new Error('Only completed matches can be exported. Finish scoring first.');
    }
    const t = m.tournamentId ? global.DB.getTournament(m.tournamentId) : null;
    const reports =
      typeof global.DB.getMatchReports === 'function'
        ? global.DB.getMatchReports(matchId)
        : [];
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: Date.now(),
      source: global.SLCRICK_DESKTOP ? 'desktop' : 'web',
      tournament: t ? JSON.parse(JSON.stringify(t)) : null,
      match: JSON.parse(JSON.stringify(m)),
      report: reports.length ? reports[0] : null,
    };
  }

  function suggestFilename(bundle) {
    const m = bundle.match;
    const tName = bundle.tournament?.name || 'tournament';
    const teams = `${m.team1 || 'T1'}-vs-${m.team2 || 'T2'}`;
    const date = new Date(bundle.exportedAt || Date.now()).toISOString().slice(0, 10);
    return `${sanitizeFilenamePart(tName)}-${sanitizeFilenamePart(teams)}-${date}.slcrick-stat.json`;
  }

  function downloadBundle(bundle) {
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestFilename(bundle);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function mergeTournamentFromBundle(bundleTourn, matchId) {
    if (!bundleTourn?.id || !global.DB) return null;
    let t = global.DB.getTournament(bundleTourn.id);
    if (!t) {
      t = JSON.parse(JSON.stringify(bundleTourn));
    } else {
      (bundleTourn.teams || []).forEach((team) => {
        if (team && !t.teams.includes(team)) t.teams.push(team);
      });
      if (bundleTourn.standings && typeof bundleTourn.standings === 'object') {
        t.standings = t.standings || {};
        Object.assign(t.standings, bundleTourn.standings);
      }
    }
    if (!t.matches) t.matches = [];
    if (!t.matches.includes(matchId)) t.matches.push(matchId);
    return t;
  }

  /**
   * Import bundle into local DB. On web admin, optionally push once to cloud (not auto from desktop).
   */
  async function importBundle(bundle, options = {}) {
    validate(bundle);
    const { expectedTournamentId = null, pushToCloud = false } = options;
    const match = JSON.parse(JSON.stringify(bundle.match));
    match.status = 'completed';
    // Show on site standings, fixtures, NRR, and leaderboards (not a hidden draft).
    match.publishLive = match.type === 'tournament' ? true : match.publishLive !== false;

    if (expectedTournamentId && match.tournamentId && match.tournamentId !== expectedTournamentId) {
      throw new Error(
        'This stat file belongs to a different tournament. Upload it under the correct tournament.'
      );
    }

    const existing = global.DB.getMatch(match.id);
    // Completed stat file from desktop is authoritative — replace stale local live/paused rows.
    if (existing && (existing.status === 'live' || existing.status === 'paused')) {
      match.scoringStartedAt = existing.scoringStartedAt || match.scoringStartedAt;
      if (!match.result && existing.result) match.result = existing.result;
    }

    global.DB.saveMatch(match, true, { skipPublish: true });

    let t = null;
    if (bundle.tournament) {
      t = mergeTournamentFromBundle(bundle.tournament, match.id);
      if (t && typeof global.computeTournamentStandings === 'function') {
        global.computeTournamentStandings(t);
      } else if (t) {
        global.DB.saveTournament(t, true, { skipPublish: true });
      }
    }

    if (bundle.report && typeof global.DB.saveMatchReport === 'function') {
      try {
        global.DB.saveMatchReport(bundle.report);
      } catch (_) {}
    }

    if (pushToCloud && typeof global.syncToDB === 'function' && !global.SLCRICK_DESKTOP) {
      const mPayload = {
        ...match,
        publishLive: match.publishLive !== false,
        _manualStatUpload: true,
        _isBackgroundSync: true,
      };
      await global.syncToDB('match', mPayload);
      if (t) {
        await global.syncToDB('tournament', { ...t, _isBackgroundSync: true });
      }
    }

    try {
      global.localStorage.setItem('cricpro_force_update', String(Date.now()));
    } catch (_) {}

    if (typeof global.refreshTournamentStandingsUI === 'function') {
      global.refreshTournamentStandingsUI();
    }
    if (typeof global.refreshTournamentFixturesUI === 'function') {
      global.refreshTournamentFixturesUI();
    }
    if (typeof global.renderOngoing === 'function') global.renderOngoing();
    if (typeof global.updateTicker === 'function') global.updateTicker();

    return { match, tournament: t };
  }

  async function importFromFile(file, options = {}) {
    const text = await file.text();
    let bundle;
    try {
      bundle = JSON.parse(text);
    } catch (_) {
      throw new Error('Could not read file — must be valid JSON');
    }
    return importBundle(bundle, options);
  }

  const api = {
    FORMAT,
    VERSION,
    validate,
    exportFromMatch,
    suggestFilename,
    downloadBundle,
    importBundle,
    importFromFile,
  };

  global.MatchStatBundle = api;
  global.downloadMatchStatBundle = function downloadMatchStatBundle(matchId) {
    try {
      const bundle = exportFromMatch(matchId);
      downloadBundle(bundle);
      if (typeof global.showToast === 'function') {
        global.showToast('Stat report downloaded — upload in site Admin → Tournaments', 'success');
      }
    } catch (e) {
      const msg = e.message || 'Export failed';
      if (typeof global.showToast === 'function') global.showToast(msg, 'error');
      else alert(msg);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
