/**
 * Admin — desktop app user accounts (cloud API on Render → Supabase).
 */
(function () {
  const ADMIN_TOKEN_KEY = 'slcrick_admin_token';
  const RENDER_API = 'https://slcrickpro.onrender.com';

  function isLiveSite() {
    const h = (location.hostname || '').toLowerCase();
    return h.includes('slcrickpro.live') || h.includes('www.slcrickpro');
  }

  function getBackendUrl() {
    if (isLiveSite() || window.SLCRICK_DESKTOP) return RENDER_API;
    const fromSync =
      typeof window.SLCRICK_SYNC?.getBackendUrl === 'function'
        ? window.SLCRICK_SYNC.getBackendUrl()
        : '';
    const fromLs = (localStorage.getItem('cricpro_backend_url') || '').trim();
    const fromCfg = (window.CRICPRO_CLOUD_CONFIG?.backendUrl || '').trim();
    const base = (fromSync || fromLs || fromCfg || RENDER_API).replace(/\/$/, '');
    if (/^https?:\/\//i.test(base) && base.includes('onrender.com')) return base;
    if (/^https?:\/\//i.test(base) && !base.includes('slcrickpro.live')) return base;
    return RENDER_API;
  }

  function getAdminToken() {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  }

  function adminHeaders() {
    const token = getAdminToken();
    return {
      'Content-Type': 'application/json',
      Authorization: token ? 'Bearer ' + token : '',
    };
  }

  async function wakeBackend(base) {
    try {
      await fetch(base + '/api/ping', { cache: 'no-store', mode: 'cors' });
    } catch (_) {}
  }

  async function checkDesktopUsersApi(base) {
    try {
      const res = await fetch(base + '/api/version', { cache: 'no-store', mode: 'cors' });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return data.features?.desktopUsers === true;
    } catch (_) {
      return false;
    }
  }

  function apiErrorMessage(res, data, context) {
    if (res.status === 401) {
      return 'Admin session expired — logout and login again with site PIN (slcrickpro@2026).';
    }
    if (res.status === 404) {
      return (
        'Server API not updated yet. Render dashboard → slcrickpro service → Manual Deploy (latest GitHub main). ' +
        'Then open ' +
        base +
        '/api/version — must show desktopUsers: true.'
      );
    }
    return data.error || data.message || context + ' failed (HTTP ' + res.status + ')';
  }

  let _apiBase = '';

  function updateCloudHint() {
    const el = document.getElementById('desktop-users-cloud-hint');
    if (!el) return;
    const token = getAdminToken();
    const base = getBackendUrl();
    if (!token) {
      el.style.display = 'block';
      el.style.color = 'var(--c-amber)';
      el.innerHTML =
        '<strong>Cloud admin login required.</strong> Logout → login with site admin PIN <code>slcrickpro@2026</code> (not offline 1234).';
      return;
    }
    el.style.display = 'block';
    el.style.color = 'var(--c-muted)';
    el.innerHTML = 'API: <code>' + base + '</code> · Checking server…';
    checkDesktopUsersApi(base).then((ok) => {
      el.innerHTML =
        'API: <code>' +
        base +
        '</code> · Desktop users API: <strong style="color:' +
        (ok ? '#22c55e' : '#ff6b6b') +
        '">' +
        (ok ? 'READY' : 'NOT DEPLOYED — redeploy Render') +
        '</strong>';
    });
  }

  async function adminFetch(path, options = {}) {
    const base = getBackendUrl();
    _apiBase = base;
    await wakeBackend(base);
    const url = base + path;
    const res = await fetch(url, {
      ...options,
      headers: { ...adminHeaders(), ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(res, data, options.context || 'Request'));
    return data;
  }

  async function fetchDesktopUsers() {
    const data = await adminFetch('/api/admin/desktop-users', { context: 'Load users' });
    return data.users || [];
  }

  async function renderDesktopUsersAdmin() {
    const list = document.getElementById('desktop-users-list');
    if (!list) return;
    updateCloudHint();

    if (!getAdminToken()) {
      list.innerHTML =
        '<p style="color:var(--c-amber)">Logout කරලා <strong>slcrickpro@2026</strong> PIN එකෙන් cloud login වෙලා ආවාම මෙ tab එක open කරන්න.</p>';
      return;
    }

    list.innerHTML = '<p style="color:var(--c-muted)">Loading…</p>';
    try {
      const users = await fetchDesktopUsers();
      if (!users.length) {
        list.innerHTML =
          '<div class="empty-state"><div class="empty-state-title">No desktop users yet</div><p style="color:var(--c-muted);margin-top:8px">Create one below — stored in Supabase via Render API.</p></div>';
        return;
      }
      list.innerHTML = users
        .map(
          (u) => `
        <div class="request-card" style="flex-wrap:wrap;gap:12px">
          <div class="req-info">
            <h3>${escapeHtml(u.displayName || u.username)}</h3>
            <p>@${escapeHtml(u.username)} · ${u.active ? 'Active' : 'Disabled'}
              ${u.lastLoginAt ? ' · Last login: ' + new Date(u.lastLoginAt).toLocaleString() : ''}</p>
          </div>
          <div class="req-actions" style="flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" type="button" onclick="downloadDesktopUserHistoryPdf('${u.id}')">📄 History PDF</button>
            <button class="btn btn-ghost btn-sm" type="button" onclick="toggleDesktopUserActive('${u.id}',${u.active ? 'false' : 'true'})">${u.active ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-red btn-sm" type="button" onclick="deleteDesktopUserAdmin('${u.id}')">Delete</button>
          </div>
        </div>`
        )
        .join('');
    } catch (e) {
      list.innerHTML = '<p style="color:#ff6b6b;line-height:1.5">' + escapeHtml(e.message || 'Load failed') + '</p>';
    }
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function createDesktopUserAdmin() {
    const username = document.getElementById('du-username')?.value?.trim().toLowerCase();
    const displayName = document.getElementById('du-display')?.value?.trim();
    const password = document.getElementById('du-password')?.value?.trim();
    if (!getAdminToken()) {
      showToast('Cloud admin login required (PIN slcrickpro@2026)', 'error');
      return;
    }
    if (!username || username.length < 2) {
      showToast('Username min 2 characters', 'error');
      return;
    }
    if (!password || password.length < 4) {
      showToast('Password min 4 characters', 'error');
      return;
    }
    const btn = document.querySelector('#tab-desktop-users .btn-green');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Creating…';
    }
    try {
      await adminFetch('/api/admin/desktop-users', {
        method: 'POST',
        context: 'Create user',
        body: JSON.stringify({ username, password, displayName }),
      });
      showToast('Desktop user created: ' + username, 'success');
      document.getElementById('du-username').value = '';
      document.getElementById('du-display').value = '';
      document.getElementById('du-password').value = '';
      renderDesktopUsersAdmin();
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '➕ Create user';
      }
    }
  }

  async function toggleDesktopUserActive(id, active) {
    try {
      await adminFetch('/api/admin/desktop-users/' + encodeURIComponent(id), {
        method: 'PATCH',
        context: 'Update user',
        body: JSON.stringify({ active: active === true || active === 'true' }),
      });
      showToast('User updated', 'success');
      renderDesktopUsersAdmin();
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    }
  }

  async function deleteDesktopUserAdmin(id) {
    if (!confirm('Delete this desktop user and all their tournament history?')) return;
    try {
      await adminFetch('/api/admin/desktop-users/' + encodeURIComponent(id), {
        method: 'DELETE',
        context: 'Delete user',
      });
      showToast('User deleted', 'success');
      renderDesktopUsersAdmin();
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error');
    }
  }

  async function downloadDesktopUserHistoryPdf(userId) {
    if (!getAdminToken()) {
      showToast('Cloud admin login required', 'error');
      return;
    }
    try {
      const data = await adminFetch(
        '/api/admin/desktop-users/' + encodeURIComponent(userId) + '/activity',
        { context: 'Load history' }
      );
      const user = data.user || {};
      const rows = data.activity || [];
      const html = buildHistoryHtml(user, rows);
      openPrintPdf(html, (user.username || 'user') + '-history.pdf');
    } catch (e) {
      showToast(e.message || 'PDF failed', 'error');
    }
  }

  function buildHistoryHtml(user, rows) {
    const trs = rows.length
      ? rows
          .map(
            (r) =>
              `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.playedAt || '—')}</td><td>${escapeHtml(r.format || '—')}</td><td>${r.matchCount ?? '—'}</td><td>${escapeHtml(r.status || '')}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="5">No tournaments recorded yet</td></tr>';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Desktop User History</title>
<style>body{font-family:Segoe UI,sans-serif;padding:32px;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ccc;padding:8px;text-align:left;font-size:13px}th{background:#f0f0f0}</style></head>
<body><h1>SLCRICKPRO — Desktop User History</h1>
<p><strong>${escapeHtml(user.displayName || user.username)}</strong> (@${escapeHtml(user.username)})</p>
<p>Generated: ${new Date().toLocaleString()}</p>
<table><thead><tr><th>Tournament</th><th>Date</th><th>Format</th><th>Matches</th><th>Status</th></tr></thead><tbody>${trs}</tbody></table></body></html>`;
  }

  function openPrintPdf(html, filename) {
    const w = window.open('', '_blank');
    if (!w) {
      showToast('Allow popups to download PDF', 'error');
      return;
    }
    w.document.write(html);
    w.document.close();
    w.onload = () => {
      w.focus();
      w.print();
    };
    showToast('Print dialog — save as PDF: ' + filename, 'success');
  }

  window.renderDesktopUsersAdmin = renderDesktopUsersAdmin;
  window.createDesktopUserAdmin = createDesktopUserAdmin;
  window.toggleDesktopUserActive = toggleDesktopUserActive;
  window.deleteDesktopUserAdmin = deleteDesktopUserAdmin;
  window.downloadDesktopUserHistoryPdf = downloadDesktopUserHistoryPdf;
})();
