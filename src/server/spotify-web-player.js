import { rememberSpotifyAnonymousToken, cachedSpotifyAnonymousToken } from './spotify-anonymous-token.js';
export { getSpotifyAnonymousToken, clearSpotifyAnonymousToken, cachedSpotifyAnonymousToken } from './spotify-anonymous-token.js';
import puppeteer from 'puppeteer';
import { createHash } from 'node:crypto';
import { logger } from './logger.js';

const SPOTIFY_SANDBOX_PROFILE_DIR = process.env.YOUPLAYER_SPOTIFY_SANDBOX_PROFILE_DIR || "/tmp/youplayer-spotify-web-profile";
let spotifyWebLoginDisabledUntil = 0;
const BROWSER_DISABLED_MESSAGE = "Les diagnostics Spotify par navigateur sont desactives sur cette installation.";

function spotifyBrowserEnabled() {
	return process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED !== 'false';
}

function requireSpotifyBrowser() {
	if (!spotifyBrowserEnabled()) throw new Error(BROWSER_DISABLED_MESSAGE);
}

function spotifyWebCredentials({ force = false } = {}) {
	if (!force && Date.now() < spotifyWebLoginDisabledUntil) {
		return null;
	}
	const username = String(process.env.YOUPLAYER_SPOTIFY_WEB_USERNAME || "").trim();
	const password = String(process.env.YOUPLAYER_SPOTIFY_WEB_PASSWORD || "");
	return username && password ? { username, password } : null;
}

function pauseSpotifyWebLoginAttempts() {
	spotifyWebLoginDisabledUntil = Date.now() + 5 * 60 * 1000;
}

export function browserLaunchOptions({ headless = true, persistentProfile = false } = {}) {
	return {
		headless,
		userDataDir: persistentProfile ? SPOTIFY_SANDBOX_PROFILE_DIR : undefined
	};
}

function summarizeBearerToken(token = "") {
	const value = String(token || "").replace(/^Bearer\s+/i, "").trim();
	return {
		captured: Boolean(value),
		length: value.length,
		sha256: value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : ""
	};
}

function isWantedPathfinderData(json, dataKey) {
	const data = json?.data?.[dataKey];
	if (!data) {
		return false;
	}
	if (dataKey === "playlistV2") {
		return Boolean(data.name || data.content);
	}
	return true;
}

function getSpotifyTokenSourceUrl(source = "search") {
	const value = String(source || "search").trim();
	if (value.startsWith("https://open.spotify.com/")) {
		return value;
	}
	if (value === "search") {
		return "https://open.spotify.com/search";
	}
	if (value.includes("/")) {
		return `https://open.spotify.com/${value.replace(/^\/+/, "")}`;
	}
	return `https://open.spotify.com/playlist/${value}`;
}

async function loginSpotifyWebPlayer(page, options = {}) {
	const credentials = spotifyWebCredentials(options);
	if (!credentials) {
		return false;
	}

	logger.debug("Connexion Spotify WebPlayer avant capture du token");
	await page.goto("https://accounts.spotify.com/login", {
		waitUntil: "domcontentloaded",
		timeout: 45000
	});

	await page.click("#onetrust-accept-btn-handler").catch(() => {});

	const usernameSelector = "#login-username, #username, input[autocomplete='username'], input[name='username'], input[type='email'], input[type='text']";
	const passwordSelector = "#login-password, #password, input[autocomplete='current-password'], input[name='password'], input[type='password']";
	await page.waitForSelector(usernameSelector, { timeout: 20000 });
	await page.click(usernameSelector, { clickCount: 3 });
	await page.type(usernameSelector, credentials.username, { delay: 15 });

	if (!await page.$(passwordSelector)) {
		await Promise.race([
			Promise.allSettled([
				page.click("#login-button, button[data-testid='login-button'], button[type='submit']"),
				page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 })
			]),
			new Promise((resolve) => setTimeout(resolve, 10000))
		]);
	}

	await page.waitForSelector(passwordSelector, { timeout: 15000 });
	await page.click(passwordSelector, { clickCount: 3 });
	await page.type(passwordSelector, credentials.password, { delay: 15 });

	await Promise.race([
		Promise.allSettled([
			page.click("#login-button, button[data-testid='login-button'], button[type='submit']"),
			page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
		]),
		new Promise((resolve) => setTimeout(resolve, 15000))
	]);

	return true;
}

export function spotifyLoginSandboxStatus() {
	return {
		browserEnabled: spotifyBrowserEnabled(),
		disabledReason: spotifyBrowserEnabled() ? "" : BROWSER_DISABLED_MESSAGE,
		credentialsConfigured: Boolean(spotifyWebCredentials({ force: true })),
		headlessLoginPaused: Date.now() < spotifyWebLoginDisabledUntil,
		displayAvailable: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
		executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "",
		persistentProfileDir: SPOTIFY_SANDBOX_PROFILE_DIR,
		anonymousTokenCached: Boolean(cachedSpotifyAnonymousToken())
	};
}

