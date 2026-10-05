import { registerPlaybackRoutes } from './playback-routes.js';
import { registerYoutubeRoutes } from './youtube-routes.js';
import { registerHealthRoutes, checkWritableDirectories } from './health-routes.js';
import { registerSpotifyRoutes } from './spotify-routes.js';
import { createPlaylistAccess } from './playlist-access.js';
import { registerPlaylistRoutes } from './playlist-routes.js';
import { registerImportRoutes } from './import-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerUpdateRoutes } from './update-routes.js';
import { createSpotifyCatalog } from './spotify-catalog.js';
import { createHttpSecurity } from './http-security.js';
import { nativeSessionQueue } from './native-transitions.js';
import express from "express";
import cors from "cors";
import fs from 'fs';
import { promises as fs_promises } from 'fs';
import session from 'express-session';
import { RedisStore } from "connect-redis";
import { createClient as createRedisClient } from "redis";
import { resolveYoutubeStreamSource } from './download.js';
import { createFirstTrackStreamManager } from './first-track-streams.js';
import { PLAYLISTS_DIR } from './playlist-files.js';
import { createYouplayerStore, seedTestStore } from './youplayer-store.js';
import { loadLocalEnv, loadServerConfig } from './config.js';
import { logger } from './logger.js';
import { RequestValidationError } from './validation.js';
import multer from "multer"
import path from "path";

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);
if (process.env.NODE_ENV !== "test") {
	loadLocalEnv();
}
const config = loadServerConfig();
const MUSIQ_DIR = config.musiqDir;
const LOCAL_SONG_DIR = config.localSongDir;
const inactivityTimers = new Map();
const LOCAL_AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".ogg", ".oga", ".flac", ".aac", ".webm"]);
const upload = multer({
	dest: LOCAL_SONG_DIR,
	limits: { fileSize: config.uploadMaxBytes },
	fileFilter(_req, file, cb) {
		const extension = path.extname(file.originalname || "").toLowerCase();
		const mimeType = String(file.mimetype || "").toLowerCase();
		const acceptedMimeType = mimeType.startsWith("audio/") || mimeType === "video/webm";
		if (LOCAL_AUDIO_EXTENSIONS.has(extension) && acceptedMimeType) {
			cb(null, true);
			return;
		}
		cb(new RequestValidationError("Format audio non supporte"));
	}
});

const app = express();
const PORT = config.port;
const AUTH_ENABLED = config.authEnabled;
const SESSION_SECRET = config.sessionSecret;
const firstTrackStreams = createFirstTrackStreamManager({
	resolveSource: resolveYoutubeStreamSource,
	logger,
	startTimeoutMs: config.firstTrackStreamStartTimeoutMs,
	maxDurationMs: config.firstTrackStreamMaxDurationMs
});
app.locals.firstTrackStreams = firstTrackStreams;


export { app };

if (config.trustProxy) {
	app.set("trust proxy", 1);
}

fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
fs.mkdirSync(MUSIQ_DIR, { recursive: true });
fs.mkdirSync(LOCAL_SONG_DIR, { recursive: true });

const youplayerStore = await createYouplayerStore();
app.locals.youplayerStore = youplayerStore;

if (process.env.NODE_ENV === "test" || process.env.YOUPLAYER_SEED_TEST_USERS === "true") {
	await seedTestStore(youplayerStore, PLAYLISTS_DIR);
}

const MIGRATE_PLAYLISTS_TO_PSEUDO = process.env.YOUPLAYER_MIGRATE_PLAYLISTS_TO_PSEUDO
	|| process.env.YOUPLAYER_MIGRATE_PLAYLISTS_TO_EMAIL;

if (AUTH_ENABLED && MIGRATE_PLAYLISTS_TO_PSEUDO) {
	const migrationUser = await youplayerStore.findUserByPseudo(MIGRATE_PLAYLISTS_TO_PSEUDO);
	if (migrationUser) {
		await youplayerStore.importPlaylistsFromDirectory(migrationUser.id, PLAYLISTS_DIR);
	}
}

const API_KEY = config.youtubeApiKey;
const spotifyCatalog = createSpotifyCatalog({ config, store: youplayerStore });

