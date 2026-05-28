const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fileStore = require('./file-store');

/** First non-internal IPv4 (prefer private LAN ranges for OBS Browser Source). */
function getPrimaryLanIPv4() {
  const nets = os.networkInterfaces() || {};
  const rows = [];
  for (const [name, ifaces] of Object.entries(nets)) {
    for (const iface of ifaces || []) {
      if (iface.family !== 'IPv4' || iface.internal || !iface.address) continue;
      rows.push({ name: String(name || ''), address: iface.address });
    }
  }
  if (!rows.length) return null;

  const isPrivate = (ip) =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
  const isLikelyVirtualName = (n) =>
    /(virtual|vbox|vmware|hyper-v|wsl|docker|loopback|npcap|bluetooth|tailscale|zerotier|hamachi|wireguard|vpn)/i.test(
      n
    );
  const isPreferredPhysicalName = (n) => /(wi-?fi|wlan|wireless|ethernet|lan)/i.test(n);
  const isBadVirtualIp = (ip) => ip === '10.0.2.2' || ip === '10.4.2.2';

  const preferred = rows.find(
    (r) =>
      isPrivate(r.address) &&
      !isBadVirtualIp(r.address) &&
      !isLikelyVirtualName(r.name) &&
      isPreferredPhysicalName(r.name)
  );
  if (preferred) return preferred.address;

  const privateReal = rows.find(
    (r) => isPrivate(r.address) && !isBadVirtualIp(r.address) && !isLikelyVirtualName(r.name)
  );
  if (privateReal) return privateReal.address;

  const privateAny = rows.find((r) => isPrivate(r.address) && !isBadVirtualIp(r.address));
  if (privateAny) return privateAny.address;

  const anyReal = rows.find((r) => !isLikelyVirtualName(r.name));
  return anyReal?.address || rows[0].address || null;
}

/** Desktop offline CSP (no unsafe-eval — clears Electron dev warning) */
const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.socket.io",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* https://slcrickpro.onrender.com https://slcrickpro.live https://cdn.socket.io wss://slcrickpro.onrender.com wss: ws:",
  "frame-src 'self' http://127.0.0.1:* http://localhost:* https://slcrickpro.live https://www.slcrickpro.live",
  "object-src 'none'",
].join('; ');

const CSS_ALIASES = {
  '/css/style.css': 'css/main.css',
  '/css/home.css': 'css/main.css',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function buildCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-scoring-token',
  };
}

function createPortCandidates(options = {}) {
  const preferredRaw = Number(options.port ?? process.env.SLCRICK_LOCAL_PORT ?? 3000);
  const preferred = Number.isFinite(preferredRaw) && preferredRaw > 0 ? preferredRaw : 3000;
  const candidates = [preferred];
  for (let p = 3001; p <= 3010; p++) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  return candidates;
}

