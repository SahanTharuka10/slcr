const RENDER = (process.env.RENDER_API_URL || 'https://slcrickpro.onrender.com').replace(/\/$/, '');

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  return buf.length ? buf : undefined;
}

async function proxyToRender(req, res, apiPath) {
  const qs = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = `${RENDER}${apiPath}${qs}`;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'connection') continue;
    headers[k] = v;
  }
  const body = await readBody(req);
  const upstream = await fetch(target, { method: req.method, headers, body });
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.send(buf);
  return upstream.status;
}

module.exports = { proxyToRender, RENDER };