async function createSessionStore() {
	if (!config.redisUrl || config.isTest) {
		return undefined;
	}

	const redisClient = createRedisClient({ url: config.redisUrl });
	redisClient.on("error", (err) => {
		logger.error("Erreur Redis session:", err.message);
	});
	await redisClient.connect();
	app.locals.redisClient = redisClient;
	return new RedisStore({
		client: redisClient,
		prefix: "youplayer:sess:",
		ttl: Math.ceil(config.sessionMaxAgeMs / 1000)
	});
}

const { corsOrigin, requireTrustedOrigin, securityHeaders } = createHttpSecurity(config);

const sessionStore = await createSessionStore();

registerHealthRoutes(app, { securityHeaders, checkDependencies: async () => {
	await checkWritableDirectories([MUSIQ_DIR, LOCAL_SONG_DIR, PLAYLISTS_DIR,
		...(youplayerStore.filePath ? [path.dirname(youplayerStore.filePath)] : [])]);
	if (youplayerStore.pool) await youplayerStore.query('SELECT 1');
	if (app.locals.redisClient) {
		if (!app.locals.redisClient.isReady) throw new Error('Not ready');
		let timer;
		try {
			await Promise.race([app.locals.redisClient.ping(), new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('Not ready')), 2_000);
			})]);
		} finally { clearTimeout(timer); }
	}
} });

app.use(session({
	secret: SESSION_SECRET,
	store: sessionStore,
	resave: false,
	saveUninitialized: false,
	rolling: true,
	cookie: {
		httpOnly: true,
		secure: config.sessionCookieSecure,
		sameSite: "lax",
		maxAge: config.sessionMaxAgeMs
	}
}));

app.use(cors({
	    origin: corsOrigin,
	    credentials: true
	}));
app.use(securityHeaders);
app.use(requireTrustedOrigin);

function cleanupSessionAfterInactivity(sessionId, sessionStore) {
	const oldTimer = inactivityTimers.get(sessionId);
	if (oldTimer) {
		clearTimeout(oldTimer);
	}

	const timer = setTimeout(async () => {
		inactivityTimers.delete(sessionId);
		firstTrackStreams.stopForSession(sessionId, "session_inactive");
		await fs_promises.rm(path.join(MUSIQ_DIR, sessionId), { recursive: true, force: true });
		sessionStore.destroy(sessionId, (err) => {
			if (err) {
				logger.error("Erreur suppression session inactive:", err);
				return;
			}
			logger.info("Session inactive supprimée:", sessionId);
		});
	}, config.sessionMaxAgeMs);

	inactivityTimers.set(sessionId, timer);
}

app.use((req, res, next) => {
	if (process.env.NODE_ENV !== "test" && req.sessionID && req.sessionStore) {
		cleanupSessionAfterInactivity(req.sessionID, req.sessionStore);
	}
	next();
});


// Large Spotify collections are accepted only on the authenticated queue route.
const defaultJsonParser = express.json();
const queueJsonParser = express.json({ limit: '5mb' });
app.use((req, res, next) => {
	if (req.path === '/add_song_ecoute' && req.method === 'POST') {
		return requireAuth(req, res, () => queueJsonParser(req, res, next));
	}
	return defaultJsonParser(req, res, next);
});
app.use(nativeSessionQueue());

const STATIC_FILE_ALLOWLIST = new Map([
	["/", "index.html"],
	["/index.html", "index.html"],
	["/app.js", "app.js"],
	["/audio-crossfade.js", "audio-crossfade.js"],
	["/android-player.js", "android-player.js"],
	["/client-utils.js", "client-utils.js"],
	["/library-tools.js", "library-tools.js"],
	["/audio-diagnostics.js", "audio-diagnostics.js"],
	["/track-gestures.js", "track-gestures.js"],
	["/library-view.js", "library-view.js"],
	["/playlist-view.js", "playlist-view.js"],
	["/discovery-view.js", "discovery-view.js"],
	["/player-controller.js", "player-controller.js"],
	["/player-view.js", "player-view.js"],
	["/account-view.js", "account-view.js"],
	["/spotify-browser-bridge.js", "spotify-browser-bridge.js"],
	["/spotify-explorer.js", "spotify-explorer.js"],
	["/style.css", "style.css"],
	["/manifest.webmanifest", "manifest.webmanifest"],
	["/icons/icon-192.png", "icons/icon-192.png"],
	["/icons/icon-512.png", "icons/icon-512.png"]
]);