export async function runSpotifyLoginSandboxProbe({
	mode = "anonymous",
	source = "search",
	timeoutMs = 45000
} = {}) {
	const startedAt = Date.now();
	const safeMode = String(mode || "anonymous");
	const safeSource = String(source || "search").trim() || "search";
	const safeTimeout = Math.min(180000, Math.max(5000, Number(timeoutMs) || 45000));

	const modes = new Set(["anonymous", "credentials-headless", "persistent-headless", "manual-visible"]);
	if (!modes.has(safeMode)) {
		throw new Error("Mode de sandbox Spotify inconnu");
	}

	const manualVisible = safeMode === "manual-visible";
	const persistentProfile = safeMode === "persistent-headless" || manualVisible;
	let browser = null;

	try {
		requireSpotifyBrowser();
		browser = await puppeteer.launch(browserLaunchOptions({
			headless: manualVisible ? false : true,
			persistentProfile
		}));
		const page = await browser.newPage();
		await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');

		if (safeMode === "credentials-headless") {
			await loginSpotifyWebPlayer(page, { force: true });
		}

		let settled = false;
		let bearerToken = "";
		const tokenPromise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error("Token WebPlayer non capture dans le delai."));
				}
			}, safeTimeout);

			page.on("request", (request) => {
				const rawToken = request.headers()?.authorization;
				if (!rawToken || !rawToken.includes("Bearer") || settled) return;
				bearerToken = rawToken.replace(/^Bearer\s+/i, "").trim();
				if (safeMode === 'anonymous') rememberSpotifyAnonymousToken(bearerToken);
				settled = true;
				clearTimeout(timer);
				resolve(bearerToken);
			});
		});

		await page.goto(getSpotifyTokenSourceUrl(safeSource), {
			waitUntil: "domcontentloaded",
			timeout: Math.min(45000, safeTimeout)
		}).catch((err) => {
			if (!settled) {
				logger.warn("Navigation sandbox Spotify partielle:", err.message);
			}
		});

		await tokenPromise;
		return {
			ok: true,
			mode: safeMode,
			source: safeSource,
			durationMs: Date.now() - startedAt,
			token: summarizeBearerToken(bearerToken),
			finalUrl: page.url(),
			manualVisible,
			persistentProfile
		};
	} catch (err) {
		return {
			ok: false,
			mode: safeMode,
			source: safeSource,
			durationMs: Date.now() - startedAt,
			error: err.message,
			manualVisible,
			persistentProfile
		};
	} finally {
		await browser?.close().catch(() => {});
	}
}

export async function captureSpotifyPathfinderJson(source, dataKey, timeoutMs = 12000) {
	requireSpotifyBrowser();
	const startedAt = Date.now();
	logger.debug("Capture Spotify Pathfinder demarree", { dataKey, timeoutMs });
	const browser = await puppeteer.launch(browserLaunchOptions());

	try {
		const page = await browser.newPage();
		await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');

		page.on('request', (request) => {
			const rawToken = request.headers()?.authorization;
			if (rawToken && rawToken.includes('Bearer')) {
				rememberSpotifyAnonymousToken(rawToken);
			}
		});

		let settled = false;
		let responseCount = 0;
		const observedDataKeys = new Set();
		const captured = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					logger.debug("Capture Spotify Pathfinder expiree", {
						dataKey,
						durationMs: Date.now() - startedAt,
						responseCount,
						observedDataKeys: [...observedDataKeys]
					});
					reject(new Error(`JSON Spotify ${dataKey} introuvable`));
				}
			}, timeoutMs);

			page.on('response', async (response) => {
				if (settled || !response.url().includes('api-partner.spotify.com/pathfinder')) {
					return;
				}
				try {
					const json = await response.json();
					responseCount += 1;
					const dataKeys = Object.keys(json?.data || {});
					for (const key of dataKeys) observedDataKeys.add(key);
					if (isWantedPathfinderData(json, dataKey)) {
						settled = true;
						clearTimeout(timer);
						logger.debug("Capture Spotify Pathfinder terminee", {
							dataKey,
							durationMs: Date.now() - startedAt,
							responseCount,
							dataKeys
						});
						resolve(json);
					} else {
						logger.debug("Reponse Spotify Pathfinder ignoree", {
							wantedDataKey: dataKey,
							dataKeys
						});
					}
				} catch {
					// Certaines réponses CORS/preflight n'exposent pas de body.
				}
			});
		});

		page.goto(getSpotifyTokenSourceUrl(source), { waitUntil: 'domcontentloaded', timeout: 45000 })
			.catch((err) => {
				if (!settled) {
					logger.warn("Navigation Spotify partielle:", err.message);
				}
			});

		return await captured;
	} finally {
		await browser.close().catch(() => {});
	}
}
