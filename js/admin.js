// Admin JS — offline desktop (local data only)
const OFFLINE_ADMIN_PIN = '1234';

let currentTab = 'requests';

document.addEventListener('DOMContentLoaded', () => {
    if (typeof window.pullGlobalData === 'function') window.pullGlobalData();
    checkAdminAuth();
    renderRequests();
});

function checkAdminAuth() {
    const login = document.getElementById('admin-login-section');
    const content = document.getElementById('admin-content-section');
    if (!login || !content) return;

    if (sessionStorage.getItem('isAdmin') === 'true') {
        login.style.display = 'none';
        content.style.display = 'block';
        return;
    }

    login.style.display = 'block';
    content.style.display = 'none';
}

let loginAttempts = 0;

async function loginAdmin() {
    const pass = (document.getElementById('admin-password')?.value || '').trim();

    if (!pass) {
        showToast('❌ Enter Admin PIN (default: 1234)', 'error');
        return;
    }

    const btn = document.querySelector('#admin-login-section .btn-primary');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Logging in…';
    }

    const customPin = localStorage.getItem('cricpro_admin_pin') || OFFLINE_ADMIN_PIN;
    if (pass === customPin || pass === OFFLINE_ADMIN_PIN) {
        loginAttempts = 0;
        sessionStorage.setItem('isAdmin', 'true');
        checkAdminAuth();
        showToast('🔓 Admin panel unlocked (offline)', 'success');
    } else {
        loginAttempts++;
        showToast('❌ Wrong PIN', 'error');
        if (loginAttempts >= 2) {
            const hint = document.getElementById('login-hint');
            if (hint) {
                hint.style.display = 'block';
                hint.textContent = 'Offline default PIN: 1234';
            }
        }
    }

    if (btn) {
        btn.disabled = false;
        btn.textContent = 'Login';
    }
}

function logoutAdmin() {
    sessionStorage.removeItem('isAdmin');
    location.reload();
}

function switchAdminTab(tab) {
    currentTab = tab;
    const panels = ['requests', 'matches', 'tournaments', 'players', 'store', 'posts', 'feedback', 'match-entry'];
    panels.forEach((p) => {
        const el = document.getElementById('tab-' + p);
        const btn = document.getElementById('btn-tab-' + p);
        if (el) el.style.display = p === tab ? 'block' : 'none';
        if (btn) {
            btn.className = p === tab ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
        }
    });

    if (tab === 'requests') renderRequests();
    if (tab === 'matches') renderSystemMatches();
    if (tab === 'tournaments') renderTournamentsAdmin();
    if (tab === 'players') renderPlayersAdmin();
    if (tab === 'store') renderStoreItems();
    if (tab === 'posts') renderPostsAdmin();
    if (tab === 'feedback') renderFeedbackAdmin();
    if (tab === 'match-entry' && typeof initMatchEntryTab === 'function') initMatchEntryTab();
}

function renderRequests() {
    const container = document.getElementById('requests-list');
    const reqs = DB.getRequests();

    if (!reqs || !reqs.length) {
        container.innerHTML = `<div class="empty-state">
          <div class="empty-state-icon">📥</div>
          <div class="empty-state-title">Inbox is empty</div>
        </div>`;
        return;
    }

    const pendingList = reqs.filter((r) => r.status === 'pending');

    if (!pendingList.length) {
        container.innerHTML = `<div class="empty-state">
          <div class="empty-state-icon">✔️</div>
          <div class="empty-state-title">All Caught Up</div>
        </div>`;
        return;
    }

    container.innerHTML = pendingList
        .map((req) => {
            let titleBlock = '';
            let targetType = '';
            if (req.type === 'tournament') {
                const t = DB.getTournament(req.tournamentId);
                titleBlock = t ? `🏆 ${t.name}` : 'Unknown Tournament';
                targetType = 'Tournament';
            } else {
                const m = DB.getMatch(req.matchId);
                titleBlock = m ? `🏏 ${m.team1} vs ${m.team2}` : 'Unknown Match';
                targetType = 'Match';
            }
            return `
        <div class="admin-card">
            <div class="admin-card-head">
                <div>
                    <div class="admin-badge">${targetType} Request</div>
                    <h4>${titleBlock}</h4>
                    <p>From: ${req.requesterName || 'Unknown'} · ${timeSince(req.createdAt || Date.now())}</p>
                </div>
                <div class="admin-card-actions">
                    <button class="btn btn-green btn-sm" onclick="approveRequest('${req.id}')">✅ Approve</button>
                    <button class="btn btn-red btn-sm" onclick="rejectRequest('${req.id}')">❌ Reject</button>
                </div>
            </div>
        </div>`;
        })
        .join('');
}

