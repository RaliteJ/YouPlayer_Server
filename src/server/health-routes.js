import { promises as fs, constants } from 'node:fs';

export function registerHealthRoutes(app, { checkDependencies, securityHeaders = (_req, _res, next) => next() }) {
	app.get('/health/live', securityHeaders, (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
	app.get('/health/ready', securityHeaders, async (_req, res) => {
		try {
			await checkDependencies();
			res.set('Cache-Control', 'no-store').json({ status: 'ok' });
		} catch {
			res.set('Cache-Control', 'no-store').status(503).json({ status: 'unavailable' });
		}
	});
}

export async function checkWritableDirectories(directories) {
	await Promise.all(directories.map(directory => fs.access(directory, constants.R_OK | constants.W_OK)));
}
