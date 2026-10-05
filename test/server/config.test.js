import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnvFile, loadLocalEnv, loadServerConfig } from '../../src/server/config.js';

test('loadServerConfig allows tests without production secrets', () => {
	const config = loadServerConfig({ NODE_ENV: 'test' });

	assert.equal(config.isTest, true);
	assert.equal(config.authEnabled, true);
	assert.equal(config.sessionSecret, 'test-session-secret');
	assert.equal(config.sessionMaxAgeMs, 3 * 24 * 60 * 60 * 1000);
	assert.equal(config.firstTrackSpecialStream, true);
	assert.equal(config.firstTrackSpecialNext, true);
	assert.equal(config.spotifyScopes.includes('user-read-email'), false);
	assert.equal(config.spotifyScopes.includes('user-read-private'), true);
});

test('loadServerConfig accepts a custom session duration', () => {
	const config = loadServerConfig({
		NODE_ENV: 'test',
		YOUPLAYER_SESSION_MAX_AGE_MS: '172800000'
	});

	assert.equal(config.sessionMaxAgeMs, 2 * 24 * 60 * 60 * 1000);
});

test('loadServerConfig can disable the isolated first-track layer and its Next behavior', () => {
	const config = loadServerConfig({
		NODE_ENV: 'test',
		FIRST_TRACK_SPECIAL_STREAM: 'false',
		FIRST_TRACK_SPECIAL_STREAM_NEXT: 'false'
	});

	assert.equal(config.firstTrackSpecialStream, false);
	assert.equal(config.firstTrackSpecialNext, false);
});

test('loadServerConfig rejects missing production session secret', () => {
	assert.throws(() => loadServerConfig({
		NODE_ENV: 'production',
		YOUPLAYER_AUTH_ENABLED: 'true',
		YOUPLAYER_REDIS_URL: 'redis://localhost:6379'
	}), /SESSION_SECRET/);
});

test('loadServerConfig rejects the documented placeholder secret in production', () => {
	assert.throws(() => loadServerConfig({
		NODE_ENV: 'production',
		YOUPLAYER_AUTH_ENABLED: 'true',
		YOUPLAYER_SESSION_SECRET: 'replace-with-a-long-random-session-secret',
		YOUPLAYER_REDIS_URL: 'redis://redis:6379'
	}), /SESSION_SECRET/);
});

test('loadServerConfig rejects production auth without Redis sessions', () => {
	assert.throws(() => loadServerConfig({
		NODE_ENV: 'production',
		YOUPLAYER_AUTH_ENABLED: 'true',
		YOUPLAYER_SESSION_SECRET: 'synthetic-production-session-secret-1234567890'
	}), /REDIS_URL/);
});

test('loadServerConfig requires a strong dedicated Spotify token secret', () => {
	assert.throws(() => loadServerConfig({
		NODE_ENV: 'production',
		YOUPLAYER_AUTH_ENABLED: 'true',
		YOUPLAYER_SESSION_SECRET: 'a-real-production-session-secret-value',
		YOUPLAYER_REDIS_URL: 'redis://localhost:6379',
		YOUPLAYER_SPOTIFY_CLIENT_ID: 'client-id',
		YOUPLAYER_SPOTIFY_CLIENT_SECRET: 'client-secret',
		YOUPLAYER_SPOTIFY_REDIRECT_URI: 'https://youplayer.example/auth/spotify/callback'
	}), /YOUPLAYER_SPOTIFY_TOKEN_SECRET/);
	assert.throws(() => loadServerConfig({
		NODE_ENV: 'production',
		YOUPLAYER_AUTH_ENABLED: 'true',
		YOUPLAYER_SESSION_SECRET: 'a-real-production-session-secret-value',
		YOUPLAYER_REDIS_URL: 'redis://localhost:6379',
		YOUPLAYER_SPOTIFY_CLIENT_ID: 'client-id',
		YOUPLAYER_SPOTIFY_CLIENT_SECRET: 'client-secret',
		YOUPLAYER_SPOTIFY_REDIRECT_URI: 'https://youplayer.example/auth/spotify/callback',
		YOUPLAYER_SPOTIFY_TOKEN_SECRET: 'replace-with-a-secret-that-is-long-enough'
	}), /YOUPLAYER_SPOTIFY_TOKEN_SECRET/);
});