function approveRequest(id) {
    const reqs = DB.getRequests();
    const req = reqs.find((r) => r.id === id);
    if (!req) return;

    req.status = 'approved';
    DB.saveRequests(reqs);

    if (req.type === 'tournament' && req.tournamentId) {
        const t = DB.getTournament(req.tournamentId);
        if (t) {
            t.status = 'active';
            DB.saveTournament(t);
        }
    }

    showToast('✅ Request approved locally', 'success');
    renderRequests();
}

function rejectRequest(id) {
    const reqs = DB.getRequests();
    const idx = reqs.findIndex((r) => r.id === id);
    if (idx === -1) return;
    reqs[idx].status = 'rejected';
    DB.saveRequests(reqs);
    showToast('Request rejected', 'default');
    renderRequests();
}

function renderSystemMatches() {
    const container = document.getElementById('matches-list');
    const statsEl = document.getElementById('storage-stats-box');
    if (statsEl && typeof DB.getStorageStats === 'function') {
        const s = DB.getStorageStats();
        statsEl.innerHTML = `
            <strong style="color:var(--c-text)">Storage</strong><br>
            Matches: ${s.matchCount} · Tournaments: ${s.tournamentCount}<br>
            Match data: ~${s.dataMB} MB · Photo cache: ~${s.photoCacheMB} MB
        `;
    }
    if (!container) return;
    const matches = DB.getMatches().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (!matches.length) {
        container.innerHTML = '<p style="opacity:0.6;padding:20px">No matches saved locally.</p>';
        return;
    }

    container.innerHTML = matches
        .map(
            (m) => `
        <div class="admin-card" style="margin-bottom:10px">
            <strong>${m.team1} vs ${m.team2}</strong>
            <span style="opacity:0.6;margin-left:8px">${m.status}</span>
            <button class="btn btn-red btn-sm" style="float:right" onclick="deleteAdminMatch('${m.id}')">Delete</button>
        </div>`
        )
        .join('');
}

function deleteAdminMatch(id) {
    if (!confirm('Delete this match from local storage?')) return;
    DB.deleteMatch(id);
    renderSystemMatches();
    showToast('Match deleted', 'success');
}

async function purgeCompletedMatchesAdmin() {
    if (!confirm('Delete all COMPLETED matches from this device and cloud? Live/setup matches stay.')) return;
    const res = await DB.purgeAllMatchData({ completedOnly: true, clearPhotos: false });
    renderSystemMatches();
    showToast(`🗑 Cleared ${res.deletedCount} completed match(es)`, 'success');
}

async function purgeAllMatchesAdmin() {
  if (!confirm('⚠ DELETE ALL MATCH DATA?\n\nMatches, reports, photos cache, and match files will be removed.\nTournaments, players, teams, and sync settings stay.\nCloud match records will also be deleted if sync is on.')) return;
    if (!confirm('Final confirm — this cannot be undone. Continue?')) return;
    const res = await DB.purgeAllMatchData({ completedOnly: false, clearPhotos: true, deleteFromCloud: true });
    renderSystemMatches();
    if (typeof renderOngoing === 'function') renderOngoing();
    if (typeof window.renderResumeMatches === 'function') window.renderResumeMatches();
    showToast(`✅ Cleared ${res.deletedCount} match(es) — freed space`, 'success');
}

function clearPhotoCacheAdmin() {
    if (!confirm('Clear cached player/team photos? (Profiles in DB stay; photos reload when needed)')) return;
    const n = DB.clearPhotoCache();
    renderSystemMatches();
    showToast(`📷 Cleared ${n} photo cache entries`, 'success');
}

