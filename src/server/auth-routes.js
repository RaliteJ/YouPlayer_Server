import { publicUser, requestContext } from './stores/store-utils.js';
import {
	validateOwnPasswordChangePayload,
	validateCreateUserPayload,
	validateAdminPasswordResetPayload
} from './validation.js';
import { createRateLimit } from './rate-limit.js';
import { logger } from './logger.js';
import { createIntegrationStatus } from './integration-status.js';


export function registerAuthRoutes(app, {
	config, store, requireAuth, requireAdmin, firstTrackStreams, recordAction, sendJsonError,
	integrationStatus = createIntegrationStatus({ config })
}) {
	const authEnabled = config.authEnabled;
	const loginRateLimit = createRateLimit({
		windowMs: 10 * 60 * 1000,
		max: 20,
		message: "Trop de tentatives de connexion"
	});

	function sessionRegenerate(req) {
		return new Promise((resolve, reject) => {
			req.session.regenerate((err) => err ? reject(err) : resolve());
		});
	}

	function sessionSave(req) {
		return new Promise((resolve, reject) => {
			req.session.save((err) => err ? reject(err) : resolve());
		});
	}

	function sessionDestroy(req) {
		return new Promise((resolve, reject) => {
			req.session.destroy((err) => err ? reject(err) : resolve());
		});
	}

	function setSessionUser(req, user, authenticatedAt = Date.now()) {
		req.session.userId = user.id;
		req.session.role = user.role;
		req.session.pseudo = user.pseudo;
		req.session.authenticatedAt = authenticatedAt;
		req.session.authVersion = user.authVersion ?? 0;
	}

	app.get("/auth/providers", (_req, res) => {
		res.json({ authEnabled, spotify: { enabled: false, scopes: [] } });
	});

	function refuseSpotifyOAuth(req, res) {
		res.status(req.session?.role === "admin" ? 403 : 410).json({ error: "Connexion Spotify serveur supprimée : utilise le Bridge local" });
	}
	app.get("/auth/spotify/start", requireAuth, refuseSpotifyOAuth);
	app.get("/auth/spotify/callback", refuseSpotifyOAuth);
	app.post("/auth/spotify/disconnect", requireAuth, refuseSpotifyOAuth);

	app.post("/auth/login", loginRateLimit, async (req, res) => {
		try {
			const { password } = req.body || {};
			const pseudo = req.body?.pseudo || req.body?.email;
			const context = requestContext(req);
			const user = await store.authenticate(pseudo, password);
			await store.recordLoginEvent({
				userId: user?.id || null,
				pseudo,
				success: Boolean(user),
				...context
			});

			if (!user) {
				return res.status(401).json({ error: "Identifiants invalides" });
			}

			await sessionRegenerate(req);
			setSessionUser(req, user);
			await sessionSave(req);
			await recordAction(req, "auth.login", "user", user.id);

			res.json({ user });
		} catch (err) {
			logger.error("Erreur auth/login:", err);
			sendJsonError(res, err, "Connexion impossible", 400);
		}
	});

	app.post("/auth/logout", requireAuth, async (req, res) => {
		try {
			const userId = req.session.userId;
			firstTrackStreams.stopForSession(req.sessionID, "logout");
			await recordAction(req, "auth.logout", "user", userId);
			await sessionDestroy(req);
			res.clearCookie("connect.sid");
			res.json({ message: "Deconnecte" });
		} catch (err) {
			logger.error("Erreur auth/logout:", err);
			res.status(500).json({ error: "Deconnexion impossible" });
		}
	});

	app.get("/auth/me", requireAuth, async (req, res) => {
		try {
			if (!authEnabled) {
				return res.json({ user: null, authEnabled: false });
			}
			const user = await store.findUserById(req.session.userId);
			if (!user) {
				firstTrackStreams.stopForSession(req.sessionID, "invalid_session");
				await sessionDestroy(req).catch(() => {});
				return res.status(401).json({ error: "Session invalide" });
			}
			res.json({ user: publicUser(user), authEnabled: true });
		} catch (err) {
			logger.error("Erreur auth/me:", err);
			res.status(500).json({ error: "Session impossible a charger" });
		}
	});

	app.post("/auth/password", requireAuth, async (req, res) => {
		try {
			if (!authEnabled || !req.session?.userId) {
				return res.status(400).json({ error: "Changement de mot de passe indisponible" });
			}

			const { currentPassword, newPassword } = validateOwnPasswordChangePayload(req.body || {});
			const user = await store.changePassword(req.session.userId, currentPassword, newPassword);
			req.session.authenticatedAt = Date.now();
			req.session.authVersion = user.authVersion;
			await sessionSave(req);
			await recordAction(req, "auth.password_change", "user", user.id);
			res.json({ user });
		} catch (err) {
			logger.error("Erreur auth/password:", err);
			sendJsonError(res, err, "Mot de passe impossible a modifier", 400);
		}
	});

	app.get("/admin/users", requireAdmin, async (_req, res) => {
		res.json(await store.listUsers());
	});

	function requireAdminSession(req, res, next) {
		if (!req.session?.userId || req.session.role !== 'admin') {
			return res.status(403).json({ error: 'Acces admin requis' });
		}
		next();
	}
	const integrationRateLimit = createRateLimit({ windowMs: 60_000, max: 4, message: 'Attends avant de verifier a nouveau les connexions' });
	app.get('/admin/integrations', requireAdmin, requireAdminSession, (_req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		res.json(integrationStatus.snapshot());
	});
	app.post('/admin/integrations/check', requireAdmin, requireAdminSession, integrationRateLimit, async (_req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		try { res.json(await integrationStatus.check()); }
		catch { res.status(503).json({ error: 'Verification des connexions indisponible' }); }
	});

	app.post("/admin/users", requireAdmin, async (req, res) => {
		try {
			const user = await store.createUser(validateCreateUserPayload(req.body || {}));
			await recordAction(req, "admin.user.create", "user", user.id, {
				pseudo: user.pseudo,
				role: user.role
			});
			res.status(201).json({ user });
		} catch (err) {
			sendJsonError(res, err, "Utilisateur impossible a creer", 400);
		}
	});

	app.post("/admin/users/:userId/password", requireAdmin, async (req, res) => {
		try {
			const { newPassword } = validateAdminPasswordResetPayload(req.body || {});
			const user = await store.setUserPassword(req.params.userId, newPassword);
			await recordAction(req, "admin.user.password_reset", "user", user.id, {
				pseudo: user.pseudo
			});
			res.json({ user });
		} catch (err) {
			sendJsonError(res, err, "Mot de passe impossible a modifier", 400);
		}
	});

	app.get("/admin/login_events", requireAdmin, async (_req, res) => {
		res.json(await store.listLoginEvents({ limit: 200 }));
	});

	app.get("/admin/audit_logs", requireAdmin, async (_req, res) => {
		res.json(await store.listAuditLogs({ limit: 200 }));
	});

	app.get('/admin/unplayable_tracks', requireAdmin, requireAdminSession, async (req, res) => {
		const offset = Number(req.query.offset || 0);
		if (!Number.isSafeInteger(offset) || offset < 0) {
			return res.status(400).json({ error: 'Pagination invalide' });
		}
		const logs = await store.listAuditLogs({ action: 'playback.unplayable', limit: 51, offset });
		res.set('Cache-Control', 'no-store').json({ items: logs.slice(0, 50), hasMore: logs.length > 50 });
	});

}
