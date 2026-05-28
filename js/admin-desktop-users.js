/**
 * Admin — desktop app users (Vercel /api with DATABASE_URL, or Render API).
 */
(function () {
  const ADMIN_TOKEN_KEY = 'slcrick_admin_token';
  const API_BASE_KEY = 'slcrick_admin_api_base';
  const RENDER_API = 'https://slcrickpro.onrender.com';

  function isLiveSite() {
    const h = (location.hostname || '').toLowerCase();
    return h.includes('slcrickpro.live') || h.includes('www.slcrickpro');
  }

  function getBackendCandidates() {
    const saved = (sessionStorage.getItem(API_BASE_KEY) || '').trim();
    const origin = isLiveSite() ? location.origin.replace(/\/$/, '') : '';
    const list = [];
    if (saved) list.push(saved);
    if (origin) list.push(origin);
    list.push(RENDER_API);
    return [...new Set(list.filter(Boolean))];
  }

  function getBackendUrl() {
    const saved = (sessionStorage.getItem(API_BASE_KEY) || '').trim();
    if (saved) return saved;
    if (isLiveSite()) return location.origin.replace(/\/$/, '');
    if (window.SLCRICK_DESKTOP) return RENDER_API;
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

  function clearStaleCloudSession() {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    sessionStorage.removeItem('isAdmin');
    sessionStorage.removeItem(API_BASE_KEY);
  }

  function adminHeaders() {
    const token = getAdminToken();
    return {
      'Content-Type': 'application/json',
      Authorization: token ? 'Bearer ' + token : '',
    };
  }

  /** True only if desktop-users endpoint exists (401/200), not static /api/version. */
  async function checkDesktopUsersApi(base) {
    try {
      const probe = await fetch(base + '/api/admin/desktop-users', {
        cache: 'no-store',
        mode: 'cors',
        headers: adminHeaders(),
      });
      if (probe.status === 401 || probe.ok) return true;
      if (probe.status === 404) return false;

      const ver = await fetch(base + '/api/version', { cache: 'no-store', mode: 'cors' });
      if (!ver.ok) return false;
      const data = await ver.json().catch(() => ({}));
      if (data.source === 'static-fallback') return false;
      if (data.features?.desktopUsers !== true) return false;
      const probe2 = await fetch(base + '/api/admin/desktop-users', {
        cache: 'no-store',
        mode: 'cors',
        headers: adminHeaders(),
      });
      return probe2.status === 401 || probe2.ok;
    } catch (_) {
      return false;
    }
  }

  function apiErrorMessage(res, data, context, apiBase) {
    if (res.status === 401) {
      return 'Admin session expired — logout and login again with PIN slcrickpro@2026.';
    }
    if (res.status === 404 || res.status === 502 || res.status === 503) {
      return (
        (data.error || data.message || 'Cloud API not ready') +
        '. Vercel: add DATABASE_URL (same as Render). Render: Manual Deploy, Start Command node server.js.'
      );
    }
    return data.error || data.message || context + ' failed (HTTP ' + res.status + ')';
  }

  let _apiBase = '';

  function updateCloudHint() {
    const el = document.getElementById('desktop-users-cloud-hint');
    if (!el) return;
    const token = getAdminToken();
    if (!token) {
      el.style.display = 'block';
      el.style.color = 'var(--c-amber)';
      el.innerHTML =
        '<strong>Cloud admin login required.</strong> Logout → login with PIN <code>slcrickpro@2026</code>.';
      return;
    }
    el.style.display = 'block';
    el.style.color = 'var(--c-muted)';
    el.innerHTML = 'Checking cloud API…';
    Promise.all(getBackendCandidates().map((b) => checkDesktopUsersApi(b).then((ok) => ({ b, ok })))).then(
      (results) => {
        const hit = results.find((r) => r.ok);
        el.innerHTML =
          'API: <code>' +
          (hit ? hit.b : getBackendUrl()) +
          '</code> · Desktop users: <strong style="color:' +
          (hit ? '#22c55e' : '#ff6b6b') +
          '">' +
          (hit ? 'READY' : 'Set DATABASE_URL on Vercel or deploy Render') +
          '</strong>';
      }
    );
  }

  async function adminFetch(path, options = {}) {
    const candidates = getBackendCandidates();
    let lastErr = null;

    for (const base of candidates) {
      _apiBase = base;
      const url = base + path;
      let res;
      try {
        res = await fetch(url, {
          ...options,
          headers: { ...adminHeaders(), ...(options.headers || {}) },
        });
      } catch (e) {
        lastErr = e;
        continue;
      }

      let data = {};
      const text = await res.text().catch(() => '');
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {
        data = { error: text || res.statusText };
      }

      if (res.status === 401) {
        clearStaleCloudSession();
        throw new Error(apiErrorMessage(res, data, options.context || 'Request', base));
      }

      if (res.status === 404 || res.status === 502 || res.status === 503) {
        lastErr = new Error(apiErrorMessage(res, data, options.context || 'Request', base));
        continue;
      }

      if (!res.ok) {
        lastErr = new Error(apiErrorMessage(res, data, options.context || 'Request', base));
        continue;
      }

      sessionStorage.setItem(API_BASE_KEY, base);
      return data;
    }

    throw lastErr || new Error(options.context || 'Request failed');
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
          '<div class="empty-state"><div class="empty-state-title">No desktop users yet</div><p style="color:var(--c-muted);margin-top:8px">Create one below — saved in Supabase.</p></div>';
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
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-ghost btn-sm" data-history="${escapeAttr(u.id)}">History PDF</button>
            <button type="button" class="btn btn-ghost btn-sm" data-toggle="${escapeAttr(u.id)}" data-active="${u.active ? '1' : '0'}">${u.active ? 'Disable' : 'Enable'}</button>
            <button type="button" class="btn btn-ghost btn-sm" style="color:#ff6b6b" data-delete="${escapeAttr(u.id)}">Delete</button>
          </div>
        </div>`
        )
        .join('');

      list.querySelectorAll('[data-history]').forEach((btn) => {
        btn.addEventListener('click', () => downloadHistoryPdf(btn.getAttribute('data-history')));
      });
      list.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => toggleUser(btn.getAttribute('data-toggle'), btn.getAttribute('data-active') === '1'));
      });
      list.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', () => deleteUser(btn.getAttribute('data-delete')));
      });
    } catch (e) {
      list.innerHTML = '<p style="color:#ff6b6b">' + escapeHtml(e.message || 'Failed to load') + '</p>';
    }
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  async function createDesktopUserAdmin() {
    const username = (document.getElementById('du-username')?.value || '').trim();
    const displayName = (document.getElementById('du-display')?.value || '').trim();
    const password = (document.getElementById('du-password')?.value || '').trim();
    if (!username || !password) {
      alert('Username and password required');
      return;
    }
    try {
      await adminFetch('/api/admin/desktop-users', {
        method: 'POST',
        context: 'Create user',
        body: JSON.stringify({ username, displayName, password }),
      });
      document.getElementById('du-username').value = '';
      document.getElementById('du-display').value = '';
      document.getElementById('du-password').value = '';
      await renderDesktopUsersAdmin();
      if (typeof showToast === 'function') showToast('Desktop user created', 'success');
    } catch (e) {
      alert(e.message || 'Create failed');
    }
  }

  async function toggleUser(id, currentlyActive) {
    try {
      await adminFetch('/api/admin/desktop-users/' + encodeURIComponent(id), {
        method: 'PATCH',
        context: 'Update user',
        body: JSON.stringify({ active: !currentlyActive }),
      });
      await renderDesktopUsersAdmin();
    } catch (e) {
      alert(e.message || 'Update failed');
    }
  }

  async function deleteUser(id) {
    if (!confirm('Delete this desktop user and all activity history?')) return;
    try {
      await adminFetch('/api/admin/desktop-users/' + encodeURIComponent(id), {
        method: 'DELETE',
        context: 'Delete user',
      });
      await renderDesktopUsersAdmin();
    } catch (e) {
      alert(e.message || 'Delete failed');
    }
  }

  async function downloadHistoryPdf(userId) {
    try {
      const data = await adminFetch(
        '/api/admin/desktop-users/' + encodeURIComponent(userId) + '/activity',
        { context: 'Load history' }
      );
      const user = data.user || {};
      const activity = data.activity || [];
      const w = window.open('', '_blank');
      if (!w) {
        alert('Allow popups to print PDF');
        return;
      }
      const rows = activity
        .map(
          (a) =>
            `<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.playedAt || '')}</td><td>${escapeHtml(a.format || '')}</td><td>${a.matchCount ?? ''}</td><td>${escapeHtml(a.status || '')}</td></tr>`
        )
        .join('');
      w.document.write(`
        <html><head><title>History — ${escapeHtml(user.username)}</title>
        <style>body{font-family:sans-serif;padding:24px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:8px}</style>
        </head><body>
        <h1>${escapeHtml(user.displayName || user.username)}</h1>
        <p>@${escapeHtml(user.username)}</p>
        <table><thead><tr><th>Tournament</th><th>Date</th><th>Format</th><th>Matches</th><th>Status</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">No activity</td></tr>'}</tbody></table>
        <script>window.onload=function(){window.print()}</script>
        </body></html>`);
      w.document.close();
    } catch (e) {
      alert(e.message || 'PDF failed');
    }
  }

  window.renderDesktopUsersAdmin = renderDesktopUsersAdmin;
  window.createDesktopUserAdmin = createDesktopUserAdmin;
})();
