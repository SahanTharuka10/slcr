/* ================================================================
 *  SLCRICKPRO – web scorer (score.html)
 *  Single match or a small round-robin tournament, scored on any phone.
 *  Matches use the same JSON shape as the desktop app, so the site's
 *  scorecard / PDF / live pages work for both.
 * ================================================================ */
(function () {
  'use strict';
  const esc = SLC.esc;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const app = $('#ws');
  const STORE = 'slc_web_scorer_v1';
  const WICKETS = ['Bowled', 'Caught', 'LBW', 'Run Out', 'Stumped', 'Hit Wicket'];

  // ── persistence ───────────────────────────────────────────────
  let db = { matches: {}, tourneys: {}, keys: {}, current: '' };
  try { db = { ...db, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (_) {}
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(db)); } catch (_) { SLC.toast('Storage full — delete old matches', 'error'); } };
  const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const cur = () => db.matches[db.current] || null;
  const inn = (m) => (m ? m.innings[m.currentInnings] : null);

  // ── engine ────────────────────────────────────────────────────
  function newInnings(bat, bowl) {
    return { battingTeam: bat, bowlingTeam: bowl, runs: 0, wickets: 0, balls: 0, extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
      overHistory: [], currentOver: [], batsmen: [], bowlers: [], currentBatsmenIdx: [null, null], strikerIdx: 0, currentBowlerIdx: null,
      fallOfWickets: [], partnerships: [], currentPartnership: { runs: 0, balls: 0 }, isDone: false };
  }
  const bat = (name) => ({ name, runs: 0, balls: 0, fours: 0, sixes: 0, notOut: true, dismissal: null });

  function snapshot(m) {
    m.history = m.history || [];
    m.history.push(JSON.stringify({ innings: m.innings, currentInnings: m.currentInnings, status: m.status, result: m.result, winner: m.winner }));
    if (m.history.length > 80) m.history.shift();
  }
  function undo() {
    const m = cur();
    if (!m || !m.history || !m.history.length) return SLC.toast('Nothing to undo', 'error');
    Object.assign(m, JSON.parse(m.history.pop()));
    commit(m);
    SLC.toast('Undone');
  }

  function bowlerOf(i) { return i.currentBowlerIdx != null ? i.bowlers[i.currentBowlerIdx] : null; }
  function striker(i) { return i.batsmen[i.currentBatsmenIdx[i.strikerIdx]]; }
  function rotate(i) { i.strikerIdx = i.strikerIdx ? 0 : 1; }
  const maxBalls = (m) => m.overs * m.ballsPerOver;

  function record(m, ev) {
    const i = inn(m);
    const b = striker(i);
    const bw = bowlerOf(i);
    const r = ev.runs || 0;
    snapshot(m);
    if (ev.type === 'wide') {
      const total = 1 + r;
      i.runs += total; i.extras.wides += total; bw.runs += total;
      i.currentPartnership.runs += total;
      i.currentOver.push({ type: 'wide', runs: total, legal: false });
      if (r % 2) rotate(i);
    } else if (ev.type === 'noball') {
      i.runs += 1 + r; i.extras.noBalls += 1; bw.runs += 1 + r;
      b.runs += r; b.balls++; if (r === 4) b.fours++; if (r === 6) b.sixes++;
      i.currentPartnership.runs += 1 + r;
      i.currentOver.push({ type: 'noball', runs: r, legal: false });
      if (r % 2) rotate(i);
    } else if (ev.type === 'bye' || ev.type === 'legbye') {
      i.runs += r; i.balls++; b.balls++; bw.balls++;
      i.extras[ev.type === 'bye' ? 'byes' : 'legByes'] += r;
      i.currentPartnership.runs += r; i.currentPartnership.balls++;
      i.currentOver.push({ type: ev.type, runs: r, legal: true });
      if (r % 2) rotate(i);
    } else if (ev.type === 'wicket') {
      const slot = ev.slot;
      const outIdx = i.currentBatsmenIdx[slot];
      const out = i.batsmen[outIdx];
      i.runs += r; i.balls++; i.wickets++; bw.balls++; bw.runs += r;
      b.balls++; b.runs += r;
      if (ev.how !== 'Run Out') bw.wickets++;
      out.notOut = false;
      out.dismissal = ev.how === 'Bowled' ? `b ${bw.name}` : ev.how === 'Caught' ? `c ${ev.fielder || '?'} b ${bw.name}` : ev.how === 'LBW' ? `lbw b ${bw.name}`
        : ev.how === 'Stumped' ? `st ${ev.fielder || '?'} b ${bw.name}` : ev.how === 'Run Out' ? `run out (${ev.fielder || '?'})` : `hit wicket b ${bw.name}`;
      i.fallOfWickets.push({ runs: i.runs, balls: i.balls, batsmanName: out.name, wicketType: ev.how });
      i.partnerships.push({ ...i.currentPartnership, batsman1: out.name });
      i.currentPartnership = { runs: 0, balls: 0 };
      i.currentOver.push({ type: 'run', runs: r, wicket: true, legal: true });
      if (r % 2) rotate(i);
      if (i.wickets < m.playersPerSide - 1 && ev.next) {
        i.batsmen.push(bat(ev.next));
        i.currentBatsmenIdx[slot] = i.batsmen.length - 1;
      } else {
        i.currentBatsmenIdx[slot] = null;
      }
    } else {
      i.runs += r; i.balls++; b.runs += r; b.balls++; bw.runs += r; bw.balls++;
      if (r === 4) b.fours++;
      if (r === 6) b.sixes++;
      i.currentPartnership.runs += r; i.currentPartnership.balls++;
      i.currentOver.push({ type: r === 4 ? 'four' : r === 6 ? 'six' : r ? 'run' : 'dot', runs: r, legal: true });
      if (r % 2) rotate(i);
    }
    // end of over
    const legal = i.currentOver.filter((x) => x.legal !== false).length;
    if (legal >= m.ballsPerOver) {
      if (!i.currentOver.some((x) => (x.type === 'run' || x.type === 'four' || x.type === 'six' || x.type === 'wide' || x.type === 'noball') && x.runs)) bw.maidens = (bw.maidens || 0) + 1;
      i.overHistory.push(i.currentOver);
      i.currentOver = [];
      i.currentBowlerIdx = null;
      rotate(i);
    }
    checkInningsEnd(m);
    commit(m);
  }

  function target(m) {
    return m.currentInnings === 1 && m.innings[0] ? m.innings[0].runs + 1 : null;
  }

  function checkInningsEnd(m) {
    const i = inn(m);
    const t = target(m);
    if (i.wickets >= m.playersPerSide - 1 || i.balls >= maxBalls(m) || (t && i.runs >= t)) {
      i.isDone = true;
      (i.batsmen || []).forEach((b) => { if (!b.dismissal) b.notOut = true; });
      if (m.currentInnings === 1) finish(m);
    }
  }

  function finish(m) {
    const a = m.innings[0];
    const b = m.innings[1];
    m.status = 'completed';
    if (b.runs > a.runs) {
      m.winner = b.battingTeam;
      const w = m.playersPerSide - 1 - b.wickets;
      m.result = `${b.battingTeam} won by ${w} wicket${w === 1 ? '' : 's'}`;
    } else if (a.runs > b.runs) {
      m.winner = a.battingTeam;
      const d = a.runs - b.runs;
      m.result = `${a.battingTeam} won by ${d} run${d === 1 ? '' : 's'}`;
    } else {
      m.winner = '';
      m.result = 'Match tied';
    }
    m.completedAt = Date.now();
  }

  // ── online sync (optional) ───────────────────────────────────
  const pushTimers = {};
  function push(m, force) {
    if (!m || (!m.online && !force)) return Promise.resolve();
    clearTimeout(pushTimers[m.id]);
    return new Promise((resolve) => {
      pushTimers[m.id] = setTimeout(async () => {
        const copy = { ...m, history: undefined };
        try {
          const key = db.keys[m.id];
          const r = key
            ? await SLC.api(`/matches/${encodeURIComponent(m.id)}`, { method: 'PUT', key, body: { match: copy } })
            : await SLC.api('/matches', { body: { match: copy } });
          if (r.key) { db.keys[m.id] = r.key; save(); }
          m.uploaded = true;
          save();
          resolve(true);
        } catch (e) {
          if (force) SLC.toast(`Upload failed: ${e.message}`, 'error');
          resolve(false);
        }
      }, force ? 0 : 1500);
    });
  }

  function commit(m) {
    m.lastUpdated = Date.now();
    db.matches[m.id] = m;
    save();
    push(m);
    route();
  }

  // ── UI helpers ────────────────────────────────────────────────
  function sheet(title, html, mount) {
    let el = $('#ws-sheet');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ws-sheet';
      el.className = 'ws-sheet';
      el.innerHTML = '<div class="ws-sheet-bg" data-x></div><div class="ws-sheet-card"><h2></h2><div class="ws-sheet-body"></div></div>';
      el.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) close(); });
      document.body.appendChild(el);
    }
    $('h2', el).textContent = title;
    $('.ws-sheet-body', el).innerHTML = html;
    el.classList.add('is-open');
    if (mount) mount($('.ws-sheet-body', el));
  }
  function close() { const el = $('#ws-sheet'); if (el) el.classList.remove('is-open'); }
  const seg = (name, vals, on, fmt) => `<div class="f-seg" data-seg="${name}">${vals.map((v) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(on) ? 'is-on' : ''}">${esc(fmt ? fmt(v) : v)}</button>`).join('')}</div>`;
  function wireSeg(root) {
    $$('[data-seg]', root).forEach((row) => row.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      $$('button', row).forEach((x) => x.classList.toggle('is-on', x === b));
    }));
  }
  const segVal = (root, name) => { const b = $(`[data-seg="${name}"] button.is-on`, root); return b ? b.dataset.v : null; };

  // ── screens ───────────────────────────────────────────────────
  function route() {
    const m = cur();
    if (location.hash === '#new') return screenSetup();
    if (location.hash.startsWith('#tourney=')) return screenTourney(location.hash.slice(9));
    if (location.hash === '#tourney-new') return screenTourneyNew();
    if (!m) return screenHome();
    const i = inn(m);
    if (m.status === 'completed') return screenResult(m);
    if (i.isDone) return screenBreak(m);
    if (i.currentBatsmenIdx[0] == null || i.currentBatsmenIdx[1] == null || i.currentBowlerIdx == null) return screenPlay(m, true);
    return screenPlay(m);
  }
  window.addEventListener('hashchange', route);

  function screenHome() {
    const list = Object.values(db.matches).sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0)).slice(0, 12);
    const tours = Object.values(db.tourneys);
    app.innerHTML = `
      <h1 class="s-h1">Score a match</h1>
      <p class="s-sub">Free scorer for your phone. At the end, download the match summary PDF.</p>
      <div class="h-options" style="margin-top:0">
        <a class="h-opt h-opt--score" href="#new"><span class="h-ico">${SLC.icon('score')}</span><b>Single match</b><span>Two teams, set the overs, score ball by ball.</span><i>Start</i></a>
        <a class="h-opt h-opt--past" href="#tourney-new"><span class="h-ico">${SLC.icon('past')}</span><b>Small tournament</b><span>Up to 8 teams, round robin with a points table.</span><i>Create</i></a>
      </div>
      ${tours.length ? `<h2 class="s-h2">Your tournaments</h2><div class="m-grid">${tours.map((t) => `<a class="m-card" href="#tourney=${t.id}"><b>${esc(t.name)}</b><span class="m-note">${t.teams.length} teams · ${t.overs} overs · ${t.fixtures.filter((f) => db.matches[f.matchId] && db.matches[f.matchId].status === 'completed').length}/${t.fixtures.length} played</span></a>`).join('')}</div>` : ''}
      ${list.length ? `<h2 class="s-h2">Recent on this phone</h2><div class="m-grid">${list.map((m) => `
        <button class="m-card" style="text-align:left;border:0;cursor:pointer;font:inherit;color:inherit" data-open="${m.id}">
          <div class="m-head"><span>${esc(m.tournamentName || 'Single match')}</span>${SLC.statusTag(m.status)}</div>
          <div class="m-row"><b>${esc(m.team1)} v ${esc(m.team2)}</b></div>
          ${m.result ? `<div class="m-result">${esc(m.result)}</div>` : ''}
        </button>`).join('')}</div>` : ''}`;
    $$('[data-open]').forEach((b) => b.onclick = () => { db.current = b.dataset.open; save(); route(); });
  }

  function screenSetup(pre = {}) {
    app.innerHTML = `
      <h1 class="s-h1">New match</h1>
      <div class="f-card">
        <div class="f-row">
          <label class="f-field"><span>Team 1</span><input id="s-t1" maxlength="40" value="${esc(pre.team1 || '')}" placeholder="Team name"></label>
          <label class="f-field"><span>Team 2</span><input id="s-t2" maxlength="40" value="${esc(pre.team2 || '')}" placeholder="Team name"></label>
        </div>
        <div class="f-field"><span>Overs</span>${seg('ov', [2, 5, 6, 8, 10, 15, 20], pre.overs || 6)}</div>
        <div class="f-row">
          <label class="f-field"><span>Players per side</span><input id="s-pps" type="number" min="2" max="15" value="${pre.playersPerSide || 11}"></label>
          <label class="f-field"><span>Balls per over</span><input id="s-bpo" type="number" min="4" max="10" value="6"></label>
        </div>
        <label class="f-field"><span>Venue (optional)</span><input id="s-venue" maxlength="60"></label>
        <div class="f-field"><span>Toss won by</span><div class="f-seg" id="s-toss"><button type="button" data-v="1">Team 1</button><button type="button" data-v="2">Team 2</button></div></div>
        <div class="f-field"><span>Elected to</span>${seg('dec', ['bat', 'bowl'], 'bat', (v) => (v === 'bat' ? 'Bat' : 'Bowl'))}</div>
        <div class="f-field"><span>Show on slcrickpro.live</span>${seg('online', ['no', 'yes'], 'no', (v) => (v === 'yes' ? 'Online (live on site)' : 'This phone only'))}</div>
        <button class="s-btn s-btn--primary s-btn--lg s-btn--block" id="s-go">Start match →</button>
      </div>`;
    wireSeg(app);
    const toss = $('#s-toss');
    toss.onclick = (e) => { const b = e.target.closest('button'); if (b) $$('button', toss).forEach((x) => x.classList.toggle('is-on', x === b)); };
    const syncNames = () => { const [a, b] = $$('#s-toss button'); a.textContent = $('#s-t1').value || 'Team 1'; b.textContent = $('#s-t2').value || 'Team 2'; };
    $('#s-t1').oninput = syncNames; $('#s-t2').oninput = syncNames; syncNames();
    $('#s-go').onclick = () => {
      const t1 = $('#s-t1').value.trim(), t2 = $('#s-t2').value.trim();
      if (!t1 || !t2 || t1.toLowerCase() === t2.toLowerCase()) return SLC.toast('Enter two different team names', 'error');
      const tw = $('#s-toss button.is-on');
      if (!tw) return SLC.toast('Who won the toss?', 'error');
      const winner = tw.dataset.v === '1' ? t1 : t2, other = winner === t1 ? t2 : t1;
      const dec = segVal(app, 'dec');
      const batFirst = dec === 'bat' ? winner : other;
      const m = {
        id: uid('WEB'), createdAt: Date.now(), status: 'live', type: pre.tournamentId ? 'tournament' : 'single',
        tournamentId: pre.tournamentId || null, tournamentName: pre.tournamentName || null,
        team1: t1, team2: t2, overs: parseInt(segVal(app, 'ov'), 10) || 6, ballsPerOver: parseInt($('#s-bpo').value, 10) || 6,
        playersPerSide: parseInt($('#s-pps').value, 10) || 11, venue: $('#s-venue').value.trim(), tossWinner: winner, tossDecision: dec,
        battingFirst: batFirst, fieldingFirst: batFirst === t1 ? t2 : t1, totalInnings: 2, currentInnings: 0,
        innings: [newInnings(batFirst, batFirst === t1 ? t2 : t1), null], online: segVal(app, 'online') === 'yes', history: [], source: 'web',
      };
      db.current = m.id;
      if (pre.fixture) pre.fixture.matchId = m.id;
      history.replaceState(null, '', location.pathname);
      commit(m);
    };
  }

  function namesPrompt(m) {
    const i = inn(m);
    const needBat = i.currentBatsmenIdx[0] == null || i.currentBatsmenIdx[1] == null;
    const first = !i.batsmen.length;
    const prevBowler = i.overHistory.length ? (i.bowlers[(i.overHistory[i.overHistory.length - 1].bowlerIdx)] || {}).name : '';
    const lastBowler = i.lastBowler || prevBowler;
    sheet(first ? 'Openers & bowler' : needBat ? 'New batter' : `Over ${Math.floor(i.balls / m.ballsPerOver) + 1} — bowler`, `
      ${needBat && first ? `<label class="f-field"><span>Striker</span><input id="p-s" maxlength="40" placeholder="Batter 1"></label><label class="f-field"><span>Non-striker</span><input id="p-ns" maxlength="40" placeholder="Batter 2"></label>` : ''}
      ${needBat && !first ? `<label class="f-field"><span>New batter</span><input id="p-nb" maxlength="40" placeholder="Batter ${i.batsmen.length + 1}"></label>` : ''}
      ${i.currentBowlerIdx == null ? `<label class="f-field"><span>Bowler</span><input id="p-bw" maxlength="40" list="p-bwl" placeholder="Bowler name"><datalist id="p-bwl">${i.bowlers.filter((b) => b.name !== lastBowler).map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist></label>
        ${i.bowlers.length ? `<div class="f-seg" id="p-quick">${i.bowlers.filter((b) => b.name !== lastBowler).map((b) => `<button type="button" data-v="${esc(b.name)}">${esc(b.name)} <small>${b.wickets}-${b.runs}</small></button>`).join('')}</div>` : ''}` : ''}
      <button class="s-btn s-btn--primary s-btn--block s-btn--lg" id="p-go" style="margin-top:12px">Continue</button>`, (root) => {
      const q = $('#p-quick', root);
      if (q) q.onclick = (e) => { const b = e.target.closest('button'); if (b) $('#p-bw', root).value = b.dataset.v; };
      $('#p-go', root).onclick = () => {
        snapshot(m);
        if (needBat && first) {
          i.batsmen.push(bat($('#p-s', root).value.trim() || 'Batter 1'), bat($('#p-ns', root).value.trim() || 'Batter 2'));
          i.currentBatsmenIdx = [0, 1];
          i.strikerIdx = 0;
        } else if (needBat) {
          i.batsmen.push(bat($('#p-nb', root).value.trim() || `Batter ${i.batsmen.length + 1}`));
          i.currentBatsmenIdx[i.currentBatsmenIdx[0] == null ? 0 : 1] = i.batsmen.length - 1;
        }
        if (i.currentBowlerIdx == null) {
          const name = ($('#p-bw', root).value || '').trim() || `Bowler ${i.bowlers.length + 1}`;
          if (name === lastBowler) return SLC.toast(`${name} bowled the last over`, 'error');
          let k = i.bowlers.findIndex((b) => b.name.toLowerCase() === name.toLowerCase());
          if (k < 0) { i.bowlers.push({ name, balls: 0, runs: 0, wickets: 0, maidens: 0 }); k = i.bowlers.length - 1; }
          i.currentBowlerIdx = k;
          i.lastBowler = name;
        }
        close();
        commit(m);
      };
    });
  }

  function screenPlay(m, needNames) {
    const i = inn(m);
    const t = target(m);
    const left = maxBalls(m) - i.balls;
    const crr = i.balls ? (i.runs / (i.balls / m.ballsPerOver)).toFixed(2) : '0.00';
    const bt = (k) => { const x = i.batsmen[i.currentBatsmenIdx[k]]; return x ? `<button class="ws-bat ${i.strikerIdx === k ? 'is-on' : ''}" data-strike="${k}"><span>${i.strikerIdx === k ? '▸ ' : ''}${esc(x.name)}</span><b>${x.runs}<small>(${x.balls})</small></b></button>` : '<div class="ws-bat"><span class="s-muted">—</span></div>'; };
    const bw = bowlerOf(i);
    app.innerHTML = `
      <section class="ws-board">
        <div class="m-head"><span>${esc(m.team1)} v ${esc(m.team2)}${m.online ? ' · live on site' : ''}</span><span class="m-tag m-tag--live">LIVE</span></div>
        <div class="ws-score"><span>${esc(i.battingTeam)}</span><b>${i.runs}/${i.wickets}</b><small>${SLC.overs(i.balls, m.ballsPerOver)} / ${m.overs} ov · CRR ${crr}</small></div>
        ${t ? `<div class="ws-chase">Need <b>${Math.max(0, t - i.runs)}</b> from <b>${left}</b> balls</div>` : ''}
        <div class="ws-bats">${bt(0)}${bt(1)}</div>
        <div class="ws-bowl">${bw ? `${esc(bw.name)} <b>${bw.wickets}-${bw.runs}</b> <small>(${SLC.overs(bw.balls, m.ballsPerOver)})</small>` : '<span class="s-muted">Bowler needed</span>'}</div>
        <div class="sc-balls" style="margin-top:8px">${SLC.ballsHtml(i.currentOver)}</div>
      </section>
      <div class="ws-pad ${needNames ? 'is-locked' : ''}">
        ${[0, 1, 2, 3, 4, 6].map((r) => `<button class="ws-key ${r === 4 ? 'k4' : r === 6 ? 'k6' : ''}" data-r="${r}"><b>${r}</b><small>${['Dot', 'Single', 'Double', 'Three', 'Four', '', 'Six'][r]}</small></button>`).join('')}
        <button class="ws-key kx" data-x="wide"><b>WD</b><small>Wide</small></button>
        <button class="ws-key kx" data-x="noball"><b>NB</b><small>No ball</small></button>
        <button class="ws-key kx" data-x="bye"><b>B</b><small>Bye</small></button>
        <button class="ws-key kx" data-x="legbye"><b>LB</b><small>Leg bye</small></button>
        <button class="ws-key kw" data-x="wicket"><b>W</b><small>Wicket</small></button>
        <button class="ws-key" data-u><b>↶</b><small>Undo</small></button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="s-btn" data-swap>⇄ Swap strike</button>
        <button class="s-btn" data-card>Scorecard</button>
        <button class="s-btn" data-end>⏹ End innings</button>
        ${m.online && db.keys[m.id] ? `<a class="s-btn" href="match.html?id=${encodeURIComponent(m.id)}" target="_blank">Site view</a>` : ''}
      </div>
      <div id="ws-card"></div>`;
    $$('[data-strike]').forEach((b) => b.onclick = () => { snapshot(m); i.strikerIdx = +b.dataset.strike; commit(m); });
    $('[data-swap]').onclick = () => { snapshot(m); rotate(i); commit(m); };
    $('[data-u]').onclick = undo;
    $('[data-card]').onclick = () => { $('#ws-card').innerHTML = SLC.scorecardHtml(m); };
    $('[data-end]').onclick = () => { if (confirm('End this innings now?')) { snapshot(m); i.isDone = true; if (m.currentInnings === 1) finish(m); commit(m); } };
    $$('[data-r]').forEach((b) => b.onclick = () => record(m, { type: 'run', runs: +b.dataset.r }));
    $$('[data-x]').forEach((b) => b.onclick = () => extra(m, b.dataset.x));
    if (needNames) setTimeout(() => namesPrompt(m), 50);
  }

  function extra(m, kind) {
    const i = inn(m);
    if (kind === 'wide') return sheet('Wide', `<p class="s-muted">1 wide + extra runs</p>${seg('r', [0, 1, 2, 3, 4], 0, (v) => (v ? `Wd + ${v}` : 'Wd'))}<button class="s-btn s-btn--primary s-btn--block" id="x-go" style="margin-top:12px">Save</button>`,
      (r) => { wireSeg(r); $('#x-go', r).onclick = () => { close(); record(m, { type: 'wide', runs: +segVal(r, 'r') }); }; });
    if (kind === 'noball') return sheet('No ball', `<p class="s-muted">1 no-ball + runs off the bat</p>${seg('r', [0, 1, 2, 3, 4, 6], 0, (v) => (v ? `Nb + ${v}` : 'Nb'))}<button class="s-btn s-btn--primary s-btn--block" id="x-go" style="margin-top:12px">Save</button>`,
      (r) => { wireSeg(r); $('#x-go', r).onclick = () => { close(); record(m, { type: 'noball', runs: +segVal(r, 'r') }); }; });
    if (kind === 'bye' || kind === 'legbye') return sheet(kind === 'bye' ? 'Bye' : 'Leg bye', `${seg('r', [1, 2, 3, 4], 1)}<button class="s-btn s-btn--primary s-btn--block" id="x-go" style="margin-top:12px">Save</button>`,
      (r) => { wireSeg(r); $('#x-go', r).onclick = () => { close(); record(m, { type: kind, runs: +segVal(r, 'r') }); }; });
    // wicket
    const b0 = i.batsmen[i.currentBatsmenIdx[0]], b1 = i.batsmen[i.currentBatsmenIdx[1]];
    const last = i.wickets + 1 >= m.playersPerSide - 1;
    sheet('Wicket', `
      <div class="f-field"><span>Who is out?</span><div class="f-seg" data-seg="slot"><button type="button" data-v="0" class="${i.strikerIdx === 0 ? 'is-on' : ''}">${esc(b0 && b0.name)}</button><button type="button" data-v="1" class="${i.strikerIdx === 1 ? 'is-on' : ''}">${esc(b1 && b1.name)}</button></div></div>
      <div class="f-field"><span>How?</span>${seg('how', WICKETS, 'Bowled')}</div>
      <label class="f-field"><span>Fielder (caught / run out / stumped)</span><input id="w-f" maxlength="40"></label>
      <div class="f-field"><span>Runs completed</span>${seg('r', [0, 1, 2, 3], 0)}</div>
      ${last ? '<p class="s-muted">Last wicket — innings ends.</p>' : `<label class="f-field"><span>New batter</span><input id="w-nb" maxlength="40" placeholder="Batter ${i.batsmen.length + 1}"></label>`}
      <button class="s-btn s-btn--red s-btn--block s-btn--lg" id="w-go">Confirm wicket</button>`, (r) => {
      wireSeg(r);
      $('#w-go', r).onclick = () => {
        close();
        record(m, { type: 'wicket', slot: +segVal(r, 'slot'), how: segVal(r, 'how'), fielder: $('#w-f', r).value.trim(), runs: +segVal(r, 'r'),
          next: last ? '' : ($('#w-nb', r).value.trim() || `Batter ${i.batsmen.length + 1}`) });
      };
    });
  }

  function screenBreak(m) {
    const a = inn(m);
    app.innerHTML = `
      <section class="ws-board" style="text-align:center">
        <div class="s-muted">Innings break</div>
        <div class="ws-score" style="justify-content:center"><span>${esc(a.battingTeam)}</span><b>${a.runs}/${a.wickets}</b><small>(${SLC.overs(a.balls, m.ballsPerOver)} ov)</small></div>
        <div class="ws-chase">${esc(a.bowlingTeam)} need <b>${a.runs + 1}</b> to win from ${m.overs} overs</div>
      </section>
      <button class="s-btn s-btn--primary s-btn--lg s-btn--block" id="b-go" style="margin-top:14px">▶ Start 2nd innings</button>
      <button class="s-btn s-btn--block" data-u style="margin-top:8px">↶ Undo last ball</button>
      ${SLC.scorecardHtml(m)}`;
    $('#b-go').onclick = () => { snapshot(m); m.innings[1] = newInnings(a.bowlingTeam, a.battingTeam); m.currentInnings = 1; commit(m); };
    $('[data-u]').onclick = undo;
  }

  function screenResult(m) {
    const t = m.tournamentId && db.tourneys[m.tournamentId];
    app.innerHTML = `
      <section class="mp-hero" style="text-align:center">
        <div class="s-muted">${esc(m.tournamentName || 'Single match')}</div>
        <div class="mp-line mp-line--result" style="font-size:24px;margin:8px 0">${esc(m.result)}</div>
        <div class="s-muted">${m.innings.filter(Boolean).map((x) => `${esc(x.battingTeam)} ${x.runs}/${x.wickets} (${SLC.overs(x.balls, m.ballsPerOver)})`).join(' · ')}</div>
      </section>
      <div style="display:grid;gap:8px;margin-top:14px">
        <button class="s-btn s-btn--primary s-btn--lg" id="r-pdf">Download summary PDF</button>
        <button class="s-btn s-btn--green s-btn--lg" id="r-up">${m.uploaded ? 'On slcrickpro.live — update' : 'Upload to site'}</button>
        ${t ? `<a class="s-btn" href="#tourney=${t.id}">Back to ${esc(t.name)}</a>` : ''}
        <button class="s-btn" id="r-new">＋ New match</button>
        <button class="s-btn" data-u>↶ Undo last ball</button>
      </div>
      ${SLC.scorecardHtml(m)}`;
    $('#r-pdf').onclick = () => SLC.downloadSummaryPdf(m);
    $('#r-up').onclick = async () => {
      const ok = await push(m, true);
      if (ok) { SLC.toast('Uploaded — it shows in Ongoing for 24 hours, then in Past stats'); route(); }
    };
    $('#r-new').onclick = () => { db.current = ''; save(); location.hash = t ? `#tourney=${t.id}` : '#new'; };
    $('[data-u]').onclick = () => { undo(); };
  }

  // ── small tournament ──────────────────────────────────────────
  function screenTourneyNew() {
    app.innerHTML = `
      <h1 class="s-h1">Small tournament</h1>
      <div class="f-card">
        <label class="f-field"><span>Tournament name</span><input id="tn-name" maxlength="60"></label>
        <label class="f-field"><span>Teams (one per line, 3–8)</span><textarea id="tn-teams" class="f-input" rows="6" style="padding:12px;min-height:150px"></textarea></label>
        <div class="f-field"><span>Overs</span>${seg('ov', [2, 5, 6, 8, 10], 6)}</div>
        <button class="s-btn s-btn--primary s-btn--lg s-btn--block" id="tn-go">Create fixtures →</button>
      </div>`;
    wireSeg(app);
    $('#tn-go').onclick = () => {
      const name = $('#tn-name').value.trim();
      const teams = [...new Set($('#tn-teams').value.split('\n').map((x) => x.trim()).filter(Boolean))];
      if (!name) return SLC.toast('Tournament name?', 'error');
      if (teams.length < 3 || teams.length > 8) return SLC.toast('Enter 3 to 8 teams', 'error');
      const fixtures = [];
      const list = teams.length % 2 ? [...teams, null] : teams.slice();
      for (let r = 0; r < list.length - 1; r++) {
        for (let k = 0; k < list.length / 2; k++) {
          const a = list[k], b = list[list.length - 1 - k];
          if (a && b) fixtures.push({ id: uid('FX'), team1: a, team2: b, matchId: '' });
        }
        list.splice(1, 0, list.pop());
      }
      const t = { id: uid('WT'), name, teams, overs: parseInt(segVal(app, 'ov'), 10) || 6, fixtures };
      db.tourneys[t.id] = t;
      save();
      location.hash = `#tourney=${t.id}`;
    };
  }

  function screenTourney(id) {
    const t = db.tourneys[id];
    if (!t) { location.hash = ''; return; }
    const rows = new Map(t.teams.map((n) => [n, { team: n, p: 0, w: 0, l: 0, nr: 0, pts: 0 }]));
    t.fixtures.forEach((f) => {
      const m = db.matches[f.matchId];
      if (!m || m.status !== 'completed') return;
      const a = rows.get(m.team1), b = rows.get(m.team2);
      if (!a || !b) return;
      a.p++; b.p++;
      if (!m.winner) { a.nr++; b.nr++; a.pts++; b.pts++; } else { const W = m.winner === m.team1 ? a : b; const L = W === a ? b : a; W.w++; W.pts += 2; L.l++; }
    });
    const table = [...rows.values()].sort((x, y) => y.pts - x.pts || y.w - x.w);
    app.innerHTML = `
      <a href="#" class="s-muted" id="t-back">← All</a>
      <h1 class="s-h1">${esc(t.name)}</h1>
      <div class="t-table-wrap"><table class="t-table"><thead><tr><th>#</th><th style="text-align:left">Team</th><th>P</th><th>W</th><th>L</th><th>NR</th><th>Pts</th></tr></thead><tbody>
        ${table.map((r, k) => `<tr><td>${k + 1}</td><td class="tl">${esc(r.team)}</td><td>${r.p}</td><td>${r.w}</td><td>${r.l}</td><td>${r.nr}</td><td><b>${r.pts}</b></td></tr>`).join('')}
      </tbody></table></div>
      <h2 class="s-h2">Fixtures</h2>
      <div class="m-grid">${t.fixtures.map((f, k) => {
        const m = db.matches[f.matchId];
        return `<div class="m-card"><div class="m-head"><span>M${k + 1}</span>${m ? SLC.statusTag(m.status) : '<span class="m-tag">UPCOMING</span>'}</div>
          <div class="m-row"><b>${esc(f.team1)} v ${esc(f.team2)}</b></div>${m && m.result ? `<div class="m-result">${esc(m.result)}</div>` : ''}
          <button class="s-btn ${m ? '' : 's-btn--primary'}" data-fx="${f.id}">${m ? (m.status === 'completed' ? 'Scorecard' : 'Resume') : '▶ Play'}</button></div>`;
      }).join('')}</div>`;
    $('#t-back').onclick = (e) => { e.preventDefault(); db.current = ''; save(); location.hash = ''; route(); };
    $$('[data-fx]').forEach((b) => b.onclick = () => {
      const f = t.fixtures.find((x) => x.id === b.dataset.fx);
      if (f.matchId && db.matches[f.matchId]) { db.current = f.matchId; save(); history.replaceState(null, '', location.pathname); route(); return; }
      history.replaceState(null, '', location.pathname);
      screenSetup({ team1: f.team1, team2: f.team2, overs: t.overs, tournamentId: t.id, tournamentName: t.name, fixture: f });
      const origGo = $('#s-go').onclick;
      $('#s-go').onclick = () => { origGo(); save(); };
    });
  }

  route();
})();