window.purgeCompletedMatchesAdmin = purgeCompletedMatchesAdmin;
window.purgeAllMatchesAdmin = purgeAllMatchesAdmin;
window.clearPhotoCacheAdmin = clearPhotoCacheAdmin;

function renderTournamentsAdmin() {
    const container = document.getElementById('tournaments-list');
    if (!container) return;
    const tourns = DB.getTournaments();

    if (!tourns.length) {
        container.innerHTML = '<p style="opacity:0.6;padding:20px">No tournaments.</p>';
        return;
    }

    container.innerHTML = tourns
        .map(
            (t) => `
        <div class="admin-card" style="margin-bottom:12px">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap">
                <div>
                    <strong>${escapeHTML(t.name)}</strong>
                    <div style="font-size:12px; opacity:0.65; margin-top:4px">${t.matches?.length || 0} matches · ${t.status || 'active'}</div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap">
                    <input type="file" id="stat-upload-${t.id}" accept=".json,.slcrick-stat.json,application/json" style="display:none" onchange="handleTournamentStatUpload(event, '${t.id}')">
                    <button class="btn btn-green btn-sm" type="button" onclick="document.getElementById('stat-upload-${t.id}').click()">📤 Upload stat report</button>
                    <button class="btn btn-red btn-sm" type="button" onclick="deleteAdminTournament('${t.id}')">Delete</button>
                </div>
            </div>
            <p style="font-size:11px; opacity:0.55; margin:10px 0 0">Desktop: completed match → 📥 SITE. Upload the .slcrick-stat.json here to update standings on the website.</p>
        </div>`
        )
        .join('');
}

async function handleTournamentStatUpload(event, tournamentId) {
    const input = event?.target;
    const file = input?.files?.[0];
    if (!file) return;
    if (typeof MatchStatBundle === 'undefined') {
        showToast('Stat bundle module not loaded — refresh the page', 'error');
        return;
    }

    const btn = input.closest('.admin-card')?.querySelector('.btn-green');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Uploading…';
    }

    try {
        const pushToCloud = typeof syncToDB === 'function' && !window.SLCRICK_DESKTOP;
        const result = await MatchStatBundle.importFromFile(file, {
            expectedTournamentId: tournamentId,
            pushToCloud,
        });
        const m = result.match;
        showToast(
            `✅ ${m.team1} vs ${m.team2} imported${pushToCloud ? ' & sent to site' : ' locally'}`,
            'success'
        );
        renderTournamentsAdmin();
    } catch (e) {
        showToast(e.message || 'Upload failed', 'error');
    } finally {
        if (input) input.value = '';
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📤 Upload stat report';
        }
    }
}

function deleteAdminTournament(id) {
    if (!confirm('Delete tournament and its match links locally?')) return;
    DB.deleteTournament(id);
    renderTournamentsAdmin();
    showToast('Tournament deleted', 'success');
}

function renderPlayersAdmin() {
    const container = document.getElementById('admin-players-list');
    if (!container) return;
    const q = (document.getElementById('admin-player-search')?.value || '').toLowerCase();
    let players = DB.getPlayers();
    if (q) players = players.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.playerId || '').toLowerCase().includes(q));
    container.innerHTML =
        players.length === 0
            ? '<p style="opacity:0.6;padding:20px">No players.</p>'
            : players
                  .map(
                      (p) => `
                <div class="admin-card" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
                    <div><strong>${escapeHTML(p.name)}</strong> <span style="opacity:0.5">${p.playerId}</span></div>
                    <div style="display:flex;gap:8px">
                        <button class="btn btn-ghost btn-sm" onclick="openEditPlayer('${p.playerId}')">Edit</button>
                        <button class="btn btn-red btn-sm" onclick="deletePlayerAdmin('${p.playerId}')">Delete</button>
                    </div>
                </div>`
                  )
                  .join('');
}

function openAddPlayer() {
    showModal('modal-add-player');
}

function encodePlayerImage(input, targetId) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById(targetId).value = e.target.result;
        const prev = document.getElementById(targetId === 'add-player-photo' ? 'add-player-preview' : 'edit-player-preview');
        if (prev) {
            prev.src = e.target.result;
            prev.style.display = 'block';
        }
    };
    reader.readAsDataURL(file);
}

