/**
 * SLCRICKPRO – Match Report Engine
 * Specialized module for deep data analysis and report assembly.
 */

const MatchReportEngine = {
    /**
     * Extracts an over-by-over summary for a specific innings.
     */
    getOverSummary(innings, bpo = 6) {
        if (!innings || !innings.overHistory) return [];
        
        return innings.overHistory.map((over, idx) => {
            let runs = 0;
            let wkts = 0;
            let extras = 0;
            let bowler = over.length > 0 ? over[0].bowlerName : 'Unknown';
            
            over.forEach(ball => {
                runs += (ball.runs || 0);
                if (ball.wicket) wkts++;
                if (ball.type !== 'run') extras++;
            });
            
            return {
                overNum: idx + 1,
                runs,
                wkts,
                extras,
                bowler
            };
        });
    },

    /**
     * Assembles a high-detail metadata object for a match.
     */
    assembleReportData(match) {
        const report = {
            id: 'REP-' + Date.now() + '-' + Math.floor(Math.random()*1000),
            matchId: match.id,
            generatedAt: Date.now(),
            matchMeta: {
                teams: `${match.team1} vs ${match.team2}`,
                venue: match.venue || 'Home Ground',
                format: match.matchFormat || 'Limited Overs',
                tournament: match.tournamentName || 'Single Match',
                toss: match.tossWinner ? `${match.tossWinner} won & elected to ${match.tossDecision}` : 'N/A'
            },
            innings: (match.innings || []).map((inn, idx) => ({
                team: inn.battingTeam || (idx % 2 === 0 ? (match.battingFirst || match.team1) : (match.fieldingFirst || match.team2)),
                score: `${inn.runs}/${inn.wickets}`,
                overs: `${Math.floor(inn.balls/6)}.${inn.balls%6}`,
                overByOver: this.getOverSummary(inn, match.ballsPerOver),
                partnerships: inn.partnerships || [],
                fallOfWickets: inn.fallOfWickets || []
            }))
        };
        return report;
    },

    _ballChipLabel(ball) {
        if (!ball) return '·';
        if (ball.wicket) return 'W';
        if (ball.type === 'wide') return `Wd${ball.runs > 1 ? ball.runs : ''}`;
        if (ball.type === 'noball') return `Nb${ball.runs > 1 ? ball.runs : ''}`;
        if (ball.type === 'bye') return `B${ball.runs || ''}`;
        if (ball.type === 'legbye') return `Lb${ball.runs || ''}`;
        if (ball.type === 'four') return '4';
        if (ball.type === 'six') return '6';
        return String(ball.runs != null ? ball.runs : '·');
    },

    _renderOverByOverBlock(inn, bpo, esc) {
        if (!inn) return '';
        const rows = [];
        (inn.overHistory || []).forEach((over, idx) => {
            let runs = 0;
            let wkts = 0;
            const chips = (over || [])
                .map((b) => {
                    runs += b.runs || 0;
                    if (b.wicket) wkts++;
                    return esc(this._ballChipLabel(b));
                })
                .join(' ');
            const bowler = over?.[0]?.bowlerName ? esc(over[0].bowlerName) : '—';
            rows.push(
                `<tr style="border-bottom:1px solid #eee"><td style="padding:8px;font-weight:700">${idx + 1}</td><td style="padding:8px">${bowler}</td><td style="padding:8px;font-family:monospace;font-size:12px">${chips || '—'}</td><td style="padding:8px;text-align:center;font-weight:800">${runs}${wkts ? ` (${wkts}w)` : ''}</td></tr>`
            );
        });
        let currentRow = '';
        if (inn.currentOver && inn.currentOver.length) {
            const chips = inn.currentOver
                .map((b) => esc(this._ballChipLabel(b)))
                .join(' ');
            currentRow = `<tr style="background:#fffde7"><td style="padding:8px;font-weight:900">•</td><td style="padding:8px">Current over</td><td style="padding:8px;font-family:monospace;font-size:12px">${chips}</td><td style="padding:8px;text-align:center">In progress</td></tr>`;
        }
        if (!rows.length && !currentRow) return '';
        return `
            <div style="margin-top:24px;margin-bottom:8px;font-size:11px;font-weight:900;color:#888;text-transform:uppercase;letter-spacing:1px">Over-by-over</div>
            <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px">
                <thead><tr style="background:#f1f3f8;text-align:left"><th style="padding:8px">Ov</th><th style="padding:8px">Bowler</th><th style="padding:8px">Balls</th><th style="padding:8px;text-align:center">Runs</th></tr></thead>
                <tbody>${rows.join('')}${currentRow}</tbody>
            </table>`;
    },

    /**
     * Full match report PDF (live or completed) — header: SLCRICKPRO Scoring.
     */
    async generatePDF(matchId) {
        if (typeof globalThis.ensurePdfLibs === 'function') {
            try {
                await globalThis.ensurePdfLibs();
            } catch (e) {
                if (typeof showToast === 'function') showToast('PDF libraries failed to load', 'error');
                return;
            }
        }
        if (typeof html2pdf === 'undefined') {
            if (typeof showToast === 'function') showToast('PDF library not loaded — refresh the page', 'error');
            else alert('PDF library not loaded');
            return;
        }

        const m = DB.getMatch(matchId);
        if (!m) {
            if (typeof showToast === 'function') showToast('Match not found', 'error');
            else alert('Match not found');
            return;
        }

        const esc = (s) => this._esc(s);
        const bpo = m.ballsPerOver || 6;
        const generatedAt = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
        const statusLabel =
            m.status === 'live'
                ? 'LIVE'
                : m.status === 'paused'
                  ? 'PAUSED'
                  : m.status === 'completed'
                    ? 'COMPLETED'
                    : (m.status || 'SCHEDULED').toUpperCase();

        const overlay = document.createElement('div');
        overlay.id = 'pdf-gen-overlay';
        overlay.style.cssText =
            'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:Arial,Helvetica,sans-serif;';
        overlay.innerHTML = `
            <div style="font-size:48px;margin-bottom:16px">📊</div>
            <div style="font-size:22px;font-weight:800">SLCRICKPRO Scoring</div>
            <div style="font-size:13px;opacity:0.75;margin-top:8px">Building match report for ${esc(m.team1)} vs ${esc(m.team2)}…</div>`;
        document.body.appendChild(overlay);

        const { root: pdfRoot, container } = this._createPdfCaptureRoot();

        const renderInningsTablePDF = (inn, teamName, innLabel) => {
            if (!inn) {
                return `<div style="margin-bottom:36px;padding:28px;border:2px dashed #ddd;text-align:center;color:#999;border-radius:12px;font-weight:600">${esc(innLabel)} — not started yet</div>`;
            }

            const ex = inn.extras || { wides: 0, noBalls: 0, byes: 0, legByes: 0, wd: 0, nb: 0, b: 0, lb: 0 };
            const w = ex.wides || ex.wd || 0;
            const nb = ex.noBalls || ex.nb || 0;
            const b = ex.byes || ex.b || 0;
            const lb = ex.legByes || ex.lb || 0;
            const exTotal = w + nb + b + lb;
            const batRows = (inn.batsmen || []).length
                ? (inn.batsmen || [])
                      .map(
                          (bat) => `
                    <tr style="border-bottom:1px solid #f0f0f0">
                        <td style="padding:12px 8px"><div style="font-weight:800;color:#333">${esc(bat.name)}</div><div style="font-size:10px;color:#888;font-weight:600">${esc(bat.dismissal || 'not out')}</div></td>
                        <td style="padding:12px 8px;text-align:center;font-weight:900;color:#1a237e">${bat.runs || 0}</td>
                        <td style="padding:12px 8px;text-align:center">${bat.balls || 0}</td>
                        <td style="padding:12px 8px;text-align:center">${bat.fours || 0}</td>
                        <td style="padding:12px 8px;text-align:center">${bat.sixes || 0}</td>
                        <td style="padding:12px 8px;text-align:right">${bat.balls > 0 ? ((bat.runs / bat.balls) * 100).toFixed(1) : '0.0'}</td>
                    </tr>`
                      )
                      .join('')
                : `<tr><td colspan="6" style="padding:16px;text-align:center;color:#999">No batting entries yet</td></tr>`;

            const bowlRows = (inn.bowlers || []).length
                ? (inn.bowlers || [])
                      .map(
                          (bowl) => `
                    <tr style="border-bottom:1px solid #f0f0f0">
                        <td style="padding:12px 8px;font-weight:800">${esc(bowl.name)}</td>
                        <td style="padding:12px 8px;text-align:center">${this._formatOvers(bowl.balls, bpo)}</td>
                        <td style="padding:12px 8px;text-align:center">${bowl.maidens || 0}</td>
                        <td style="padding:12px 8px;text-align:center">${bowl.runs || 0}</td>
                        <td style="padding:12px 8px;text-align:center;font-weight:900;color:#c62828">${bowl.wickets || 0}</td>
                        <td style="padding:12px 8px;text-align:right">${bowl.balls > 0 ? ((bowl.runs / bowl.balls) * bpo).toFixed(2) : '0.00'}</td>
                    </tr>`
                      )
                      .join('')
                : `<tr><td colspan="6" style="padding:16px;text-align:center;color:#999">No bowling entries yet</td></tr>`;

            const fowHtml =
                inn.fallOfWickets && inn.fallOfWickets.length
                    ? `<div style="margin-bottom:20px;font-size:12px;color:#555;line-height:1.6"><strong>Fall of wickets:</strong> ${inn.fallOfWickets
                          .map(
                              (f, i) =>
                                  `${esc(f.score || `${inn.runs}/${i + 1}`)} (${esc(f.batsman || '?')}, ${esc(f.overs || '')} ov)`
                          )
                          .join(', ')}</div>`
                    : '';

            const partHtml =
                inn.partnerships && inn.partnerships.length
                    ? `<div style="background:#f8f9fa;border-radius:12px;padding:16px;margin-bottom:16px">
                        <div style="font-size:11px;font-weight:900;color:#888;margin-bottom:10px;text-transform:uppercase">Partnerships</div>
                        ${inn.partnerships
                            .slice(0, 6)
                            .map(
                                (p) =>
                                    `<div style="font-size:12px;margin-bottom:6px"><strong>${p.runs || 0}</strong> (${p.balls || 0} balls) — ${esc(p.batsman1)} & ${esc(p.batsman2)}</div>`
                            )
                            .join('')}
                       </div>`
                    : '';

            return `
                <div style="margin-bottom:28px;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 6px 28px rgba(26,35,126,0.08);border:1px solid rgba(26,35,126,0.06)">
                    <div style="background:linear-gradient(90deg,#1a237e 0%,#3949ab 100%);padding:22px 26px;display:flex;justify-content:space-between;align-items:center;color:#fff">
                        <div>
                            <div style="font-size:10px;font-weight:900;opacity:0.75;letter-spacing:2px;text-transform:uppercase">${esc(innLabel)}</div>
                            <div style="font-size:24px;font-weight:900;margin-top:4px">${esc(teamName)}</div>
                            ${inn.bowlingTeam ? `<div style="font-size:11px;opacity:0.8;margin-top:4px">vs ${esc(inn.bowlingTeam)}</div>` : ''}
                        </div>
                        <div style="text-align:right">
                            <div style="font-size:34px;font-weight:900">${inn.runs || 0}/${inn.wickets || 0}</div>
                            <div style="font-size:13px;opacity:0.85;font-weight:700">(${this._formatOvers(inn.balls, bpo)} ov)</div>
                        </div>
                    </div>
                    <div style="padding:28px">
                        <div style="font-size:11px;font-weight:900;color:#1a237e;margin-bottom:10px;border-left:4px solid #ffc107;padding-left:10px">BATTING</div>
                        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
                            <thead><tr style="font-size:10px;color:#999;text-transform:uppercase;border-bottom:1px solid #eee"><th style="padding:8px;text-align:left">Batsman</th><th style="padding:8px;text-align:center">R</th><th style="padding:8px;text-align:center">B</th><th style="padding:8px;text-align:center">4s</th><th style="padding:8px;text-align:center">6s</th><th style="padding:8px;text-align:right">SR</th></tr></thead>
                            <tbody>${batRows}</tbody>
                        </table>
                        <div style="background:#fafafa;padding:12px 16px;border-radius:10px;margin-bottom:22px;font-size:12px;font-weight:700;color:#555">
                            Extras ${exTotal} (Wd ${w}, Nb ${nb}, B ${b}, Lb ${lb}) · Total <span style="color:#1a237e">${inn.runs}/${inn.wickets}</span> (${this._formatOvers(inn.balls, bpo)} ov)
                        </div>
                        <div style="font-size:11px;font-weight:900;color:#1a237e;margin-bottom:10px;border-left:4px solid #ffc107;padding-left:10px">BOWLING</div>
                        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
                            <thead><tr style="font-size:10px;color:#999;text-transform:uppercase;border-bottom:1px solid #eee"><th style="padding:8px;text-align:left">Bowler</th><th style="padding:8px;text-align:center">O</th><th style="padding:8px;text-align:center">M</th><th style="padding:8px;text-align:center">R</th><th style="padding:8px;text-align:center">W</th><th style="padding:8px;text-align:right">Econ</th></tr></thead>
                            <tbody>${bowlRows}</tbody>
                        </table>
                        ${fowHtml}
                        ${partHtml}
                        ${this._renderOverByOverBlock(inn, bpo, esc)}
                    </div>
                </div>`;
        };

        const totalInns = m.totalInnings || (m.matchFormat === 'test' ? 4 : 2);
        let inningsHtml = '';
        let inningsPageCount = 0;
        for (let i = 0; i < totalInns; i++) {
            const inn = m.innings?.[i];
            if (!inn && i > (m.currentInnings ?? 0)) continue;
            let label =
                i === 0 ? '1st Innings' : i === 1 ? '2nd Innings' : i === 2 ? '3rd Innings' : '4th Innings';
            if (m.matchFormat !== 'test') label = i === 0 ? '1st Innings' : '2nd Innings (chase)';
            const tName = inn
                ? inn.battingTeam
                : i % 2 === 0
                  ? m.battingFirst || m.team1
                  : m.fieldingFirst || m.team2;
            if (inningsPageCount > 0) inningsHtml += '<div class="html2pdf__page-break"></div>';
            inningsHtml += renderInningsTablePDF(inn, tName, label);
            inningsPageCount++;
        }

        const inn0 = m.innings?.[0];
        const inn1 = m.innings?.[1];
        const scoreSummary = `${esc(m.team1)} ${inn0 ? `${inn0.runs}/${inn0.wickets} (${this._formatOvers(inn0.balls, bpo)})` : '—'}  ·  ${esc(m.team2)} ${inn1 ? `${inn1.runs}/${inn1.wickets} (${this._formatOvers(inn1.balls, bpo)})` : m.currentInnings >= 1 ? '(yet to bat)' : '—'}`;

        const tossLine = m.tossWinner
            ? `${esc(m.tossWinner)} won toss & chose to ${esc((m.tossDecision || 'bat').toLowerCase())}`
            : 'Toss not recorded';

        const metaRows = [
            ['Match ID', esc(m.id)],
            ['Status', esc(statusLabel)],
            ['Teams', `${esc(m.team1)} vs ${esc(m.team2)}`],
            ['Tournament', esc(m.tournamentName || (m.tournamentId ? 'Tournament fixture' : 'Single match'))],
            ['Format', esc((m.matchFormat || 'limited').toUpperCase())],
            ['Overs', `${m.overs || '—'} (${bpo} balls/over)`],
            ['Venue', esc(m.venue || '—')],
            ['Scorer', esc(m.scorerName || '—')],
            ['Toss', tossLine],
            ['Result', esc(m.result || (m.status === 'live' ? 'Match in progress' : '—'))],
            ['Report generated', esc(generatedAt)],
        ]
            .map(
                ([k, v]) =>
                    `<tr><td style="padding:10px 14px;font-weight:700;color:#666;width:32%">${esc(k)}</td><td style="padding:10px 14px;font-weight:800;color:#1a237e">${v}</td></tr>`
            )
            .join('');

        const score1 = inn0 ? `${inn0.runs}/${inn0.wickets}` : '—';
        const overs1 = inn0 ? this._formatOvers(inn0.balls, bpo) : '';
        const score2 = inn1 ? `${inn1.runs}/${inn1.wickets}` : m.currentInnings >= 1 ? '—' : 'Yet to bat';
        const overs2 = inn1 ? this._formatOvers(inn1.balls, bpo) : '';
        const statusBg = m.status === 'live' ? '#ffebee' : m.status === 'completed' ? '#e8f5e9' : '#fff8e1';
        const statusBorder = m.status === 'live' ? '#ef5350' : m.status === 'completed' ? '#43a047' : '#ffb300';
        const statusColor = m.status === 'live' ? '#c62828' : m.status === 'completed' ? '#2e7d32' : '#f57f17';

        container.innerHTML = `
            <div style="background:linear-gradient(135deg,#0a0e27 0%,#1a237e 52%,#283593 100%);color:#fff;padding:40px 32px 56px;position:relative;overflow:hidden;box-sizing:border-box">
                <div style="position:absolute;right:-30px;top:-30px;width:160px;height:160px;border-radius:50%;background:rgba(255,193,7,0.12)"></div>
                <div style="position:absolute;left:0;bottom:0;width:100%;height:5px;background:linear-gradient(90deg,#ffc107 0%,#ff9800 45%,transparent 100%)"></div>
                <div style="font-size:11px;letter-spacing:5px;font-weight:800;opacity:0.8;text-transform:uppercase;margin-bottom:10px">SLCRICKPRO · Official Scoring</div>
                <div style="font-size:36px;font-weight:900;letter-spacing:-0.5px;line-height:1.15">Match Report</div>
                <div style="font-size:12px;opacity:0.85;margin-top:12px">${esc(m.tournamentName || 'Cricket fixture')} · ${esc(generatedAt)}</div>
            </div>

            <div style="padding:0 28px 32px;margin-top:-36px;box-sizing:border-box">
                <div style="display:flex;align-items:stretch;gap:12px;margin-bottom:24px">
                    <div style="flex:1;background:#fff;border-radius:16px;padding:20px 16px;text-align:center;box-shadow:0 10px 36px rgba(26,35,126,0.1);border:1px solid rgba(26,35,126,0.06)">
                        <div style="font-size:10px;font-weight:800;color:#888;letter-spacing:1px;text-transform:uppercase">Home</div>
                        <div style="font-size:18px;font-weight:900;color:#1a237e;margin-top:6px;line-height:1.2">${esc(m.team1)}</div>
                        <div style="font-size:30px;font-weight:900;color:#1a237e;margin-top:10px">${score1}</div>
                        ${overs1 ? `<div style="font-size:12px;color:#666;font-weight:700;margin-top:4px">${overs1} overs</div>` : ''}
                    </div>
                    <div style="display:flex;align-items:center;justify-content:center;flex-shrink:0;width:52px">
                        <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#ffc107,#ff9800);color:#1a237e;font-weight:900;font-size:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(255,152,0,0.4)">VS</div>
                    </div>
                    <div style="flex:1;background:#fff;border-radius:16px;padding:20px 16px;text-align:center;box-shadow:0 10px 36px rgba(26,35,126,0.1);border:1px solid rgba(26,35,126,0.06)">
                        <div style="font-size:10px;font-weight:800;color:#888;letter-spacing:1px;text-transform:uppercase">Away</div>
                        <div style="font-size:18px;font-weight:900;color:#1a237e;margin-top:6px;line-height:1.2">${esc(m.team2)}</div>
                        <div style="font-size:30px;font-weight:900;color:#1a237e;margin-top:10px">${score2}</div>
                        ${overs2 ? `<div style="font-size:12px;color:#666;font-weight:700;margin-top:4px">${overs2} overs</div>` : ''}
                    </div>
                </div>

                <div style="background:${statusBg};border:2px solid ${statusBorder};padding:18px 22px;border-radius:14px;text-align:center;margin-bottom:28px;box-shadow:0 4px 20px rgba(0,0,0,0.04)">
                    <div style="font-size:11px;font-weight:900;letter-spacing:2px;color:${statusColor};margin-bottom:6px">${esc(statusLabel)}</div>
                    <div style="font-size:15px;font-weight:800;color:#333;line-height:1.5">${scoreSummary}</div>
                    <div style="font-size:14px;font-weight:700;color:#555;margin-top:8px">${esc(m.result || (m.status === 'live' ? 'Live — scores update as you score' : ''))}</div>
                </div>

                <div style="background:#fff;border-radius:16px;padding:22px 24px;margin-bottom:28px;box-shadow:0 6px 24px rgba(26,35,126,0.06);border:1px solid rgba(26,35,126,0.05)">
                    <div style="font-size:13px;font-weight:900;color:#1a237e;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;padding-bottom:8px;border-bottom:3px solid #ffc107;display:inline-block">Match details</div>
                    <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <tbody>${metaRows}</tbody>
                    </table>
                </div>

                <div style="font-size:13px;font-weight:900;color:#1a237e;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;padding-left:4px">📋 Full scorecards</div>
                ${inningsHtml || '<p style="color:#888;text-align:center;padding:24px">No innings data recorded yet.</p>'}

                <div style="margin-top:36px;padding:20px;background:linear-gradient(90deg,#1a237e,#283593);border-radius:12px;text-align:center;color:#fff">
                    <div style="font-size:11px;font-weight:800;letter-spacing:3px;opacity:0.85">SLCRICKPRO SCORING</div>
                    <div style="font-size:10px;opacity:0.65;margin-top:6px;font-family:monospace">${esc(m.id)}</div>
                </div>
            </div>`;

        await new Promise((r) => setTimeout(r, 1200));

        const opt = this._pdfCaptureOptions(
            container,
            `SLCRICKPRO_Scoring_${(m.team1 || 'T1').replace(/[^\w\-]+/g, '_')}_vs_${(m.team2 || 'T2').replace(/[^\w\-]+/g, '_')}.pdf`
        );

        try {
            const saved = await this._exportPdf(container, opt);
            if (saved?.canceled) {
                if (typeof showToast === 'function') showToast('PDF save canceled', 'default');
            } else if (typeof showToast === 'function') {
                showToast(
                    saved?.path ? `Match PDF saved — ${saved.path}` : 'Match PDF downloaded',
                    'success'
                );
            }
        } catch (err) {
            console.error('Match PDF error:', err);
            if (typeof showToast === 'function') showToast('PDF export failed', 'error');
            else alert('PDF export failed');
        } finally {
            pdfRoot.remove();
            overlay.remove();
        }
    },

    _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    _formatOvers(balls, bpo = 6) {
        const b = Number(balls) || 0;
        const bp = Number(bpo) || 6;
        return `${Math.floor(b / bp)}.${b % bp}`;
    },

    _formatSr(runs, balls) {
        const r = Number(runs) || 0;
        const b = Number(balls) || 0;
        return b > 0 ? ((r / b) * 100).toFixed(1) : '0.0';
    },

    _formatEcon(runs, balls, bpo = 6) {
        const r = Number(runs) || 0;
        const b = Number(balls) || 0;
        return b > 0 ? ((r / b) * bpo).toFixed(2) : '0.00';
    },

    /** A4 content width at 96dpi — avoids html2canvas left-clipping on fixed/z-index hacks. */
    _PDF_PAGE_W: 794,

    _createPdfCaptureRoot() {
        const w = this._PDF_PAGE_W;
        const root = document.createElement('div');
        root.id = 'slcrick-pdf-capture-root';
        root.setAttribute('aria-hidden', 'true');
        root.style.cssText = [
            'position:fixed',
            'left:0',
            'top:0',
            `width:${w}px`,
            'margin:0',
            'padding:0',
            'z-index:2147483646',
            'opacity:0.01',
            'pointer-events:none',
            'overflow:visible',
            'background:#e8edf5',
        ].join(';');

        const container = document.createElement('div');
        container.className = 'slcrick-pdf-document';
        container.style.cssText = [
            `width:${w}px`,
            'max-width:100%',
            'margin:0',
            'padding:0',
            'box-sizing:border-box',
            'background:linear-gradient(180deg,#e8edf5 0%,#f0f4fa 35%,#f8fafc 100%)',
            'font-family:Arial,Helvetica,sans-serif',
            'color:#1a1a2e',
            'overflow:visible',
        ].join(';');

        root.appendChild(container);
        document.body.appendChild(root);
        return { root, container, pageW: w };
    },

    _pdfCaptureOptions(container, filename) {
        const pageW = this._PDF_PAGE_W;
        const docHeight = Math.max(container.scrollHeight, container.offsetHeight, 1120);
        return {
            margin: [10, 10, 10, 10],
            filename,
            image: { type: 'jpeg', quality: 0.96 },
            html2canvas: {
                scale: 2,
                useCORS: true,
                logging: false,
                x: 0,
                y: 0,
                scrollX: 0,
                scrollY: 0,
                width: pageW,
                windowWidth: pageW,
                height: docHeight,
                windowHeight: docHeight,
                backgroundColor: '#e8edf5',
            },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['css', 'legacy'] },
        };
    },

    /** Desktop: native save dialog; browser/mobile: html2pdf download. */
    async _exportPdf(container, opt) {
        const worker = html2pdf().set(opt).from(container);
        if (globalThis.SLCRICK_DESKTOP && globalThis.desktopAPI?.savePdf) {
            const blob = await worker.outputPdf('blob');
            const buf = await blob.arrayBuffer();
            const saved = await globalThis.desktopAPI.savePdf({
                filename: opt.filename || 'SLCRICKPRO_Report.pdf',
                data: Array.from(new Uint8Array(buf)),
            });
            if (!saved?.ok && !saved?.canceled) {
                throw new Error(saved?.error || 'Could not save PDF');
            }
            return saved;
        }
        await worker.save();
        return { ok: true };
    },

    /** Build standings + leader stats for PDF (all completed matches, no publishLive filter). */
    _buildTournamentDataset(tournId) {
        const t = DB.getTournament(tournId);
        if (!t) return null;

        const matches = DB.getMatches().filter((m) => m && m.tournamentId === tournId);
        const completed = matches.filter((m) => m.status === 'completed');
        const live = matches.filter((m) => m.status === 'live' || m.status === 'paused');

        const teamSet = new Set([...(t.teams || [])]);
        matches.forEach((m) => {
            if (m.team1) teamSet.add(m.team1);
            if (m.team2) teamSet.add(m.team2);
        });
        const teams = [...teamSet].filter(Boolean);

        const standings = {};
        teams.forEach((team) => {
            standings[team] = {
                name: team,
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
        });

        const bpoDefault = t.ballsPerOver || 6;

        completed.forEach((m) => {
            const team1 = m.team1;
            const team2 = m.team2;
            const s1 = standings[team1];
            const s2 = standings[team2];
            if (!s1 || !s2) return;

            const inn0 = m.innings?.[0];
            const inn1 = m.innings?.[1];
            if (!inn0 || !inn1) return;

            s1.played++;
            s2.played++;

            if (m.winner) {
                if (standings[m.winner]) {
                    standings[m.winner].won++;
                    standings[m.winner].points += 2;
                }
                const loser = m.winner === team1 ? team2 : team1;
                if (standings[loser]) standings[loser].lost++;
            } else if (m.resultType === 'tied' || (inn1.runs === inn0.runs && m.status === 'completed')) {
                s1.tied++;
                s2.tied++;
                s1.points++;
                s2.points++;
            } else if (inn1.runs > inn0.runs) {
                s2.won++;
                s2.points += 2;
                s1.lost++;
            } else if (inn1.runs < inn0.runs) {
                s1.won++;
                s1.points += 2;
                s2.lost++;
            }

            const battingFirst = m.battingFirst || team1;
            const bpo = m.ballsPerOver || bpoDefault;
            const maxBalls = (m.overs || t.overs || 20) * bpo;
            const pps = m.playersPerSide || 11;
            const b0 = inn0.wickets >= pps - 1 ? maxBalls : inn0.balls || 0;
            const b1 = inn1.wickets >= pps - 1 ? maxBalls : inn1.balls || 0;

            if (battingFirst === team1) {
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

        teams.forEach((team) => {
            const s = standings[team];
            const bpo = bpoDefault;
            const rf = s.ballsFaced > 0 ? s.runsScored / s.ballsFaced : 0;
            const ra = s.ballsBowled > 0 ? s.runsConceded / s.ballsBowled : 0;
            s.nrr = rf - ra;
        });

        const sortedStandings = Object.values(standings).sort(
            (a, b) => (b.points || 0) - (a.points || 0) || (b.nrr || 0) - (a.nrr || 0)
        );

        const batStats = {};
        const bowlStats = {};
        const countBat = (m) => {
            (m.innings || []).forEach((inn) => {
                if (!inn) return;
                (inn.batsmen || []).forEach((b) => {
                    if (!b?.name) return;
                    const k = b.name;
                    if (!batStats[k]) {
                        batStats[k] = {
                            name: b.name,
                            team: b.team || inn.battingTeam || '',
                            runs: 0,
                            balls: 0,
                            fours: 0,
                            sixes: 0,
                            hs: 0,
                            innings: 0,
                        };
                    }
                    batStats[k].runs += b.runs || 0;
                    batStats[k].balls += b.balls || 0;
                    batStats[k].fours += b.fours || 0;
                    batStats[k].sixes += b.sixes || 0;
                    batStats[k].hs = Math.max(batStats[k].hs, b.runs || 0);
                    batStats[k].innings++;
                });
            });
        };
        const countBowl = (m) => {
            (m.innings || []).forEach((inn) => {
                if (!inn) return;
                (inn.bowlers || []).forEach((b) => {
                    if (!b?.name) return;
                    if (!bowlStats[b.name]) {
                        bowlStats[b.name] = {
                            name: b.name,
                            team: b.team || inn.bowlingTeam || '',
                            wickets: 0,
                            runs: 0,
                            balls: 0,
                        };
                    }
                    bowlStats[b.name].wickets += b.wickets || 0;
                    bowlStats[b.name].runs += b.runs || 0;
                    bowlStats[b.name].balls += b.balls || 0;
                });
            });
        };
        completed.forEach((m) => {
            countBat(m);
            countBowl(m);
        });

        const batsmen = Object.values(batStats)
            .map((s) => ({
                ...s,
                matches: s.innings || 0,
                sr: this._formatSr(s.runs, s.balls),
            }))
            .sort((a, b) => b.runs - a.runs)
            .slice(0, 15);
        const bowlMatchCount = {};
        completed.forEach((m) => {
            (m.innings || []).forEach((inn) => {
                if (!inn) return;
                (inn.bowlers || []).forEach((b) => {
                    if (!b?.name) return;
                    bowlMatchCount[b.name] = (bowlMatchCount[b.name] || 0) + 1;
                });
            });
        });
        const bowlers = Object.values(bowlStats)
            .map((s) => ({
                ...s,
                matches: bowlMatchCount[s.name] || 0,
                econ: this._formatEcon(s.runs, s.balls, bpoDefault),
                overs: this._formatOvers(s.balls, bpoDefault),
            }))
            .sort((a, b) => b.wickets - a.wickets || parseFloat(a.econ) - parseFloat(b.econ))
            .slice(0, 15);

        const champion = sortedStandings[0]?.name || t.winner || '—';
        const prizes = t.prizes || {};

        return {
            t,
            matches: matches.sort((a, b) => (a.lastUpdated || 0) - (b.lastUpdated || 0)),
            completed,
            live,
            sortedStandings,
            batsmen,
            bowlers,
            champion,
            prizes,
            teams,
        };
    },

    _matchScoreSummary(m) {
        const inn0 = m.innings?.[0];
        const inn1 = m.innings?.[1];
        const bpo = m.ballsPerOver || 6;
        if (!inn0 || !inn1) return this._esc(m.result || 'Score pending');
        const line1 = `${this._esc(inn0.battingTeam || m.team1)} ${inn0.runs}/${inn0.wickets} (${this._formatOvers(inn0.balls, bpo)} ov)`;
        const line2 = `${this._esc(inn1.battingTeam || m.team2)} ${inn1.runs}/${inn1.wickets} (${this._formatOvers(inn1.balls, bpo)} ov)`;
        const res = m.result ? ` — ${this._esc(m.result)}` : '';
        return `${line1} · ${line2}${res}`;
    },

    /**
     * Full tournament summary PDF (standings, leaders, every match result + scores).
     */
    async generateTournamentPDF(tournId) {
        if (typeof globalThis.ensurePdfLibs === 'function') {
            try {
                await globalThis.ensurePdfLibs();
            } catch (e) {
                if (typeof showToast === 'function') showToast('PDF libraries failed to load', 'error');
                else alert('PDF libraries failed to load');
                return;
            }
        }
        if (typeof html2pdf === 'undefined') {
            if (typeof showToast === 'function') showToast('PDF library not loaded — refresh the page', 'error');
            else alert('PDF library not loaded. Please refresh the page.');
            return;
        }

        const data = this._buildTournamentDataset(tournId);
        if (!data) {
            if (typeof showToast === 'function') showToast('Tournament not found', 'error');
            else alert('Tournament not found');
            return;
        }

        const { t, matches, completed, live, sortedStandings, batsmen, bowlers, champion, prizes, teams } =
            data;
        const generatedAt = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
        const esc = (s) => this._esc(s);

        const overlay = document.createElement('div');
        overlay.style.cssText =
            'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:Arial,Helvetica,sans-serif;';
        overlay.innerHTML = `
            <div style="font-size:48px;margin-bottom:16px">📊</div>
            <div style="font-size:22px;font-weight:800">Tournament Report</div>
            <div style="font-size:13px;opacity:0.75;margin-top:8px">Building ${esc(t.name)} PDF…</div>`;
        document.body.appendChild(overlay);

        const { root: pdfRoot, container } = this._createPdfCaptureRoot();

        const metaRows = [
            ['Format', (t.format || 'league').toUpperCase()],
            ['Overs', String(t.overs || '—')],
            ['Teams', String(teams.length)],
            ['Matches completed', String(completed.length)],
            ['Live / paused', String(live.length)],
            ['Champion / leader', esc(champion)],
        ];
        if (t.venue) metaRows.push(['Venue', esc(t.venue)]);
        if (t.startDate) metaRows.push(['Start', esc(t.startDate)]);
        if (t.endDate) metaRows.push(['End', esc(t.endDate)]);
        if (prizes.first) metaRows.push(['1st prize', esc(prizes.first)]);

        const metaHtml = metaRows
            .map(
                ([k, v]) =>
                    `<tr><td style="padding:10px 14px;font-weight:700;color:#666;width:40%">${esc(k)}</td><td style="padding:10px 14px;font-weight:800;color:#1a237e">${v}</td></tr>`
            )
            .join('');

        const standingsRows = sortedStandings.length
            ? sortedStandings
                  .map(
                      (s, i) => `
                <tr style="border-bottom:1px solid #eee;${i < 3 ? 'background:#fffde7' : ''}">
                    <td style="padding:14px;font-weight:900;color:${i < 3 ? '#f9a825' : '#999'}">${i + 1}</td>
                    <td style="padding:14px;font-weight:800">${esc(s.name)}</td>
                    <td style="padding:14px;text-align:center">${s.played || 0}</td>
                    <td style="padding:14px;text-align:center;color:#2e7d32;font-weight:700">${s.won || 0}</td>
                    <td style="padding:14px;text-align:center">${s.lost || 0}</td>
                    <td style="padding:14px;text-align:center">${s.tied || 0}</td>
                    <td style="padding:14px;text-align:center;font-weight:900;color:#1a237e">${s.points || 0}</td>
                    <td style="padding:14px;text-align:right;font-family:monospace;color:${(s.nrr || 0) >= 0 ? '#2e7d32' : '#c62828'}">${(s.nrr || 0).toFixed(3)}</td>
                </tr>`
                  )
                  .join('')
            : `<tr><td colspan="8" style="padding:24px;text-align:center;color:#999">No standings yet — complete matches to populate.</td></tr>`;

        const batRows = batsmen.length
            ? batsmen
                  .map(
                      (b, i) => `
                <tr style="border-bottom:1px solid #eef2f7">
                    <td style="padding:10px;font-weight:700">${i + 1}. ${esc(b.name)}</td>
                    <td style="padding:10px;text-align:center;color:#666">${b.matches || 0}</td>
                    <td style="padding:10px;text-align:center;font-weight:900">${b.runs}</td>
                    <td style="padding:10px;text-align:center">${b.hs}</td>
                    <td style="padding:10px;text-align:right">${b.sr}</td>
                </tr>`
                  )
                  .join('')
            : '<tr><td colspan="5" style="padding:16px;text-align:center;color:#999">No batting stats</td></tr>';

        const bowlRows = bowlers.length
            ? bowlers
                  .map(
                      (b, i) => `
                <tr style="border-bottom:1px solid #f7eeee">
                    <td style="padding:10px;font-weight:700">${i + 1}. ${esc(b.name)}</td>
                    <td style="padding:10px;text-align:center;color:#666">${b.matches || 0}</td>
                    <td style="padding:10px;text-align:center;font-weight:900;color:#c62828">${b.wickets}</td>
                    <td style="padding:10px;text-align:right">${b.econ}</td>
                </tr>`
                  )
                  .join('')
            : '<tr><td colspan="4" style="padding:16px;text-align:center;color:#999">No bowling stats</td></tr>';

        const matchRows = matches.length
            ? matches
                  .map((m) => {
                      const status =
                          m.status === 'completed'
                              ? 'Completed'
                              : m.status === 'live'
                                ? 'Live'
                                : m.status === 'paused'
                                  ? 'Paused'
                                  : 'Scheduled';
                      const statusColor =
                          m.status === 'completed'
                              ? '#1b5e20'
                              : m.status === 'live'
                                ? '#c62828'
                                : '#666';
                      return `
                <tr style="border-bottom:1px solid #f0f0f0;vertical-align:top">
                    <td style="padding:16px;width:42%">
                        <div style="font-weight:800;font-size:15px">${esc(m.team1)} <span style="color:#ccc">vs</span> ${esc(m.team2)}</div>
                        <div style="font-size:11px;color:#999;margin-top:4px;text-transform:uppercase">${esc(m.scheduledName || m.stage || (m.knockout ? 'Knockout' : 'League'))}</div>
                        ${m.venue ? `<div style="font-size:11px;color:#aaa;margin-top:2px">${esc(m.venue)}</div>` : ''}
                    </td>
                    <td style="padding:16px;font-size:12px;color:#444;line-height:1.5">${this._matchScoreSummary(m)}</td>
                    <td style="padding:16px;text-align:right;font-weight:800;color:${statusColor};white-space:nowrap">${status}</td>
                </tr>`;
                  })
                  .join('')
            : '<tr><td colspan="3" style="padding:20px;text-align:center;color:#999">No matches in this tournament</td></tr>';

        const teamsList = teams.length
            ? teams.map((name) => `<span style="display:inline-block;background:#f1f3f8;padding:8px 14px;border-radius:8px;margin:4px;font-weight:700;font-size:13px">${esc(name)}</span>`).join('')
            : '<span style="color:#999">—</span>';

        container.innerHTML = `
            <div style="background:linear-gradient(135deg,#0a0e27 0%,#1a237e 55%,#283593 100%);color:#fff;padding:44px 32px 52px;text-align:center;position:relative;overflow:hidden;box-sizing:border-box">
                <div style="position:absolute;left:0;bottom:0;width:100%;height:5px;background:linear-gradient(90deg,#ffc107,transparent)"></div>
                <div style="font-size:42px;font-weight:900;letter-spacing:-1px">SLCRICK<span style="color:#ffc107">PRO</span></div>
                <div style="font-size:11px;letter-spacing:4px;opacity:0.75;margin:14px 0 24px;text-transform:uppercase">Tournament Summary Report</div>
                <div style="font-size:28px;font-weight:900;color:#ffc107;line-height:1.2">${esc(t.name || 'Tournament')}</div>
                <div style="font-size:12px;opacity:0.85;margin-top:10px">${esc(generatedAt)} · ${completed.length} matches completed</div>
            </div>

            <div style="padding:28px 28px 36px;box-sizing:border-box">
                <div style="background:#fff;border-radius:16px;padding:22px 24px;margin-bottom:28px;box-shadow:0 6px 24px rgba(26,35,126,0.07)">
                <div style="font-size:13px;font-weight:900;color:#1a237e;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;border-bottom:3px solid #ffc107;display:inline-block;padding-bottom:6px">Tournament details</div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:8px;font-size:13px">
                    <tbody>${metaHtml}</tbody>
                </table>
                </div>

                <div style="font-size:13px;font-weight:900;color:#666;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px">Participating teams</div>
                <div style="margin-bottom:28px;background:#fff;padding:16px 18px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,0.04)">${teamsList}</div>

                <div style="font-size:13px;font-weight:900;color:#1a237e;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px">🏆 Points table</div>
                <div style="background:#fff;border-radius:16px;overflow:hidden;margin-bottom:32px;box-shadow:0 6px 24px rgba(26,35,126,0.07)">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                    <thead><tr style="background:#f1f3f8;color:#1a237e;text-align:left">
                        <th style="padding:14px">#</th><th style="padding:14px">Team</th><th style="padding:14px;text-align:center">P</th>
                        <th style="padding:14px;text-align:center">W</th><th style="padding:14px;text-align:center">L</th><th style="padding:14px;text-align:center">T</th>
                        <th style="padding:14px;text-align:center">Pts</th><th style="padding:14px;text-align:right">NRR</th>
                    </tr></thead>
                    <tbody>${standingsRows}</tbody>
                </table>
                </div>

                <div class="html2pdf__page-break"></div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:32px">
                    <div>
                        <div style="font-size:16px;font-weight:900;color:#1a237e;margin-bottom:14px">TOP BATSMEN</div>
                        <table style="width:100%;border-collapse:collapse;font-size:12px">
                            <thead><tr style="background:#1a237e;color:#fff"><th style="padding:10px">Player</th><th style="padding:10px;text-align:center">M</th><th style="padding:10px;text-align:center">Runs</th><th style="padding:10px;text-align:center">HS</th><th style="padding:10px;text-align:right">SR</th></tr></thead>
                            <tbody>${batRows}</tbody>
                        </table>
                    </div>
                    <div>
                        <div style="font-size:16px;font-weight:900;color:#c62828;margin-bottom:14px">TOP BOWLERS</div>
                        <table style="width:100%;border-collapse:collapse;font-size:12px">
                            <thead><tr style="background:#c62828;color:#fff"><th style="padding:10px">Player</th><th style="padding:10px;text-align:center">M</th><th style="padding:10px;text-align:center">Wkts</th><th style="padding:10px;text-align:right">Econ</th></tr></thead>
                            <tbody>${bowlRows}</tbody>
                        </table>
                    </div>
                </div>

                <div style="font-size:13px;font-weight:900;color:#1a237e;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px">📅 All matches</div>
                <div style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(26,35,126,0.07)">
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                    <thead><tr style="background:#f8f9fa;color:#1a237e;text-align:left">
                        <th style="padding:14px">Fixture</th><th style="padding:14px">Score / Result</th><th style="padding:14px;text-align:right">Status</th>
                    </tr></thead>
                    <tbody>${matchRows}</tbody>
                </table>
                </div>

                <div style="margin-top:32px;padding:18px;background:linear-gradient(90deg,#1a237e,#283593);border-radius:12px;text-align:center;color:#fff">
                    <div style="font-size:11px;font-weight:800;letter-spacing:3px;opacity:0.9">SLCRICKPRO TOURNAMENT</div>
                    <div style="font-size:10px;opacity:0.7;margin-top:6px">${esc(t.id)} · ${esc(generatedAt)}</div>
                </div>
            </div>`;

        await new Promise((r) => setTimeout(r, 1200));

        const opt = this._pdfCaptureOptions(
            container,
            `SLCRICKPRO_Tournament_${(t.name || 'Season').replace(/[^\w\-]+/g, '_')}.pdf`
        );

        try {
            const saved = await this._exportPdf(container, opt);
            if (saved?.canceled) {
                if (typeof showToast === 'function') showToast('PDF save canceled', 'default');
            } else if (typeof showToast === 'function') {
                showToast(
                    saved?.path ? `Tournament PDF saved — ${saved.path}` : 'Tournament PDF downloaded',
                    'success'
                );
            }
        } catch (err) {
            console.error('Tournament PDF Export Error:', err);
            if (typeof showToast === 'function') showToast('PDF export failed', 'error');
            else alert('PDF export failed: ' + (err.message || err));
        } finally {
            pdfRoot.remove();
            overlay.remove();
        }
    },
};

window.MatchReportEngine = MatchReportEngine;
