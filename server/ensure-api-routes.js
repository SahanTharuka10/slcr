/**
 * Guarantee desktop + version routes exist on the Express app (stale Render deploys).
 */
const BUILD = '1.0.7';

function hasRoute(app, pathSuffix) {
  const stack = app._router?.stack || app.router?.stack || [];
  for (const layer of stack) {
    if (layer.route?.path && String(layer.route.path).includes(pathSuffix)) {
      return true;
    }
  }
  return false;
}

function ensureApiRoutes(app) {
  if (!hasRoute(app, '/api/version')) {
    console.log('[SLCRICKPRO] patch: register /api/version');
    app.get('/api/version', (req, res) => {
      res.json({
        app: 'SLCRICKPRO',
        version: BUILD,
        features: { desktopUsers: true, desktopLogin: true },
        patched: true,
      });
    });
  }

  if (!hasRoute(app, '/api/ping')) {
    app.get('/api/ping', (req, res) => {
      res.json({ status: 'alive', build: BUILD, time: new Date().toISOString(), patched: true });
    });
  }

  console.log('[SLCRICKPRO] API routes ensured (build ' + BUILD + ')');
}

module.exports = { ensureApiRoutes, BUILD };