function saveNewPlayer() {
    const name = document.getElementById('add-player-name')?.value.trim();
    if (!name) return showToast('Name required', 'error');
    const photo = document.getElementById('add-player-photo')?.value || '';
    DB.addPlayer({ name, role: document.getElementById('add-player-role')?.value || 'Player', photo });
    closeModal('modal-add-player');
    renderPlayersAdmin();
    showToast('Player registered locally', 'success');
}

function openEditPlayer(playerId) {
    const p = DB.getPlayerById(playerId);
    if (!p) return;
    document.getElementById('edit-player-id').value = playerId;
    document.getElementById('edit-player-name').value = p.name || '';
    document.getElementById('edit-player-role').value = p.role || 'batsman';
    showModal('modal-edit-player');
}

function savePlayerEditAdmin() {
    const id = document.getElementById('edit-player-id')?.value;
    const p = DB.getPlayerById(id);
    if (!p) return;
    p.name = document.getElementById('edit-player-name')?.value.trim() || p.name;
    p.role = document.getElementById('edit-player-role')?.value || p.role;
    const photo = document.getElementById('edit-player-photo')?.value;
    if (photo) p.photo = photo;
    DB.updatePlayer(p);
    closeModal('modal-edit-player');
    renderPlayersAdmin();
    showToast('Player updated', 'success');
}

function deletePlayerAdmin(playerId) {
    if (!confirm('Delete player from local database?')) return;
    const arr = DB.getPlayers().filter((p) => p.playerId !== playerId);
    DB.savePlayers(arr);
    localStorage.removeItem('cricpro_photo_' + playerId);
    renderPlayersAdmin();
}

function reSyncAllStats() {
    const tourns = DB.getTournaments();
    let n = 0;
    tourns.forEach((t) => {
        if (typeof computeTournamentStandings === 'function') {
            computeTournamentStandings(t);
            n++;
        }
    });
    showToast(
        n ? `Recalculated standings for ${n} tournament(s) from saved matches` : 'No tournaments to recalculate',
        'default'
    );
}

function renderStoreItems() {
    const ordersEl = document.getElementById('admin-orders-list');
    if (ordersEl) {
        const orders = DB.getOrders();
        ordersEl.innerHTML =
            orders.length === 0
                ? '<p style="opacity:0.6">No orders yet.</p>'
                : orders.map((o) => `<div class="admin-card" style="margin-bottom:8px">${escapeHTML(o.productName || o.id)} — ${o.status || 'pending'}</div>`).join('');
    }
    const container = document.getElementById('store-list');
    if (!container) return;
    const products = DB.getProducts();
    container.innerHTML =
        products.length === 0
            ? '<p style="opacity:0.6;padding:20px">No products.</p>'
            : products
                  .map(
                      (p) => `
            <div class="card" style="padding:16px">
                <div style="font-size:32px">${p.emoji || '🏏'}</div>
                <h4>${escapeHTML(p.name)}</h4>
                <p>Rs. ${p.price} · Stock: ${p.stock ?? 0}</p>
                <button class="btn btn-ghost btn-sm" onclick="openEditProduct('${p.id}')">Edit</button>
                <button class="btn btn-red btn-sm" onclick="deleteProductAdmin('${p.id}')">Delete</button>
            </div>`
                  )
                  .join('');
}

function openAddProduct() {
    showModal('modal-add-product');
}

function encodeProductImage(input, targetId) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById(targetId).value = e.target.result;
    };
    reader.readAsDataURL(file);
}

function saveNewProduct() {
    const name = document.getElementById('add-prod-name')?.value.trim();
    if (!name) return showToast('Product name required', 'error');
    const prod = {
        id: 'PROD-' + Date.now(),
        name,
        price: parseFloat(document.getElementById('add-prod-price')?.value) || 0,
        stock: parseInt(document.getElementById('add-prod-stock')?.value) || 0,
        category: document.getElementById('add-prod-category')?.value || 'misc',
        emoji: document.getElementById('add-prod-emoji')?.value || '🏏',
        image: document.getElementById('add-prod-img')?.value || '',
        description: document.getElementById('add-prod-desc')?.value || '',
    };
    const arr = DB.getProducts();
    arr.push(prod);
    DB.saveProducts(arr);
    closeModal('modal-add-product');
    renderStoreItems();
    showToast('Product added locally', 'success');
}