app.get(Array.from(STATIC_FILE_ALLOWLIST.keys()), (req, res) => {
	res.sendFile(path.join(ROOT_DIR, STATIC_FILE_ALLOWLIST.get(req.path)));
});
function sendJsonError(res, err, fallbackMessage = "Erreur serveur", fallbackStatus = 500) {
	const status = Number.isInteger(err?.statusCode) ? err.statusCode : fallbackStatus;
	res.status(status).json({ error: err?.message || fallbackMessage });
}

function uploadLocalAudio(req, res, next) {
	upload.single("file")(req, res, (err) => {
		if (!err) {
			return next();
		}
		if (err instanceof multer.MulterError) {
			const message = err.code === "LIMIT_FILE_SIZE"
				? "Fichier audio trop volumineux"
				: err.message;
			return res.status(400).json({ error: message });
		}
		return sendJsonError(res, err, "Upload impossible", 400);
	});
}

function requireAuth(req, res, next) {
	if (!AUTH_ENABLED || req.session?.userId) {
		return next();
	}
	return res.status(401).json({ error: "Authentification requise" });
}

function requireAdmin(req, res, next) {
	if (!AUTH_ENABLED) {
		return next();
	}
	if (!req.session?.userId) {
		return res.status(401).json({ error: "Authentification requise" });
	}
	if (req.session.role !== "admin") {
		return res.status(403).json({ error: "Acces admin requis" });
	}
	return next();
}

function requireListener(req, res, next) {
	return requireAuth(req, res, () => {
		if (req.session?.role === 'admin') {
			return res.status(403).json({ error: 'Compte reserve a la gestion' });
		}
		next();
	});
}

async function recordAction(req, action, resourceType = "", resourceId = "", details = {}) {
	if (!AUTH_ENABLED || !req.session?.userId) return;
	try {
		await youplayerStore.recordAuditLog({
			userId: req.session.userId,
			action,
			resourceType,
			resourceId,
			details
		});
	} catch (err) {
		logger.error("Erreur journal action:", err);
	}
}

const playlistAccess = createPlaylistAccess({ authEnabled: AUTH_ENABLED, store: youplayerStore });
const { validateSessionTrack, removeSongFromSessionQueue } = registerPlaybackRoutes(app, {
	config, firstTrackStreams, playlistAccess, requireAuth: requireListener, recordAction, sendJsonError
});
registerYoutubeRoutes(app, { requireAuth: requireListener, sendJsonError, youtubeApiKey: API_KEY });
registerPlaylistRoutes(app, {
	authEnabled: AUTH_ENABLED, store: youplayerStore, localSongDir: LOCAL_SONG_DIR,
	requireAuth: requireListener, uploadLocalAudio, playlistAccess, validateSessionTrack,
	removeSongFromSessionQueue, recordAction, sendJsonError
});
registerImportRoutes(app, {
	requireAuth: requireListener, appendPlaylistItemsForRequest: playlistAccess.appendPlaylistItemsForRequest,
	recordAction, sendJsonError, youtubeApiKey: API_KEY
});

registerSpotifyRoutes(app, { catalog: spotifyCatalog, requireAuth: requireListener, sendJsonError });

registerAuthRoutes(app, {
	config, store: youplayerStore, requireAuth, requireAdmin,
	firstTrackStreams, recordAction, sendJsonError
});
registerUpdateRoutes(app, { requireAdmin, recordAction });

app.post("/spotify_add_song", requireAuth, (_req, res) => {
	res.status(410).json({
		error: "Route remplacee: utilisez /spotify_test pour lire les metadonnees puis /update_playlist"
	});
});

app.post("/run-script", requireAuth, (_req, res) => {
	res.status(410).json({
		error: "Route remplacee par la file de lecture"
	});
});


const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
	const server = app.listen(PORT, () => {
		logger.info("Server running on port " + PORT);
	});
	const shutdown = (signal) => {
		firstTrackStreams.stopAll(`server_${signal.toLowerCase()}`);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 2_000).unref();
	};
	process.once("SIGTERM", () => shutdown("SIGTERM"));
	process.once("SIGINT", () => shutdown("SIGINT"));
}
