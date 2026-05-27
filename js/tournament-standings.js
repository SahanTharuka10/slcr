/**
 * SLCRICKPRO — Tournament standings, NRR, points (shared: ongoing + score-match)
 */
(function (global) {
  function getTournamentMatches(tournId) {
    if (!tournId || !global.DB) return [];
    const map = new Map();
    global.DB.getMatches()
      .filter((m) => m && m.tournamentId === tournId)
      .forEach((m) => map.set(m.id, m));
    const t = global.DB.getTournament(tournId);
    (t?.matches || []).forEach((id) => {
      if (!map.has(id)) {
        const m = global.DB.getMatch(id);
        if (m) map.set(m.id, m);
      }
    });
    return [...map.values()];
  }

  function inferMatchWinner(m) {
    if (!m) return null;
    if (m.winner) return m.winner;
    if (m.status !== 'completed') return null;
    const inn0 = m.innings?.[0];
    const inn1 = m.innings?.[1];
    if (!inn0 || !inn1) return null;
    if (inn1.runs > inn0.runs) return inn1.battingTeam || m.team2;
    if (inn1.runs < inn0.runs) return inn0.battingTeam || m.team1;
    return null;
  }

  function ensureStandingTeam(t, teamName) {
    if (!teamName) return;
    if (!t.standings) t.standings = {};
    if (!t.standings[teamName]) {
      t.standings[teamName] = {
        name: teamName,
        played: 0,
        won: 0,
        lost: 0,
        tied: 0,
        points: 0,
        runsScored: 0,
        ballsFaced: 0,
        runsConceded: 0,
        ballsBowled: 0,
        nrr: 0,
      };
    }
    if (!t.teams) t.teams = [];
    if (!t.teams.includes(teamName)) t.teams.push(teamName);
  }

  function computeTournamentStandings(t) {
    if (!t || t.format === 'knockout' || !global.DB) return t;
    t.standings = {};
    (t.teams || []).forEach((team) => ensureStandingTeam(t, team));

    const matches = getTournamentMatches(t.id).filter((m) =>
      ['completed', 'live', 'paused'].includes(m.status)
    );

    matches.forEach((m) => {
      const team1 = m.team1;
      const team2 = m.team2;
      if (!team1 || !team2) return;
      ensureStandingTeam(t, team1);
      ensureStandingTeam(t, team2);
      const s1 = t.standings[team1];
      const s2 = t.standings[team2];

      if (m.status === 'completed') {
        s1.played++;
        s2.played++;
        const winner = inferMatchWinner(m);
        if (winner && t.standings[winner]) {
          t.standings[winner].won++;
          t.standings[winner].points += 2;
          const loser = winner === team1 ? team2 : team1;
          if (t.standings[loser]) t.standings[loser].lost++;
        } else if (m.resultType === 'tied') {
          s1.tied++;
          s2.tied++;
          s1.points++;
          s2.points++;
        } else if (m.resultType === 'abandoned') {
          s1.points++;
          s2.points++;
        } else {
          const inn0 = m.innings?.[0];
          const inn1 = m.innings?.[1];
          if (inn0 && inn1 && inn1.runs === inn0.runs) {
            s1.tied++;
            s2.tied++;
            s1.points++;
            s2.points++;
          }
        }
      }

      const inn0 = m.innings?.[0];
      const inn1 = m.innings?.[1];
      if (!inn0) return;

      const battingFirst = m.battingFirst || team1;
      const bpo = m.ballsPerOver || t.ballsPerOver || 6;
      const maxBalls = (m.overs || t.overs || 20) * bpo;
      const pps = m.playersPerSide || 11;

      if (!inn1) {
        const batTeam = inn0.battingTeam || battingFirst;
        const bowlTeam = batTeam === team1 ? team2 : team1;
        const batS = t.standings[batTeam];
        const bowlS = t.standings[bowlTeam];
        if (batS && bowlS) {
          const batBalls = inn0.wickets >= pps - 1 ? maxBalls : inn0.balls || 0;
          batS.runsScored += inn0.runs || 0;
          batS.ballsFaced += batBalls;
          bowlS.runsConceded += inn0.runs || 0;
          bowlS.ballsBowled += batBalls;
        }
        return;
      }

      const b0 = inn0.wickets >= pps - 1 ? maxBalls : inn0.balls || 0;
      const b1 = inn1.wickets >= pps - 1 ? maxBalls : inn1.balls || 0;
      const inn0Bat = inn0.battingTeam || battingFirst;

      if (inn0Bat === team1) {
        s1.runsScored += inn0.runs || 0;
        s1.ballsFaced += b0;
        s2.runsConceded += inn0.runs || 0;
        s2.ballsBowled += b0;
        s2.runsScored += inn1.runs || 0;
        s2.ballsFaced += b1;
        s1.runsConceded += inn1.runs || 0;
        s1.ballsBowled += b1;
      } else {
        s2.runsScored += inn0.runs || 0;
        s2.ballsFaced += b0;
        s1.runsConceded += inn0.runs || 0;
        s1.ballsBowled += b0;
        s1.runsScored += inn1.runs || 0;
        s1.ballsFaced += b1;
        s2.runsConceded += inn1.runs || 0;
        s2.ballsBowled += b1;
      }
    });

    t.teams.forEach((team) => {
      const s = t.standings[team];
      if (!s) return;
      const bpo = t.ballsPerOver || 6;
      const batRR = s.ballsFaced ? s.runsScored / (s.ballsFaced / bpo) : 0;
      const bowlRR = s.ballsBowled ? s.runsConceded / (s.ballsBowled / bpo) : 0;
      s.nrr = parseFloat((batRR - bowlRR).toFixed(3));
    });

    try {
      global.DB.saveTournament(t, true, { skipPublish: !!global.SLCRICK_DESKTOP });
    } catch (_) {}
    try {
      global.localStorage.setItem('cricpro_force_update', String(Date.now()));
    } catch (_) {}
    return t;
  }

  global.getTournamentMatches = getTournamentMatches;
  global.inferMatchWinner = inferMatchWinner;
  global.computeTournamentStandings = computeTournamentStandings;
})(typeof window !== 'undefined' ? window : globalThis);