function openEditProduct(id) {
    const p = DB.getProducts().find((x) => x.id === id);
    if (!p) return;
    document.getElementById('edit-prod-id').value = id;
    document.getElementById('edit-prod-name').value = p.name || '';
    document.getElementById('edit-prod-price').value = p.price || 0;
    document.getElementById('edit-prod-stock').value = p.stock || 0;
    document.getElementById('edit-prod-img').value = p.image || '';
    showModal('modal-edit-product');
}

function saveProductEdit() {
    const id = document.getElementById('edit-prod-id')?.value;
    const arr = DB.getProducts();
    const idx = arr.findIndex((p) => p.id === id);
    if (idx === -1) return;
    arr[idx] = {
        ...arr[idx],
        name: document.getElementById('edit-prod-name')?.value.trim(),
        price: parseFloat(document.getElementById('edit-prod-price')?.value) || 0,
        stock: parseInt(document.getElementById('edit-prod-stock')?.value) || 0,
        image: document.getElementById('edit-prod-img')?.value || arr[idx].image,
    };
    DB.saveProducts(arr);
    closeModal('modal-edit-product');
    renderStoreItems();
    showToast('Product saved', 'success');
}

function deleteProductAdmin(id) {
    if (!confirm('Delete product?')) return;
    DB.saveProducts(DB.getProducts().filter((p) => p.id !== id));
    renderStoreItems();
}

function renderPostsAdmin() {
    const container = document.getElementById('admin-posts-list');
    if (!container) return;
    const posts = DB.getPosts();
    container.innerHTML =
        posts.length === 0
            ? '<p style="opacity:0.6;padding:20px">No posts.</p>'
            : posts
                  .map(
                      (p) => `
            <div class="admin-card" style="margin-bottom:8px">
                <strong>${escapeHTML(p.title || 'Post')}</strong>
                <p style="opacity:0.7">${escapeHTML((p.content || '').slice(0, 120))}</p>
                <button class="btn btn-red btn-sm" onclick="deletePostAdmin('${p.id}')">Delete</button>
            </div>`
                  )
                  .join('');
}

function openAdminCreatePost() {
    document.getElementById('admin-post-title').value = '';
    document.getElementById('admin-post-content').value = '';
    showModal('modal-admin-post');
}

function encodePostImage(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('admin-post-image-data').value = e.target.result;
        const img = document.getElementById('admin-post-preview');
        if (img) {
            img.src = e.target.result;
            img.style.display = 'block';
        }
    };
    reader.readAsDataURL(file);
}

function submitAdminPost() {
    const title = document.getElementById('admin-post-title')?.value.trim();
    const content = document.getElementById('admin-post-content')?.value.trim();
    if (!title || !content) return showToast('Title and content required', 'error');
    DB.addPost({
        id: 'POST-' + Date.now(),
        title,
        content,
        image: document.getElementById('admin-post-image-data')?.value || '',
        author: 'Admin',
        status: 'published',
        createdAt: Date.now(),
    });
    closeModal('modal-admin-post');
    renderPostsAdmin();
    showToast('Post published locally', 'success');
}

function deletePostAdmin(id) {
    DB.savePosts(DB.getPosts().filter((p) => p.id !== id));
    renderPostsAdmin();
}

function renderFeedbackAdmin() {
    const container = document.getElementById('admin-feedback-list');
    if (!container) return;
    const local = JSON.parse(localStorage.getItem('cricpro_local_feedback') || '[]');
    container.innerHTML =
        local.length === 0
            ? '<p style="opacity:0.6;padding:20px">No offline feedback saved.</p>'
            : local
                  .map((f) => `<div class="admin-card" style="margin-bottom:8px"><p>${escapeHTML(f.message)}</p><small>${timeSince(f.createdAt)}</small></div>`)
                  .join('');
}
