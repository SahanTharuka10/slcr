/* SLCRICKPRO website – shared helpers (API, header, cards, scorecard, PDF) */
(function (global) {
  'use strict';

  const CFG = global.SLC_CONFIG || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  // ── API ──────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.key) headers['x-write-key'] = opts.key;
    const res = await fetch(`${CFG.apiBase || ''}/api${path}`, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = { ok: false, error: `Server error (${res.status})` };
    }
    if (!res.ok || data.ok === false) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── header / footer ─────────────────────────────────────────
  function header(active) {
    const nav = [
      ['live', 'live.html', '🔴 Ongoing'],
      ['score', 'score.html', '🏏 Score match'],
      ['past', 'past.html', '📊 Past stats'],
      ['app', 'index.html#app', '💻 Desktop app'],
    ];
    const el = document.createElement('header');
    el.className = 's-top';
    el.innerHTML = `<div class="s-top-in">
      <a class="s-logo" href="index.html"><img src="assets/icon.png" alt="">SLCRICK<span>PRO</span></a>
      <nav class="s-nav">${nav.map(([k, href, l]) => `<a href="${href}" class="${k === active ? 'is-on' : ''}">${l}</a>`).join('')}</nav>
      <button class="s-theme" type="button" id="s-theme" aria-label="Switch light / dark"></button>
    </div>`;
    document.body.prepend(el);
    const btn = el.querySelector('#s-theme');
    const isLight = () => {
      const t = document.documentElement.dataset.theme;
      return t ? t === 'light' : window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches;
    };
    const paint = () => {
      btn.textContent = isLight() ? '🌙' : '☀️';
      btn.title = isLight() ? 'Dark mode' : 'Light mode';
    };
    btn.onclick = () => {
      const next = isLight() ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('slc_theme', next); } catch (_) {}
      paint();
    };
    paint();
    const foot = document.createElement('footer');
    foot.className = 's-foot';
    foot.innerHTML = `SLCRICKPRO · Live cricket scoring · <a href="index.html#app">Get the desktop app</a>`;
    document.body.appendChild(foot);
    // Old site registered a caching service worker — replace it with the self-cleaning one
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.update().catch(() => {}))).catch(() => {});
    }
  }

  function toast(msg, kind) {
    let el = document.getElementById('s-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 's-toast';
      el.className = 's-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = `s-toast is-on ${kind || ''}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = 's-toast'), kind === 'error' ? 3500 : 2200);
  }

  // ── formatting ───────────────────────────────────────────────
  const overs = (balls, bpo) => `${Math.floor((balls || 0) / (bpo || 6))}.${(balls || 0) % (bpo || 6)}`;

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function statusTag(st) {
    if (st === 'live') return '<span class="m-tag m-tag--live">LIVE</span>';
    if (st === 'paused') return '<span class="m-tag m-tag--paused">PAUSED</span>';
    if (st === 'completed') return '<span class="m-tag m-tag--done">RESULT</span>';
    return '<span class="m-tag">UPCOMING</span>';
  }

  /** Card for list rows from /api/matches. */
  function matchCard(s) {
    const inn = s.innings || [];
    const score = (team) => {
      const i = inn.find((x) => x.team === team);
      return i ? `${i.runs}/${i.wickets}<small>(${esc(i.overs)})</small>` : '';
    };
    const battingNow = s.status === 'live' && inn[s.currentInnings || 0] ? inn[s.currentInnings || 0].team : '';
    const leftH = s.view === 'ongoing' && s.status === 'completed' && s.completedAt
      ? Math.max(1, Math.round((24 * 3600 * 1000 - (Date.now() - s.completedAt)) / 3600000))
      : 0;
    return `<a class="m-card ${s.status === 'live' ? 'm-card--live' : ''}" href="match.html?id=${encodeURIComponent(s.id)}">
      <div class="m-head"><span>${esc(s.tournamentName || 'Single match')}${s.stage ? ` · ${esc(s.stage)}` : ''}</span>${statusTag(s.status)}</div>
      <div class="m-row ${battingNow === s.team1 ? 'is-bat' : ''}"><b>${esc(s.team1)}</b><strong>${score(s.team1)}</strong></div>
      <div class="m-row ${battingNow === s.team2 ? 'is-bat' : ''}"><b>${esc(s.team2)}</b><strong>${score(s.team2)}</strong></div>
      ${s.result ? `<div class="m-result">${esc(s.result)}</div>` : s.toss ? `<div class="m-note">${esc(s.toss)}</div>` : ''}
      <div class="m-note">${s.status === 'completed' ? `Finished ${ago(s.completedAt)}${leftH ? ` · moves to Past stats in ${leftH}h` : ''}` : `Updated ${ago(s.updatedAt)}`}</div>
    </a>`;
  }

  // ── scorecard (desktop + web scorer use the same match format) ─
  function ballLabel(b) {
    if (!b) return '';
    const r = b.runs || 0;
    if (b.wicket) return ['W', 'w'];
    if (b.type === 'wide') return [r > 1 ? `${r - 1}Wd` : 'Wd', 'x'];
    if (b.type === 'noball') return [r ? `Nb${r}` : 'Nb', 'x'];
    if (b.type === 'bye') return [`${r}B`, 'x'];
    if (b.type === 'legbye') return [`${r}Lb`, 'x'];
    if (r === 4 || b.type === 'four') return ['4', '4'];
    if (r === 6 || b.type === 'six') return ['6', '6'];
    return [r === 0 ? '•' : String(r), ''];
  }

  function ballsHtml(list) {
    return (list || []).map((b) => {
      const [t, k] = ballLabel(b);
      return `<span class="ball ${k ? `ball--${k}` : ''}">${esc(t)}</span>`;
    }).join('');
  }

  function inningsHtml(m, inn, idx) {
    if (!inn) return '';
    const bpo = m.ballsPerOver || 6;
    const ex = inn.extras || {};
    const exTotal = (ex.wides || 0) + (ex.noBalls || 0) + (ex.byes || 0) + (ex.legByes || 0);
    const onIdx = new Set(m.status !== 'completed' && idx === (m.currentInnings || 0) ? (inn.currentBatsmenIdx || []) : []);
    const sr = (r, b) => (b ? ((r / b) * 100).toFixed(1) : '0.0');
    const econ = (r, b) => (b ? (r / (b / bpo)).toFixed(2) : '0.00');
    const bats = (inn.batsmen || []).map((b, i) => `
      <tr class="${onIdx.has(i) && !b.dismissal ? 'is-on' : ''}">
        <td class="tl"><b>${esc(b.name)}</b><small>${esc(b.dismissal || (onIdx.has(i) ? 'batting' : 'not out'))}</small></td>
        <td><b>${b.runs || 0}</b></td><td>${b.balls || 0}</td><td class="hide-sm">${b.fours || 0}</td><td class="hide-sm">${b.sixes || 0}</td><td>${sr(b.runs || 0, b.balls || 0)}</td>
      </tr>`).join('');
    const bowls = (inn.bowlers || []).filter((b) => (b.balls || 0) > 0 || (b.runs || 0) > 0).map((b) => `
      <tr><td class="tl"><b>${esc(b.name)}</b></td><td>${overs(b.balls, bpo)}</td><td class="hide-sm">${b.maidens || 0}</td><td>${b.runs || 0}</td><td><b>${b.wickets || 0}</b></td><td>${econ(b.runs || 0, b.balls || 0)}</td></tr>`).join('');
    const fow = (inn.fallOfWickets || []).map((f, i) => `${f.runs}-${i + 1} (${esc(f.batsmanName)}, ${overs(f.balls, bpo)})`).join(' · ');
    return `<section class="sc-card">
      <div class="sc-title"><span>${esc(inn.battingTeam)} innings</span><span>${inn.runs || 0}/${inn.wickets || 0} <small class="s-muted">(${overs(inn.balls, bpo)} ov)</small></span></div>
      <table class="sc-table"><thead><tr><th class="tl">Batter</th><th>R</th><th>B</th><th class="hide-sm">4s</th><th class="hide-sm">6s</th><th>SR</th></tr></thead><tbody>${bats || '<tr><td class="tl s-muted" colspan="6">Yet to bat</td></tr>'}</tbody></table>
      <div class="sc-extra">Extras ${exTotal} (wd ${ex.wides || 0}, nb ${ex.noBalls || 0}, b ${ex.byes || 0}, lb ${ex.legByes || 0})${fow ? `<br>Fall of wickets: ${fow}` : ''}</div>
      <table class="sc-table"><thead><tr><th class="tl">Bowler</th><th>O</th><th class="hide-sm">M</th><th>R</th><th>W</th><th>Econ</th></tr></thead><tbody>${bowls || '<tr><td class="tl s-muted" colspan="6">—</td></tr>'}</tbody></table>
    </section>`;
  }

  function scorecardHtml(m) {
    return (m.innings || []).map((inn, i) => inningsHtml(m, inn, i)).join('');
  }

  function teamScore(m, team) {
    const inns = (m.innings || []).filter((i) => i && i.battingTeam === team && (i.balls || i.runs || i.isDone));
    if (!inns.length) return { text: '', sub: 'Yet to bat' };
    return {
      text: inns.map((i) => `${i.runs}/${i.wickets}`).join(' & '),
      sub: inns.map((i) => `${overs(i.balls, m.ballsPerOver)} ov`).join(' & '),
    };
  }

  // ── PDF summary ──────────────────────────────────────────────
  function summaryDoc(m) {
    const bpo = m.ballsPerOver || 6;
    const row = (cells, head) => `<tr>${cells.map((c, i) => `<${head ? 'th' : 'td'} style="padding:5px 6px;border-bottom:1px solid #e3e6ee;text-align:${i ? 'right' : 'left'};font-size:11px">${c}</${head ? 'th' : 'td'}>`).join('')}</tr>`;
    const inn = (i) => {
      if (!i) return '';
      const ex = i.extras || {};
      const exT = (ex.wides || 0) + (ex.noBalls || 0) + (ex.byes || 0) + (ex.legByes || 0);
      return `<h3 style="margin:16px 0 6px;font-size:14px;background:#0f1a3d;color:#fff;padding:8px 10px;border-radius:6px;display:flex;justify-content:space-between"><span>${esc(i.battingTeam)}</span><span>${i.runs}/${i.wickets} (${overs(i.balls, bpo)} ov)</span></h3>
        <table style="width:100%;border-collapse:collapse">${row(['Batter', 'R', 'B', '4s', '6s', 'SR'], true)}${(i.batsmen || []).map((b) => row([`<b>${esc(b.name)}</b><br><span style="color:#667">${esc(b.dismissal || 'not out')}</span>`, `<b>${b.runs || 0}</b>`, b.balls || 0, b.fours || 0, b.sixes || 0, b.balls ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0'])).join('')}</table>
        <p style="font-size:11px;color:#556;margin:6px 0">Extras ${exT} · Total ${i.runs}/${i.wickets}</p>
        <table style="width:100%;border-collapse:collapse">${row(['Bowler', 'O', 'M', 'R', 'W', 'Econ'], true)}${(i.bowlers || []).filter((b) => b.balls || b.runs).map((b) => row([`<b>${esc(b.name)}</b>`, overs(b.balls, bpo), b.maidens || 0, b.runs || 0, `<b>${b.wickets || 0}</b>`, b.balls ? (b.runs / (b.balls / bpo)).toFixed(2) : '0.00'])).join('')}</table>`;
    };
    const all = (m.innings || []).filter(Boolean);
    const topBat = all.flatMap((i) => (i.batsmen || []).map((b) => ({ ...b, team: i.battingTeam }))).sort((a, b) => (b.runs || 0) - (a.runs || 0))[0];
    const topBowl = all.flatMap((i) => (i.bowlers || []).map((b) => ({ ...b, team: i.bowlingTeam }))).sort((a, b) => (b.wickets || 0) - (a.wickets || 0) || (a.runs || 0) - (b.runs || 0))[0];
    const div = document.createElement('div');
    div.style.cssText = 'width:720px;padding:28px;background:#fff;color:#111;font-family:Segoe UI,Arial,sans-serif';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #2557e6;padding-bottom:10px">
        <div><div style="font-size:11px;letter-spacing:.2em;color:#2557e6;font-weight:800">SLCRICKPRO · MATCH SUMMARY</div>
        <div style="font-size:24px;font-weight:900">${esc(m.team1)} vs ${esc(m.team2)}</div>
        <div style="font-size:12px;color:#556">${esc(m.tournamentName || 'Single match')} · ${esc(m.overs)} overs${m.venue ? ` · ${esc(m.venue)}` : ''} · ${new Date(m.createdAt || Date.now()).toLocaleDateString()}</div></div>
      </div>
      <div style="margin:14px 0;padding:12px;border-radius:8px;background:#ecfdf3;color:#14532d;font-weight:800;font-size:15px">${esc(m.result || 'Match in progress')}</div>
      ${m.tossWinner ? `<div style="font-size:12px;color:#556">Toss: ${esc(m.tossWinner)} chose to ${m.tossDecision === 'bowl' ? 'bowl' : 'bat'}</div>` : ''}
      ${topBat || topBowl ? `<div style="display:flex;gap:10px;margin-top:10px">
        ${topBat ? `<div style="flex:1;padding:10px;border-radius:8px;background:#f1f5ff"><div style="font-size:10px;color:#2557e6;font-weight:800">TOP BATTER</div><b>${esc(topBat.name)}</b> ${topBat.runs || 0} (${topBat.balls || 0}) <span style="color:#667">· ${esc(topBat.team)}</span></div>` : ''}
        ${topBowl ? `<div style="flex:1;padding:10px;border-radius:8px;background:#fff4f0"><div style="font-size:10px;color:#e11d48;font-weight:800">TOP BOWLER</div><b>${esc(topBowl.name)}</b> ${topBowl.wickets || 0}/${topBowl.runs || 0} <span style="color:#667">· ${esc(topBowl.team)}</span></div>` : ''}
      </div>` : ''}
      ${all.map(inn).join('')}
      <p style="margin-top:18px;font-size:10px;color:#889;text-align:right">Generated by SLCRICKPRO · slcrickpro.live</p>`;
    return div;
  }

  async function downloadSummaryPdf(m) {
    if (typeof global.html2pdf !== 'function') {
      toast('PDF library not loaded', 'error');
      return;
    }
    const el = summaryDoc(m);
    const name = `${m.team1} vs ${m.team2} - summary.pdf`.replace(/[\\/:*?"<>|]+/g, '');
    await global.html2pdf().set({ margin: 8, filename: name, image: { type: 'jpeg', quality: 0.95 }, html2canvas: { scale: 2, backgroundColor: '#ffffff' }, jsPDF: { unit: 'mm', format: 'a4' } }).from(el).save();
  }

  global.SLC = { api, header, toast, esc, overs, ago, matchCard, statusTag, scorecardHtml, ballsHtml, teamScore, downloadSummaryPdf, cfg: CFG };
})(window);
