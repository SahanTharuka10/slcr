/**
 * Vercel: proxy /api/* → Render API (render-api.js). No database on Vercel.
 */
const RENDER = (process.env.RENDER_API_URL || 'https://slcrickpro.onrender.com').replace(/\/$/, '');

function targetPath(req) {
  const url = String(req.url || '');
  // Normal case: req.url is the original request ("/api/matches?x=1")
  if (/^\/api(\/|$|\?)/.test(url) && !url.includes('[[...path]]')) return url;
  // Fallback: rebuild from the catch-all segments
  const seg = req.query && req.query.path;
  const pathPart = Array.isArray(seg) ? seg.join('/') : seg || '';
  const params = new URLSearchParams();
  Object.entries(req.query || {}).forEach(([k, v]) => {
    if (k === 'path') return;
    (Array.isArray(v) ? v : [v]).forEach((x) => params.append(k, x));
  });
  const qs = params.toString();
  return `/api/${pathPart}${qs ? `?${qs}` : ''}`;
}

module.exports = async (req, res) => {
  const target = RENDER + targetPath(req);

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding'];

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'transfer-encoding' || k === 'content-encoding' || k === 'content-length') return;
      res.setHeader(key, value);
    });
    res.setHeader('Cache-Control', 'no-store');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'API unreachable', message: e.message });
  }
};
