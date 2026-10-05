import {
	createSpotifyAuthorizationUrl,
	createSpotifyOAuthState,
	createSpotifyPkce,
	exchangeSpotifyAuthorizationCode,
	fetchSpotifyCurrentUserProfile,
	spotifyConnectionFromOAuth,
	spotifyOAuthConfigured
} from './spotify-oauth.js';
import { publicUser, requestContext } from './stores/store-utils.js';
import {
	validateOwnPasswordChangePayload,
	validateCreateUserPayload,
	validateAdminPasswordResetPayload
} from './validation.js';
import { createRateLimit } from './rate-limit.js';
import { logger } from './logger.js';
import { createIntegrationStatus } from './integration-status.js';

const SPOTIFY_OAUTH_TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;
const SENSITIVE_AUTH_MAX_AGE_MS = 10 * 60 * 1000;

export function registerAuthRoutes(app, {
	config, store, requireAuth, requireAdmin, firstTrackStreams, recordAction, sendJsonError,
	integrationStatus = createIntegrationStatus({ config })
}) {
	const authEnabled = config.authEnabled;
	const spotifyOAuthEnabled = spotifyOAuthConfigured(config);
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
	}

	function hasRecentAuthentication(req) {
		const authenticatedAt = Number(req.session?.authenticatedAt);
		return Number.isFinite(authenticatedAt)
			&& authenticatedAt > Date.now() - SENSITIVE_AUTH_MAX_AGE_MS;
	}

	app.get("/auth/providers", (_req, res) => {
		res.json({
			authEnabled,
			spotify: {
				enabled: spotifyOAuthEnabled,
				scopes: config.spotifyScopes
			}
		});
	});

	app.get("/auth/spotify/start", requireAuth, async (req, res) => {
		try {
			if (req.session?.role === 'admin') {
				return res.status(403).json({ error: 'Compte reserve a la gestion' });
			}
			if (!spotifyOAuthEnabled) {
				return res.status(503).json({ error: "Connexion Spotify non configuree" });
			}

			const existing = await store.getSpotifyConnection(req.session.userId);
			if (existing && !hasRecentAuthentication(req)) {
				return res.redirect("/?spotify_error=reauth_required&view=parametres");
			}

			const state = createSpotifyOAuthState();
			const pkce = createSpotifyPkce();
			req.session.spotifyOAuth = {
				state,
				codeVerifier: pkce.verifier,
				createdAt: Date.now(),
				userId: String(req.session.userId),
				authenticatedAt: Number(req.session.authenticatedAt) || Date.now()
			};
			await sessionSave(req);
			res.redirect(createSpotifyAuthorizationUrl(config, state, { codeChallenge: pkce.challenge }));
		} catch (err) {
			logger.error("Erreur auth/spotify/start:", err);
			sendJsonError(res, err, "Connexion Spotify impossible", 400);
		}
	});

	app.get("/auth/spotify/callback", async (req, res) => {
		try {
			res.setHeader("Cache-Control", "no-store");
			if (!authEnabled || !spotifyOAuthEnabled) {
				return res.redirect("/?spotify_error=disabled&view=add_spotify");
			}
			const code = String(req.query.code || "");
			const state = String(req.query.state || "");
			const transaction = req.session?.spotifyOAuth;
			const transactionAge = Date.now() - Number(transaction?.createdAt);
			if (!state || !transaction || state !== transaction.state
				|| transaction.userId !== String(req.session?.userId)
				|| !Number.isFinite(transactionAge) || transactionAge < 0
				|| transactionAge > SPOTIFY_OAUTH_TRANSACTION_MAX_AGE_MS) {
				if (transaction && transactionAge > SPOTIFY_OAUTH_TRANSACTION_MAX_AGE_MS) {
					delete req.session.spotifyOAuth;
					await sessionSave(req);
				}
				return res.redirect("/?spotify_error=state&view=add_spotify");
			}
			delete req.session.spotifyOAuth;
			await sessionSave(req);
			if (!code) {
				return res.redirect("/?spotify_error=denied&view=add_spotify");
			}

			const currentUser = await store.findUserById(transaction.userId);
			if (!currentUser || currentUser.role === 'admin') {
				return res.redirect("/?spotify_error=session&view=add_spotify");
			}
			const tokenData = await exchangeSpotifyAuthorizationCode(config, code, {
				codeVerifier: transaction.codeVerifier
			});
			const profile = await fetchSpotifyCurrentUserProfile(tokenData.access_token);

			const finalUser = await store.attachSpotifyConnection(
				currentUser.id,
				spotifyConnectionFromOAuth(tokenData, profile, config)
			);

			await sessionRegenerate(req);
			setSessionUser(req, finalUser, transaction.authenticatedAt);
			await sessionSave(req);
			await recordAction(req, "auth.spotify_connect", "user", finalUser.id, {
				spotifyConnection: "token-only"
			});
			res.redirect("/?spotify_connected=1&view=add_spotify");
		} catch (err) {
			logger.error("Erreur auth/spotify/callback:", err);
			res.redirect("/?spotify_error=callback&view=add_spotify");
		}
	});

	app.post("/auth/spotify/disconnect", requireAuth, async (req, res) => {
		try {
			if (!authEnabled || !req.session?.userId) {
				return res.status(400).json({ error: "Connexion Spotify indisponible" });
			}
			if (!hasRecentAuthentication(req)) {
				return res.status(403).json({ error: "Reconnecte-toi a YouPlayer avant de delier Spotify" });
			}
			const user = await store.removeSpotifyConnection(req.session.userId);
			await recordAction(req, "auth.spotify_disconnect", "user", user.id);
			res.json({ user });
		} catch (err) {
			logger.error("Erreur auth/spotify/disconnect:", err);
			sendJsonError(res, err, "Deconnexion Spotify impossible", 400);
		}
	});

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

	function requireIntegrationAdmin(req, res, next) {
		if (!req.session?.userId || req.session.role !== 'admin') {
			return res.status(403).json({ error: 'Acces admin requis' });
		}
		next();
	}
	const integrationRateLimit = createRateLimit({ windowMs: 60_000, max: 4, message: 'Attends avant de verifier a nouveau les connexions' });
	app.get('/admin/integrations', requireAdmin, requireIntegrationAdmin, (_req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		res.json(integrationStatus.snapshot());
	});
	app.post('/admin/integrations/check', requireAdmin, requireIntegrationAdmin, integrationRateLimit, async (_req, res) => {
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

}
