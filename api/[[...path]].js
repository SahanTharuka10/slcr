/**
 * Vercel: proxy /api/* → Render (no DATABASE_URL needed on Vercel).
 */
const RENDER = (process.env.RENDER_API_URL || 'https://slcrickpro.onrender.com').replace(/\/$/, '');

module.exports = async (req, res) => {
  const segments = req.query.path;
  const pathPart = Array.isArray(segments) ? segments.join('/') : segments || '';
  const qs = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = `${RENDER}/api/${pathPart}${qs}`;

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;

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
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({
      error: 'Render API unreachable',
      message: e.message,
      hint: 'Deploy Render with: node server.js — see RENDER-START.md',
    });
  }
};
