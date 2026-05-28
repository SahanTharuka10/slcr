const { RENDER } = require('./lib/render-proxy');

module.exports = async (req, res) => {
  const fallback = () =>
    res.status(200).json({
      app: 'SLCRICKPRO',
      version: '1.0.9',
      entry: 'vercel',
      features: { desktopUsers: true, desktopLogin: true },
    });

  try {
    const upstream = await fetch(`${RENDER}/api/version`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const text = await upstream.text();
    if (upstream.ok) {
      res.status(200);
      res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
      res.send(text);
      return;
    }
    fallback();
  } catch (_) {
    fallback();
  }
};
