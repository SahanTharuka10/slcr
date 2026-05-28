/**
 * Admin — desktop app user accounts (cloud API).
 */
(function () {
  const ADMIN_TOKEN_KEY = 'slcrick_admin_token';
  const DEFAULT_BACKEND = 'https://slcrickpro.onrender.com';

  function getBackendUrl() {
    const fromSync =
      typeof window.SLCRICK_SYNC?.getBackendUrl === 'function'
        ? window.SLCRICK_SYNC.getBackendUrl()
        : '';
    const fromLs = (localStorage.getItem('cricpro_backend_url') || '').trim();
    const fromCfg = (window.CRICPRO_CLOUD_CONFIG?.backendUrl || '').trim();
    const base = (fromSync || fromLs || fromCfg || DEFAULT_BACKEND).replace(/\/$/, '');
    if (/^https?:\/\//i.test(base)) return base;
    if (location.protocol.startsWith('http')) return location.origin.replace(/\/$/, '');
    return DEFAULT_BACKEND;
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

  function updateCloudHint() {
    const el = document.getElementById('desktop-users-cloud-hint');
    if (!el) return;
    const token = getAdminToken();
    if (!token) {
      el.style.display = 'block';
      el.style.color = 'var(--c-amber)';
      el.textContent =
        'Cloud admin login ඕනේ — site admin PIN එකෙන් login වෙලා මෙ tab එක use කරන්න. (Offline PIN 1234 මේ users manage කරන්න බැහැ.)';
      return;
    }
    el.style.display = 'block';
    el.style.color = 'var(--c-muted)';
    el.textContent = 'Backend: ' + getBackendUrl();
  }

  async function fetchDesktopUsers() {
    const base = getBackendUrl();
    const res = await fetch(base + '/api/admin/desktop-users', { headers: adminHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'Failed to load users');
    return data.users || [];
  }

  async function renderDesktopUsersAdmin() {
    const list = document.getElementById('desktop-users-list');
    if (!list) return;
    updateCloudHint();

    if (!getAdminToken()) {
      list.innerHTML =
        '<p style="color:var(--c-muted)">Log in with your site admin PIN first.</p>';
      return;
    }

    list.innerHTML = '<p style="color:var(--c-muted)">Loading…</p>';
    try {
      const users = await fetchDesktopUsers();
      if (!users.length) {
        list.innerHTML =
          '<div class="empty-state"><div class="empty-state-title">No desktop users yet</div></div>';
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
      list.innerHTML =
        '<p style="color:#ff6b6b">' + escapeHtml(e.message || 'Load failed') + '</p>';
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
    const username = document.getElementById('du-username')?.value?.trim();
    const displayName = document.getElementById('du-display')?.value?.trim();
    const password = document.getElementById('du-password')?.value?.trim();
    if (!getAdminToken()) {
      showToast('Site admin cloud login required', 'error');
      return;
    }
    if (!username || !password) {
      showToast('Username and password required', 'error');
      return;
    }
    try {
      const base = getBackendUrl();
      const res = await fetch(base + '/api/admin/desktop-users', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ username, password, displayName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Create failed');
      showToast('Desktop user created: ' + username, 'success');
      document.getElementById('du-username').value = '';
      document.getElementById('du-display').value = '';
      document.getElementById('du-password').value = '';
      renderDesktopUsersAdmin();
    } catch (e) {
      showToast(e.message || 'Create failed', 'error');
    }
  }

  async function toggleDesktopUserActive(id, active) {
    try {
      const base = getBackendUrl();
      const res = await fetch(base + '/api/admin/desktop-users/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ active: active === true || active === 'true' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Update failed');
      }
      showToast('User updated', 'success');
      renderDesktopUsersAdmin();
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    }
  }

  async function deleteDesktopUserAdmin(id) {
    if (!confirm('Delete this desktop user and all their tournament history?')) return;
    try {
      const base = getBackendUrl();
      const res = await fetch(base + '/api/admin/desktop-users/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: adminHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      showToast('User deleted', 'success');
      renderDesktopUsersAdmin();
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error');
    }
  }

  async function downloadDesktopUserHistoryPdf(userId) {
    if (!getAdminToken()) {
      showToast('Site admin cloud login required', 'error');
      return;
    }
    try {
      const base = getBackendUrl();
      const res = await fetch(
        base + '/api/admin/desktop-users/' + encodeURIComponent(userId) + '/activity',
        { headers: adminHeaders() }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to load history');

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
    showToast('Print dialog opened — save as PDF: ' + filename, 'success');
  }

  window.renderDesktopUsersAdmin = renderDesktopUsersAdmin;
  window.createDesktopUserAdmin = createDesktopUserAdmin;
  window.toggleDesktopUserActive = toggleDesktopUserActive;
  window.deleteDesktopUserAdmin = deleteDesktopUserAdmin;
  window.downloadDesktopUserHistoryPdf = downloadDesktopUserHistoryPdf;
})();