test('loadServerConfig requires a strong session secret whenever Spotify OAuth is configured', () => {
	assert.throws(() => loadServerConfig({
		NODE_ENV: 'development',
		YOUPLAYER_SESSION_SECRET: 'local-session-secret-change-me',
		YOUPLAYER_SPOTIFY_CLIENT_ID: 'client-id',
		YOUPLAYER_SPOTIFY_CLIENT_SECRET: 'client-secret',
		YOUPLAYER_SPOTIFY_REDIRECT_URI: 'https://youplayer.example/auth/spotify/callback',
		YOUPLAYER_SPOTIFY_TOKEN_SECRET: 'a-strong-dedicated-token-secret-value'
	}), /YOUPLAYER_SESSION_SECRET/);
});

test('loadServerConfig parses operational limits from env', () => {
	const config = loadServerConfig({
		NODE_ENV: 'development',
		YOUPLAYER_SESSION_SECRET: 'dev-secret',
		YOUPLAYER_UPLOAD_MAX_BYTES: '1234',
		YOUPLAYER_DOWNLOAD_CONCURRENCY: '4',
		YOUPLAYER_CORS_ORIGINS: 'https://one.example, https://two.example'
	});

	assert.equal(config.uploadMaxBytes, 1234);
	assert.equal(config.downloadConcurrency, 4);
	assert.deepEqual(config.corsOrigins, ['https://one.example', 'https://two.example']);
});

test('loadServerConfig ignores unresolved compose placeholders', () => {
	const config = loadServerConfig({
		NODE_ENV: 'development',
		YOUPLAYER_SESSION_SECRET: 'dev-secret',
		YOUPLAYER_YOUTUBE_API_KEY: '${YOUPLAYER_YOUTUBE_API_KEY}',
		YOUPLAYER_SPOTIFY_CLIENT_ID: '${YOUPLAYER_SPOTIFY_CLIENT_ID}',
		YOUPLAYER_SPOTIFY_CLIENT_SECRET: '${YOUPLAYER_SPOTIFY_CLIENT_SECRET}',
		YOUPLAYER_SPOTIFY_REDIRECT_URI: 'https://127.0.0.1:8443/auth/spotify/callback'
	});

	assert.equal(config.youtubeApiKey, '');
	assert.equal(config.spotifyClientId, '');
	assert.equal(config.spotifyClientSecret, '');
	assert.equal(config.spotifyRedirectUri, 'https://127.0.0.1:8443/auth/spotify/callback');
});

test('loadServerConfig requires trusted origins for production writes by default', () => {
	const production = loadServerConfig({
		NODE_ENV: 'production',
		YOUPLAYER_SESSION_SECRET: 'synthetic-production-session-secret-1234567890',
		YOUPLAYER_REDIS_URL: 'redis://localhost:6379'
	});
	const development = loadServerConfig({
		NODE_ENV: 'development',
		YOUPLAYER_SESSION_SECRET: 'dev-secret'
	});
	const explicit = loadServerConfig({
		NODE_ENV: 'development',
		YOUPLAYER_SESSION_SECRET: 'dev-secret',
		YOUPLAYER_REQUIRE_ORIGIN: 'true'
	});

	assert.equal(production.requireOriginForWrites, true);
	assert.equal(development.requireOriginForWrites, false);
	assert.equal(explicit.requireOriginForWrites, true);
});

test('loadDotEnvFile loads missing keys without overriding existing env values', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'youplayer-env-'));
	try {
		const envFile = path.join(dir, '.env');
		const target = {
			YOUPLAYER_SESSION_SECRET: 'already-set'
		};
		await writeFile(envFile, [
			'YOUPLAYER_SESSION_SECRET=from-file',
			'YOUPLAYER_YOUTUBE_API_KEY="from-env-file"',
			'# ignored comment'
		].join('\n'), 'utf8');

		assert.equal(loadDotEnvFile(envFile, target), true);
		assert.equal(target.YOUPLAYER_SESSION_SECRET, 'already-set');
		assert.equal(target.YOUPLAYER_YOUTUBE_API_KEY, 'from-env-file');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('loadLocalEnv reads .env from the supplied working directory', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'youplayer-local-env-'));
	try {
		const target = {};
		await writeFile(path.join(dir, '.env'), 'YOUPLAYER_YOUTUBE_API_KEY=local-key\n', 'utf8');
		loadLocalEnv(target, dir);
		assert.equal(target.YOUPLAYER_YOUTUBE_API_KEY, 'local-key');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
