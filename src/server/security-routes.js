import { createSecurityControl } from './security-control.js';

export function registerSecurityRoutes(app, { requireAdmin, recordAction, control = createSecurityControl({
  requestsDirectory: process.env.YOUPLAYER_UPDATE_REQUESTS_DIR,
  statusDirectory: process.env.YOUPLAYER_UPDATE_STATUS_DIR
}) }) {
  function authenticatedAdmin(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Authentification requise' });
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acces admin requis' });
    next();
  }
  app.get('/admin/security', requireAdmin, authenticatedAdmin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await control.status());
  });
  for (const action of ['check', 'fix']) app.post(`/admin/security/${action}`, requireAdmin, authenticatedAdmin, async (req, res) => {
    try {
      const job = await control.request(action);
      await recordAction(req, `admin.security.${action}`, 'dependencies', job.id);
      res.status(202).json({ requestId: job.id });
    } catch (error) {
      res.status(error.statusCode || 503).json({ error: 'Controle indisponible ou deja en cours' });
    }
  });
}