function listenWithFallback(server, host, ports, idx = 0) {
  return new Promise((resolve, reject) => {
    if (idx >= ports.length) {
      reject(new Error(`No available port in [${ports.join(', ')}] on ${host}`));
      return;
    }
    const port = ports[idx];
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        listenWithFallback(server, host, ports, idx + 1).then(resolve).catch(reject);
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

function mergeOverlayMedia(target, source) {
  if (!target || !source) return target;
  if (source.teamPhotos && typeof source.teamPhotos === 'object') {
    target.teamPhotos = { ...(target.teamPhotos || {}), ...source.teamPhotos };
  }
  if (source.broadcastLivePhotos && typeof source.broadcastLivePhotos === 'object') {
    target.broadcastLivePhotos = {
      ...(target.broadcastLivePhotos || {}),
      ...source.broadcastLivePhotos,
    };
  }
  return target;
}

function pickFresherMatch(a, b) {
  if (!a?.id) return b || null;
  if (!b?.id) return a;
  const aTs = a.lastUpdated || a.scoringStartedAt || 0;
  const bTs = b.lastUpdated || b.scoringStartedAt || 0;
  const winner = aTs >= bTs ? a : b;
  const other = winner === a ? b : a;
  return mergeOverlayMedia({ ...winner }, other);
}

function startLocalServer(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const getDataRoot = options.getDataRoot || (() => null);
  const getCachedMatch = options.getCachedMatch || (() => null);
  const getCachedMatches = options.getCachedMatches || (() => []);
  const sseClients = new Set();
  let sseSeq = 0;

  function sseWrite(client, event, payload) {
    if (!client || !client.res || client.closed) return;
    try {
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
    } catch (_) {
      client.closed = true;
    }
  }

  function sseBroadcast(event, payload) {
    const dead = [];
    sseClients.forEach((c) => {
      if (c.closed) {
        dead.push(c);
        return;
      }
      if (c.matchId && payload?.match?.id && c.matchId !== payload.match.id) return;
      if (c.tournamentId && payload?.match?.tournamentId && c.tournamentId !== payload.match.tournamentId)
        return;
      sseWrite(c, event, payload);
    });
    dead.forEach((d) => sseClients.delete(d));
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...buildCorsHeaders(),
    });
    res.end(JSON.stringify(obj));
  }

  return new Promise((resolve, reject) => {
    const heartbeatTimer = setInterval(() => {
      sseBroadcast('heartbeat', {
        ts: Date.now(),
        clients: sseClients.size,
        seq: ++sseSeq,
      });
    }, 5000);

    const server = http.createServer((req, res) => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            ...buildCorsHeaders(),
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        let urlPath = decodeURIComponent(parsed.pathname);

        if (urlPath === '/api/stream') {
          const client = {
            res,
            closed: false,
            matchId: parsed.searchParams.get('matchId') || parsed.searchParams.get('match') || '',
            tournamentId:
              parsed.searchParams.get('tournamentId') || parsed.searchParams.get('tournament') || '',
          };
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Connection: 'keep-alive',
            ...buildCorsHeaders(),
          });
          res.write('retry: 1500\n\n');
          sseWrite(client, 'ready', { ok: true, ts: Date.now() });
          sseClients.add(client);
          req.on('close', () => {
            client.closed = true;
            sseClients.delete(client);
          });
          return;
        }

        const dataRoot = getDataRoot();
        if (dataRoot && urlPath.startsWith('/api/match/')) {
          const id = decodeURIComponent(urlPath.slice('/api/match/'.length));
          const cached = getCachedMatch(id);
          const fromDisk = fileStore.loadEntity(dataRoot, 'match', id);
          const match = pickFresherMatch(cached, fromDisk);
          sendJson(res, 200, match || null);
          return;
        }
        if (dataRoot && urlPath === '/api/live-match') {
          const cached = Array.isArray(getCachedMatches()) ? getCachedMatches() : [];
          const { matches } = fileStore.loadAll(dataRoot);
          const mergedMap = new Map();
          [...matches, ...cached].forEach((m) => {
            if (m?.id) mergedMap.set(m.id, pickFresherMatch(mergedMap.get(m.id), m));
          });
          const merged = Array.from(mergedMap.values());
          const tid = parsed.searchParams.get('tournament') || parsed.searchParams.get('tournamentId');
          const pool = tid
            ? merged.filter((m) => m && m.tournamentId === tid)
            : merged;
          const livePool = pool
            .filter((m) => m && (m.status === 'live' || m.status === 'paused'))
            .sort(
              (a, b) =>
                (b.lastUpdated || b.scoringStartedAt || 0) - (a.lastUpdated || a.scoringStartedAt || 0)
            );
          const live = livePool[0] || null;
          sendJson(res, 200, live);
          return;
        }
        if (dataRoot && urlPath === '/api/live-matches') {
          const { matches } = fileStore.loadAll(dataRoot);
          const tid = parsed.searchParams.get('tournament') || parsed.searchParams.get('tournamentId');
          const pool = tid
            ? matches.filter((m) => m && m.tournamentId === tid)
            : matches;
          const live = pool
            .filter((m) => m && (m.status === 'live' || m.status === 'paused'))
            .sort(
              (a, b) =>
                (b.lastUpdated || b.scoringStartedAt || 0) - (a.lastUpdated || a.scoringStartedAt || 0)
            );
          sendJson(res, 200, live);
          return;
        }
        if (urlPath === '/api/broadcast') {
          const getLast = options.getLastBroadcast || (() => null);
          sendJson(res, 200, getLast() || null);
          return;
        }

        if (urlPath === '/') urlPath = '/index.html';

        let rel = urlPath.replace(/^\//, '');
        if (CSS_ALIASES[urlPath]) rel = CSS_ALIASES[urlPath];

        const filePath = path.normalize(path.join(root, rel));
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        let target = filePath;
        if (fs.statSync(target).isDirectory()) {
          target = path.join(target, 'index.html');
        }
        if (!fs.existsSync(target)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const ext = path.extname(target).toLowerCase();
        const headers = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          ...buildCorsHeaders(),
        };
        if (ext === '.html') {
          headers['Content-Security-Policy'] = DESKTOP_CSP;
        }
        res.writeHead(200, headers);
        fs.createReadStream(target).pipe(res);
      } catch (err) {
        console.error('[SLCRICKPRO] Static server error:', err);
        res.writeHead(500);
        res.end('Server error');
      }
    });

    const host = '0.0.0.0';
    const portCandidates = createPortCandidates(options);
    listenWithFallback(server, host, portCandidates)
      .then((port) => {
      const lanIp = getPrimaryLanIPv4();
      resolve({
        server,
        port,
        host,
        lanIp,
        baseUrl: `http://127.0.0.1:${port}`,
        lanBaseUrl: lanIp ? `http://${lanIp}:${port}` : null,
        publishMatch: (match) =>
          sseBroadcast('match', { match, ts: Date.now(), seq: ++sseSeq }),
        publishBroadcast: (payload) =>
          sseBroadcast('broadcast', { payload, ts: Date.now(), seq: ++sseSeq }),
        close: () =>
          new Promise((res) => {
            clearInterval(heartbeatTimer);
            server.close(() => res());
          }),
      });
      })
      .catch(reject);
  });
}

module.exports = { startLocalServer };
