import fs from "fs";
import path from "path";

function parseDotEnvValue(value) {
	const trimmed = String(value || "").trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
		|| (trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function loadDotEnvFile(filePath, target = process.env) {
	if (!fs.existsSync(filePath)) {
		return false;
	}

	const content = fs.readFileSync(filePath, "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (target[key] === undefined) {
			target[key] = parseDotEnvValue(rawValue);
		}
	}
	return true;
}

export function loadLocalEnv(target = process.env, cwd = process.cwd()) {
	const candidates = [
		path.resolve(cwd, ".env"),
		path.resolve(cwd, "..", ".env")
	];
	const seen = new Set();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		loadDotEnvFile(candidate, target);
	}
}

function envFlag(env, name, fallback = false) {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function envNumber(env, name, fallback) {
	const value = Number(env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envList(env, name) {
	return String(env[name] || "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function envSpaceList(env, name, fallback = []) {
	const raw = String(env[name] || "").trim();
	if (!raw) return fallback;
	return raw
		.split(/[\s,]+/)
		.map((value) => value.trim())
		.filter(Boolean);
}

function envSecret(env, ...names) {
	for (const name of names) {
		const value = String(env[name] || "").trim();
		if (!value || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) continue;
		return value;
	}
	return "";
}

export function loadServerConfig(env = process.env) {
	const nodeEnv = env.NODE_ENV || "development";
	const isTest = nodeEnv === "test";
	const isProduction = nodeEnv === "production";
	const authEnabled = env.YOUPLAYER_AUTH_ENABLED !== "false";
	const redisUrl = env.YOUPLAYER_REDIS_URL || env.REDIS_URL || "";
	const sessionSecret = env.YOUPLAYER_SESSION_SECRET
		|| env.SESSION_SECRET
		|| (isTest ? "test-session-secret" : "");
	const spotifyClientId = envSecret(env, "YOUPLAYER_SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_ID");
	const spotifyClientSecret = envSecret(env, "YOUPLAYER_SPOTIFY_CLIENT_SECRET", "SPOTIFY_CLIENT_SECRET");
	const spotifyRedirectUri = envSecret(env, "YOUPLAYER_SPOTIFY_REDIRECT_URI", "SPOTIFY_REDIRECT_URI");
	const configuredSpotifyTokenSecret = envSecret(env, "YOUPLAYER_SPOTIFY_TOKEN_SECRET", "SPOTIFY_TOKEN_SECRET");
	const spotifyConfigured = Boolean(spotifyClientId && spotifyClientSecret && spotifyRedirectUri);
	const weakSessionSecret = !sessionSecret
		|| sessionSecret.length < 32
		|| /replace|change|example|local-session|dev-session|^\$\{/i.test(sessionSecret);
	const weakSpotifyTokenSecret = !configuredSpotifyTokenSecret
		|| configuredSpotifyTokenSecret.length < 32
		|| /replace|change|example|^\$\{/i.test(configuredSpotifyTokenSecret);

	if (!isTest && spotifyConfigured && weakSessionSecret) {
		throw new Error("YOUPLAYER_SESSION_SECRET fort est requis lorsque Spotify OAuth est configure");
	}
	if (!isTest && spotifyConfigured && weakSpotifyTokenSecret) {
		throw new Error("YOUPLAYER_SPOTIFY_TOKEN_SECRET fort et dedie est requis lorsque Spotify OAuth est configure");
	}

	if (authEnabled && isProduction) {
		if (weakSessionSecret) {
			throw new Error("YOUPLAYER_SESSION_SECRET doit etre defini avec une valeur forte en production");
		}
		if (!redisUrl) {
			throw new Error("YOUPLAYER_REDIS_URL ou REDIS_URL est requis pour les sessions en production");
		}
	}

	return {
		nodeEnv,
		isTest,
		isProduction,
		authEnabled,
		port: env.PORT || 3000,
		musiqDir: env.YOUPLAYER_MUSIQ_DIR || "/var/www/html/musiq",
		localSongDir: env.YOUPLAYER_LOCAL_SONG_DIR || "/var/www/html/local_song",
		redisUrl,
		sessionSecret: sessionSecret || "dev-session-secret-change-before-prod",
		sessionMaxAgeMs: envNumber(env, "YOUPLAYER_SESSION_MAX_AGE_MS", 3 * 24 * 60 * 60 * 1000),
		sessionCookieSecure: envFlag(env, "YOUPLAYER_COOKIE_SECURE", false),
		trustProxy: envFlag(env, "YOUPLAYER_TRUST_PROXY", false),
		requireOriginForWrites: envFlag(env, "YOUPLAYER_REQUIRE_ORIGIN", isProduction),
		corsOrigins: envList(env, "YOUPLAYER_CORS_ORIGINS"),
		youtubeApiKey: envSecret(env, "YOUPLAYER_YOUTUBE_API_KEY", "YOUTUBE_API_KEY"),
		uploadMaxBytes: envNumber(env, "YOUPLAYER_UPLOAD_MAX_BYTES", 50 * 1024 * 1024),
		downloadConcurrency: envNumber(env, "YOUPLAYER_DOWNLOAD_CONCURRENCY", 2),
		firstTrackSpecialStream: envFlag(env, "FIRST_TRACK_SPECIAL_STREAM", true),
		firstTrackSpecialNext: envFlag(env, "FIRST_TRACK_SPECIAL_STREAM_NEXT", true),
		firstTrackStreamStartTimeoutMs: envNumber(env, "FIRST_TRACK_STREAM_START_TIMEOUT_MS", 30_000),
		firstTrackStreamMaxDurationMs: envNumber(env, "FIRST_TRACK_STREAM_MAX_DURATION_MS", 2 * 60 * 60 * 1000),
		spotifyClientId,
		spotifyClientSecret,
		spotifyRedirectUri,
		spotifyScopes: envSpaceList(env, "YOUPLAYER_SPOTIFY_SCOPES", [
			"user-read-private",
			"playlist-read-private",
			"playlist-read-collaborative"
		]),
		spotifyTokenSecret: configuredSpotifyTokenSecret
			|| sessionSecret
			|| "dev-spotify-token-secret-change-before-prod"
	};
}
