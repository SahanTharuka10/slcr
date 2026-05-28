/**
 * Schedule tournaments via Electron main process → files on disk.
 * Does NOT require window.DB (fixes "Database not ready").
 */
(function (global) {
  function toast(msg, type) {
    if (typeof global.showToast === 'function') {
      global.showToast(msg, type);
    } else {
      console.log('[SLCRICKPRO]', msg);
    }
  }

  function readForm() {
    const teamsRaw = (document.getElementById('tourn-teams')?.value || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    return {
      name: (document.getElementById('tourn-name')?.value || '').trim(),
      format: document.getElementById('tourn-format')?.value || 'league',
      overs: parseInt(document.getElementById('tourn-overs')?.value, 10) || 20,
      ballsPerOver: parseInt(document.getElementById('tourn-bpo')?.value, 10) || 6,
      scoringPassword:
        (document.getElementById('tourn-scoring-password')?.value || '').trim() || 'offline',
      teams: teamsRaw,
      matchCount: parseInt(document.getElementById('tourn-match-count')?.value, 10) || 10,
      tournType: document.getElementById('tourn-type')?.value || 'unofficial',
    };
  }

  async function scheduleTournamentNow() {
    const form = readForm();

    if (form.teams.length < 2) {
      toast('Enter at least 2 teams (one per line)', 'error');
      document.getElementById('tourn-teams')?.focus();
      return;
    }

    const unique = [...new Set(form.teams)];
    if (unique.length < 2) {
      toast('Use at least 2 different team names', 'error');
      return;
    }

    if (form.tournType === 'official') {
      toast('Choose Unofficial for local desktop tournaments', 'error');
      return;
    }

    if (!global.desktopAPI?.scheduleTournament) {
      toast('Desktop storage API missing — restart with START-SLCRICKPRO-DESKTOP.bat', 'error');
      return;
    }

    const btn = document.getElementById('btn-schedule-tournament');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving to PC…';
    }

    try {
      toast('Saving match files on your computer…', 'default');

      const result = await global.desktopAPI.scheduleTournament({
        name: form.name,
        format: form.format,
        overs: form.overs,
        ballsPerOver: form.ballsPerOver,
        scoringPassword: form.scoringPassword,
        teams: unique,
        matchCount: form.matchCount,
      });

      if (!result?.ok) {
        toast('Failed: ' + (result?.error || 'unknown'), 'error');
        return;
      }

      const t = result.tournament;
      if (t?.id) {
        const pw = form.scoringPassword || 'offline';
        localStorage.setItem(`tourn_pw_${t.id}`, pw);
        if (typeof setTournamentAuthorized === 'function') {
          setTournamentAuthorized(t.id, 'local-creator', 7200000);
        }
      }

      if (typeof global.SLCRICK_renderFromSchedule === 'function') {
        global.SLCRICK_renderFromSchedule(result);
      }
      setTimeout(() => {
        if (typeof global.SLCRICK_renderResumeList === 'function') {
          global.SLCRICK_renderResumeList();
        } else if (typeof renderResumeMatches === 'function') {
          renderResumeMatches();
        }
      }, 300);

      document.getElementById('tourn-teams').value = '';
      if (result.tournament?.name) {
        const nameEl = document.getElementById('tourn-name');
        if (nameEl && !nameEl.value.trim()) nameEl.value = result.tournament.name;
      }

      if (typeof selectMatchType === 'function') selectMatchType('tournament');

      const list = document.getElementById('resume-matches-list');
      if (list) {
        list.style.background = 'rgba(34,197,94,0.12)';
        list.style.borderRadius = '12px';
        setTimeout(() => {
          list.style.background = '';
          list.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }

      const tName = t?.name || 'Tournament';
      toast(
        `🏆 "${tName}" — ${result.matchCount} matches in RECENT list below`,
        'success'
      );
    } catch (e) {
      console.error('[scheduleTournamentNow]', e);
      toast('Error: ' + (e.message || e), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📅 Schedule Tournament Matches';
      }
    }
  }

  global.scheduleTournamentNow = scheduleTournamentNow;
  global.scheduleTournamentFromForm = scheduleTournamentNow;

  function bindScheduleButton() {
    const btn = document.getElementById('btn-schedule-tournament');
    if (!btn || btn.dataset.slcrickBound === '1') return;
    btn.dataset.slcrickBound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      scheduleTournamentNow();
    });
  }

  if (document.getElementById('btn-schedule-tournament')) {
    bindScheduleButton();
  } else {
    document.addEventListener('DOMContentLoaded', bindScheduleButton, { once: true });
  }
})(window);
