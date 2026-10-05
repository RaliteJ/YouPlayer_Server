import { createUpdateControl } from './update-control.js';

export function registerUpdateRoutes(app, { requireAdmin, recordAction, control = createUpdateControl({
	requestsDirectory: process.env.YOUPLAYER_UPDATE_REQUESTS_DIR,
	statusDirectory: process.env.YOUPLAYER_UPDATE_STATUS_DIR
}) }) {
	function authenticatedAdmin(req, res, next) {
		// Updating must remain authenticated even when local auth is disabled.
		if (!req.session?.userId) return res.status(401).json({ error: 'Authentification requise' });
		if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acces admin requis' });
		return next();
	}
	app.get('/admin/updates', requireAdmin, authenticatedAdmin, async (_req, res) => {
		res.set('Cache-Control', 'no-store');
		res.json(await control.status());
	});
	for (const action of ['check', 'install']) {
		app.post(`/admin/updates/${action}`, requireAdmin, authenticatedAdmin, async (req, res) => {
			try {
				// No client-controlled URL, command, filesystem path or image reference.
				const job = await control.request(action, req.body?.version);
				await recordAction(req, `admin.update.${action}`, 'release', job.id);
				res.status(202).json({ requestId: job.id });
			} catch (error) {
				res.status(error.statusCode || 503).json({ error: 'Mise a jour indisponible ou deja en cours' });
			}
		});
	}
}
