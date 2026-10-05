import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(new URL('../src/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer'));

let app;
let server;
let browser;
let baseUrl;
let tempRoot;
let browserSetupError;
const browserExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

async function closeServer() {
	if (!server?.listening) return;
	await new Promise((resolve) => server.close(resolve));
}

before(async () => {
	try {
		process.env.NODE_ENV = 'test';
		process.env.PUPPETEER_EXECUTABLE_PATH = browserExecutablePath;
		tempRoot = await mkdtemp(path.join(os.tmpdir(), 'youplayer-browser-'));
		process.env.YOUPLAYER_MUSIQ_DIR = path.join(tempRoot, 'musiq');
		process.env.YOUPLAYER_LOCAL_SONG_DIR = path.join(tempRoot, 'local_song');
		delete process.env.YOUPLAYER_YOUTUBE_API_KEY;
		delete process.env.YOUTUBE_API_KEY;

		({ app } = await import('../src/server/server.js'));
		server = app.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const { port } = server.address();
		baseUrl = `http://127.0.0.1:${port}`;
		browser = await puppeteer.launch({
			executablePath: browserExecutablePath,
			headless: true,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-gpu',
				'--no-zygote',
				'--autoplay-policy=no-user-gesture-required'
			]
		});
	} catch (err) {
		browserSetupError = err;
		await browser?.close().catch(() => {});
		await closeServer();
		if (process.env.CI === 'true') throw err;
	}
});

after(async () => {
	await browser?.close();
	await closeServer();
	if (tempRoot) {
		await rm(tempRoot, { recursive: true, force: true });
	}
	delete process.env.YOUPLAYER_MUSIQ_DIR;
	delete process.env.YOUPLAYER_LOCAL_SONG_DIR;
	delete process.env.YOUPLAYER_YOUTUBE_API_KEY;
	delete process.env.YOUTUBE_API_KEY;
});

test('library shortcuts preserve filtered selection, pins and mobile layout; sleep timer blocks late playback', { timeout: 30000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const page = await browser.newPage();
	try {
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
			else request.abort();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			App.currentUser = { id: 'synthetic-browser', role: 'user' };
			App.showApp();
			window.libraryFixture = { pinned: [], recent: [] };
			window.librarySelections = [];
			window.libraryStarts = 0;
			App.apiFetch = async (endpoint, method, body) => {
				if (endpoint === '/playlist_summaries') return [
					{ name: 'ete.json', title: 'Été calme', count: 3 },
					{ name: 'rock.json', title: 'Rock avec un nom volontairement très long pour les petits écrans', count: 5 },
					{ name: 'vide.json', title: 'Vide', count: 0 }
				];
				if (endpoint === '/playlist_preferences') {
					const p = window.libraryFixture;
					if (method === 'POST') {
						if (body.action === 'clear_recent') p.recent = [];
						if (body.action === 'visit') p.recent = [body.playlist, ...p.recent.filter((name) => name !== body.playlist)].slice(0, 12);
						if (body.action === 'pin') p.pinned = body.enabled ? [body.playlist, ...p.pinned.filter((name) => name !== body.playlist)] : p.pinned.filter((name) => name !== body.playlist);
					}
					return structuredClone(p);
				}
				if (endpoint === '/playlist_used') { window.librarySelections.push(body.arg); return 'OK'; }
				throw new Error(`Unexpected local request: ${endpoint}`);
			};
			App.fetchPlaylist = async () => { window.libraryStarts++; };
			App.nextSong = async () => { window.libraryStarts++; };
			App.prefetchUpcomingTrack = async () => {};
			await App.fetchAvailablePlaylists();
		});
		await page.click('.library-pin[data-playlist="rock.json"]');
		await page.waitForFunction(() => document.querySelector('.library-pin[data-playlist="rock.json"]').getAttribute('aria-pressed') === 'true');
		assert.equal(await page.$eval('#playlists-container li', (element) => element.dataset.playlist), 'rock.json');
		await page.click('input[value="rock.json"]');
		await page.type('#library-search', 'ete');
		assert.equal(await page.$$eval('#playlists-container li', (elements) => elements.length), 1);
		await page.click('input[value="ete.json"]');
		await page.click('#playlist-selection-form button[type="submit"]');
		await page.waitForFunction(() => window.librarySelections.length === 1 && window.fixtureApp.libraryPreferences.recent.length === 2);
		assert.deepEqual(await page.evaluate(() => window.librarySelections[0]), ['rock.json', 'ete.json']);
		await page.evaluate(() => { document.getElementById('library-search').value = ''; window.fixtureApp.renderLibrary(); });
		for (const width of [320, 390, 1280]) {
			await page.setViewport({ width, height: 844 });
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}px`);
			assert.ok(await page.$$eval('.library-row-actions button', (buttons) => buttons.every((button) => {
				const rect = button.getBoundingClientRect();
				return rect.left >= 0 && rect.right <= innerWidth + 1;
			})), `playlist actions fit at ${width}px`);
		}
		await page.click('#library-clear-recent');
		await page.waitForFunction(() => document.getElementById('library-recent-section').hidden);
		await page.click('.library-play[data-playlist="ete.json"]');
		await page.waitForFunction(() => window.libraryStarts === 1);
		assert.deepEqual(await page.evaluate(() => window.librarySelections.at(-1)), ['ete.json']);
		await page.evaluate(async () => {
			const App = window.fixtureApp;
			const bytes = new Uint8Array(44 + 16000);
			const view = new DataView(bytes.buffer);
			const text = (offset, value) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
			text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ');
			view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
			view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
			view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 16000, true);
			App.lecteur.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
			App.lecteur.loop = true;
			await App.lecteur.play();
			App.sleepTimer.set(15);
			App.sleepTimer.deadline = Date.now() - 1;
			App.sleepTimer.check();
		});
		assert.equal(await page.evaluate(() => window.fixtureApp.lecteur.paused), true);
		await page.evaluate(() => window.fixtureApp.playAudioWithDiagnostics(window.fixtureApp.lecteur, { trigger: 'network-next-track' }));
		assert.equal(await page.evaluate(() => window.fixtureApp.lecteur.paused), true, 'late transition remains paused');
		await page.evaluate(() => window.fixtureApp.playAudioWithDiagnostics(window.fixtureApp.lecteur, { trigger: 'play-pause-control' }));
		assert.equal(await page.evaluate(() => window.fixtureApp.lecteur.paused), false, 'explicit playback can resume');
		await page.evaluate(() => window.fixtureApp.showAuth());
		assert.equal(await page.$$eval('.library-pin', (buttons) => buttons.length), 0, 'old account data is removed');
	} finally {
		await page.close();
	}
});

test('expanded player synchronizes shuffle and repeats audio until disabled', { timeout: 20000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const page = await browser.newPage();
	try {
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			document.body.classList.remove('auth-required');
			document.querySelector('.auth-screen').hidden = true;
			App.prefetchUpcomingTrack = () => {};
			App.apiFetch = async (path, method, body) => {
				if (path !== '/random') throw new Error('Unexpected request');
				window.shuffleRequest = { method, enabled: body.enabled };
				return window.shuffleFailure ? null : { currentId: 0, queue: [], random: body.enabled };
			};
			App.updatePlaybackUi({ currentId: 0, current: { title: 'Test audio' }, queue: [], random: false });
			window.nextCalls = 0;
			App.nextSong = async () => { window.nextCalls++; };
		});
		await page.click('#miniPlayerOpen');
		for (const width of [320, 390, 1280]) {
			await page.setViewport({ width, height: 844 });
			assert.equal(await page.evaluate(() => {
				const overlay = document.getElementById('now-playing-overlay');
				return overlay.scrollWidth <= overlay.clientWidth && ['overlayShuffle', 'reloadBtn', 'queueToggleBtn'].every(id => {
					const rect = document.getElementById(id).getBoundingClientRect();
					return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
				});
			}), true, `Controls fit at ${width}px`);
		}
		await page.click('#overlayShuffle');
		assert.deepEqual(await page.evaluate(() => ({
			request: window.shuffleRequest,
			checked: document.getElementById('shuffle-mode').checked,
			pressed: document.getElementById('overlayShuffle').getAttribute('aria-pressed')
		})), { request: { method: 'POST', enabled: true }, checked: true, pressed: 'true' });
		await page.evaluate(() => { window.shuffleFailure = true; });
		await page.click('#overlayShuffle');
		assert.equal(await page.$eval('#overlayShuffle', el => el.getAttribute('aria-pressed')), 'true');
		await page.click('#reloadBtn');
		await page.evaluate(() => {
			// Short synthetic WAV, no project media or external service.
			const data = new Uint8Array(44 + 8000);
			const view = new DataView(data.buffer);
			const text = (offset, value) => [...value].forEach((c, i) => { data[offset + i] = c.charCodeAt(0); });
			text(0, 'RIFF'); view.setUint32(4, data.length - 8, true); text(8, 'WAVEfmt ');
			view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
			view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
			view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 8000, true);
			const audio = window.fixtureApp.lecteur;
			window.loops = 0;
			audio.addEventListener('seeked', () => { window.loops++; });
			audio.src = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
			return audio.play();
		});
		await page.waitForFunction(() => window.loops >= 2, { timeout: 5000 });
		assert.equal(await page.evaluate(() => window.nextCalls), 0);
		assert.equal(await page.$eval('#reloadBtn', el => el.getAttribute('aria-pressed')), 'true');
		await page.click('#reloadBtn');
		await page.waitForFunction(() => window.nextCalls === 1, { timeout: 5000 });
		assert.equal(await page.$eval('#reloadBtn', el => el.getAttribute('aria-pressed')), 'false');
	} finally {
		await page.close();
	}
});

test('right swipe queues a track without playing it and leaves vertical scrolling available', { timeout: 20000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const page = await browser.newPage();
	try {
		await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			document.body.classList.remove('auth-required');
			document.querySelector('.auth-screen').hidden = true;
			document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-playlist'));
			window.queued = []; window.played = [];
			const tracks = Array.from({ length: 20 }, (_, id) => ({ title: `Fixture ${id}`, artist: 'Test', __sessionIndex: id }));
			App.apiFetch = async (path, method, body) => {
				if (path === '/playlist') return tracks;
				if (path === '/add_song_ecoute') {
					window.queued.push(body.arg);
					return { queue: [tracks[body.arg]], random: false };
				}
				return { currentId: 0, current: tracks[0], queue: [], random: false };
			};
			App.prefetchUpcomingTrack = () => {};
			App.add_song_playlist = id => window.played.push(id);
			await App.fetchPlaylist();
		});
		const row = await page.$('.playlist-item');
		const rect = await row.boundingBox();
		const x = rect.x + 30, y = rect.y + rect.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 100, y, { steps: 8 });
		await page.mouse.up();
		await page.waitForFunction(() => window.queued.length === 1 && !window.fixtureApp.queueEditPromise);
		assert.deepEqual(await page.evaluate(() => ({ queued: window.queued, played: window.played, current: Number(window.fixtureApp.currentId) })),
			{ queued: [0], played: [], current: 0 });
		// A short drag and a leftward drag must neither enqueue nor start playback.
		for (const dx of [25, -25]) {
			await page.mouse.move(x + 30, y); await page.mouse.down();
			await page.mouse.move(x + 30 + dx, y, { steps: 4 }); await page.mouse.up();
		}
		assert.deepEqual(await page.evaluate(() => [window.queued.length, window.played.length]), [1, 0]);
		const cdp = await page.createCDPSession();
		await page.evaluate(() => {
			window.touchEvents = [];
			for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
				document.addEventListener(type, e => {
					if (e.pointerType === 'touch') window.touchEvents.push([type, e.clientX, e.clientY, e.button, e.isPrimary, e.target.className]);
				}, true);
			}
		});
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
		for (let dx = 20; dx <= 100; dx += 20) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await page.waitForFunction(() => window.queued.length === 2 && !window.fixtureApp.queueEditPromise, { timeout: 5000 });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y + 150 }] });
		for (let dy = 20; dy <= 120; dy += 20) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 150 - dy }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await page.waitForFunction(() => document.querySelector('.views-container').scrollTop > 0, { timeout: 5000 });
		assert.deepEqual(await page.evaluate(() => [window.queued.length, window.played.length]), [2, 0]);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	} catch (error) {
		t.diagnostic(JSON.stringify(await page.evaluate(() => ({
			queued: window.queued, played: window.played,
			touchEvents: window.touchEvents,
			scroll: document.querySelector('.views-container').scrollTop,
			rows: [...document.querySelectorAll('.queue-swipe-row')].slice(0, 2).map(row => ({
				classes: row.className, top: row.getBoundingClientRect().top, touchAction: getComputedStyle(row).touchAction
			}))
		}))));
		throw error;
	} finally {
		await page.close();
	}
});

test('controlled playback persists per account and plays complete Spotify playlists without importing', { timeout: 20000 }, async () => {
	if (browserSetupError) throw browserSetupError;
	const page = await browser.newPage();
	page.setDefaultTimeout(5000);
	try {
		await page.setRequestInterception(true);
		page.on('request', request => {
			if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
			else request.abort();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.controlledApp = App;
			App.currentUser = { id: 'controlled-fixture-a', role: 'user' };
			App.showApp();
			window.controlledRequests = [];
			window.controlledStarts = [];
			const tracks = Array.from({ length: 121 }, (_, index) => ({
				id: String(index + 1).padStart(22, '0'), name: `Titre ${index + 1}`,
				artists: [{ name: 'Artiste test' }]
			}));
			App.apiFetch = async (endpoint, method, body) => {
				window.controlledRequests.push({ endpoint, body });
				if (endpoint === '/spotify_test') {
					if (body.action === 'playlist') return { data: {
						id: 'playlist123456789', name: 'Playlist test',
						tracks: { items: tracks.slice(0, 50).map(track => ({ track })), total: tracks.length, next: 50 }
					} };
					if (body.action === 'playlist_tracks') {
						const offset = body.offset;
						return { data: { items: tracks.slice(offset, offset + 50).map(track => ({ track })),
							total: tracks.length, next: offset + 50 < tracks.length ? offset + 50 : null } };
					}
				}
				if (endpoint === '/add_song_ecoute') return { currentId: 0, queue: [], random: false };
				return [];
			};
			App.syncPrefetchedTransitions = async () => {};
			App.prefetchUpcomingTrack = () => {};
			App.nextSong = async reason => window.controlledStarts.push(reason);
			document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-add_spotify'));
			document.querySelector('[data-spotify-playlist-url]').value = 'https://open.spotify.com/playlist/playlist123456789';
			document.querySelector('[data-spotify-playlist-open-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		await page.waitForSelector('[data-play-current]:not([disabled])');
		await page.click('[data-play-current]');
		await page.waitForFunction(() => window.controlledStarts.length === 1);
		let requests = await page.evaluate(() => window.controlledRequests);
		const firstPlay = requests.find(request => request.endpoint === '/add_song_ecoute').body;
		assert.equal(firstPlay.collection.length, 121);
		assert.equal(firstPlay.collectionIndex, 0);
		assert.equal(firstPlay.controlled, undefined);
		assert.equal(requests.filter(request => request.endpoint === '/spotify_test').length, 3);
		assert.ok(!requests.some(request => request.endpoint.includes('import')));
		await page.evaluate(() => document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-parametres')));
		await page.click('#controlled-playback');
		assert.equal(await page.evaluate(() => localStorage.getItem('controlledPlayback:controlled-fixture-a')), 'true');
		await page.evaluate(() => { window.controlledApp.currentUser = { id: 'controlled-fixture-b' }; window.controlledApp.renderAuthState(); });
		assert.equal(await page.$eval('#controlled-playback', input => input.checked), false);
		await page.evaluate(() => { window.controlledApp.currentUser = { id: 'controlled-fixture-a' }; window.controlledApp.renderAuthState(); });
		assert.equal(await page.$eval('#controlled-playback', input => input.checked), true);
		for (const width of [320, 390]) {
			await page.setViewport({ width, height: 844 });
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `settings fit at ${width}px`);
		}
		await page.evaluate(() => document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-add_spotify')));
		await page.$eval('.spotify-track-row[data-collection-index="7"]', row => row.click());
		await page.waitForFunction(() => window.controlledStarts.length === 2);
		requests = await page.evaluate(() => window.controlledRequests);
		const selected = requests.filter(request => request.endpoint === '/add_song_ecoute').at(-1).body;
		assert.equal(selected.controlled, true);
		assert.equal(selected.collectionIndex, 7);
		assert.equal(selected.collection.length, 121);
		assert.deepEqual(await page.evaluate(() => window.controlledStarts), ['select', 'select']);
		await page.setViewport({ width: 1280, height: 844 });
		const row = await page.$('.spotify-track-row[data-collection-index="8"]');
		await row.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const bounds = await row.boundingBox();
		await page.mouse.move(bounds.x + 15, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + 115, bounds.y + bounds.height / 2, { steps: 8 });
		await page.mouse.up();
		await page.waitForFunction(() => window.controlledRequests.filter(request => request.endpoint === '/add_song_ecoute').length === 3 && !window.controlledApp.queueEditPromise);
		const queued = await page.evaluate(() => window.controlledRequests.filter(request => request.endpoint === '/add_song_ecoute').at(-1).body);
		assert.equal(queued.controlled, undefined);
		assert.equal(queued.collection, undefined);
		assert.equal(queued.song.title, 'Titre 9');
		assert.equal(await page.evaluate(() => window.controlledStarts.length), 2);
		for (const width of [320, 390, 800, 1280]) {
			await page.setViewport({ width, height: 844 });
			assert.ok(await page.$$eval('.spotify-hero-actions > *', actions => actions.every(action => {
				const rect = action.getBoundingClientRect();
				return rect.left >= 0 && rect.right <= innerWidth + 1;
			})), `Spotify playlist buttons fit at ${width}px`);
		}
	} finally {
		await page.close();
	}
});

test('Spotify playlist scrolling reveals the next 50 tracks on desktop and mobile', { timeout: 20000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const page = await browser.newPage();
	page.setDefaultTimeout(5000);
	try {
		await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
		await page.setRequestInterception(true);
		page.on('request', request => {
			if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
			else request.abort();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			App.currentUser = { id: 'synthetic-scroll', role: 'user' };
			App.showApp();
			document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-add_spotify'));
			window.scrollRequests = [];
			App.apiFetch = async (endpoint, method, body) => {
				if (endpoint === '/spotify_test' && body.action === 'playlist') {
					window.scrollRequests.push(body);
					return { data: { id: 'playlist123456789', name: 'Playlist de test', tracks: {
						total: 123, next: null, items: Array.from({ length: 123 }, (_, index) => ({ track: {
							id: `track${index}`, name: `Titre ${index}`, artists: []
						} }))
					} } };
				}
				return {};
			};
		});
		for (const width of [390, 1280]) {
			await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
			await page.evaluate(() => {
				document.querySelector('[data-spotify-playlist-url]').value = 'playlist123456789';
				document.querySelector('[data-spotify-playlist-open-form]').dispatchEvent(new Event('submit', { cancelable: true }));
			});
			await page.waitForFunction(() => document.querySelectorAll('.spotify-track-row').length === 50);
			assert.equal(await page.$('[data-load-more-playlist]'), null);
			const initial = await page.evaluate(() => {
				const results = document.querySelector('[data-spotify-results]');
				let container = results;
				while (container && !(container.scrollHeight > container.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(container).overflowY))) container = container.parentElement;
				window.playlistScrollContainer = container;
				container.scrollTop = 0;
				container.scrollTop = container.scrollHeight - container.clientHeight;
				return { top: container.scrollTop, isResults: container === results };
			});
			assert.ok(initial.top > 0, `${width}px list scrolls`);
			await page.waitForFunction(() => document.querySelectorAll('.spotify-track-row').length === 100);
			assert.equal(await page.evaluate(() => window.playlistScrollContainer.scrollTop), initial.top, `${width}px keeps its scroll position`);
			await page.evaluate(() => { window.playlistScrollContainer.scrollTop = window.playlistScrollContainer.scrollHeight; });
			await page.waitForFunction(() => document.querySelectorAll('.spotify-track-row').length === 123);
			assert.equal(await page.$('[data-playlist-scroll-hint]'), null);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
			t.diagnostic(`${width}px: scroll container ${initial.isResults ? 'results' : 'ancestor'}, 50 → 100 → 123 tracks`);
		}
		assert.equal(await page.evaluate(() => window.scrollRequests.length), 2);
	} catch (error) {
		t.diagnostic(JSON.stringify(await page.evaluate(() => ({
			requests: window.scrollRequests,
			status: document.querySelector('[data-spotify-status]').textContent,
			rows: document.querySelectorAll('.spotify-track-row').length
		}))));
		throw error;
	} finally {
		await page.close();
	}
});

test('admin update panel follows installation progress and fits mobile and desktop', { timeout: 20000 }, async t => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const page = await browser.newPage();
	let state = { enabled: true, online: true, phase: 'idle', currentVersion: 'v1', latestVersion: 'v2', updateAvailable: true };
	let installRequests = 0;
	try {
		await page.setRequestInterception(true);
		page.on('request', request => {
			const route = new URL(request.url()).pathname;
			if (route.startsWith('/admin/updates')) {
				if (route.endsWith('/install')) {
					installRequests++;
					assert.deepEqual(JSON.parse(request.postData()), { version: 'v2' });
					state = { ...state, requestId: 'synthetic-job', phase: 'downloading', progress: 25 };
					request.respond({ status: 202, contentType: 'application/json', body: JSON.stringify({ requestId: 'synthetic-job' }) });
				} else request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
			} else if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
			else request.abort();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.updateFixtureApp = App;
			App.currentUser = { id: 'synthetic-admin', role: 'admin', pseudo: 'Synthetic' };
			App.apiFetch = async () => [];
			document.body.classList.remove('auth-required');
			document.querySelector('.auth-screen').hidden = true;
			App.loadView('admin');
			await App.fetchUpdateStatus();
		});
		await page.click('#admin-tab-updates');
		await page.waitForFunction(() => !document.getElementById('admin-update-install').disabled);
		for (const width of [320, 390, 768, 1280]) {
			await page.setViewport({ width, height: 844 });
			assert.equal(await page.evaluate(() => {
				const button = document.getElementById('admin-update-install').getBoundingClientRect();
				return button.width > 0 && button.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
			}), true, `admin updater fits at ${width}px`);
		}
		await page.click('#admin-update-install');
		await page.waitForFunction(() => document.getElementById('admin-update-status').textContent.includes('25 %'));
		assert.equal(await page.$eval('#admin-update-install', button => button.disabled), true);
		state = { ...state, phase: 'restarting' };
		await page.evaluate(() => window.updateFixtureApp.fetchUpdateStatus());
		assert.match(await page.$eval('#admin-update-status', element => element.textContent), /redémarrage/);
		state = { ...state, phase: 'failed', rolledBack: true };
		await page.evaluate(() => window.updateFixtureApp.fetchUpdateStatus());
		assert.match(await page.$eval('#admin-update-status', element => element.textContent), /rétablie/);
		assert.equal(installRequests, 1);
	} finally { await page.close(); }
});

test('Spotify artist portraits render and navigation opens and imports an album', { timeout: 15000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const page = await browser.newPage();
	page.setDefaultTimeout(5000);
	page.on('pageerror', error => t.diagnostic(error.message));
	try {
		await page.setRequestInterception(true);
		page.on('request', request => {
			if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
			else request.abort();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.spotifyApp = App;
			document.body.classList.remove('auth-required');
			document.querySelector('.auth-screen').hidden = true;
			document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-add_spotify'));
			window.spotifyRequests = [];
			const images = [{ url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="80"%3E%3Crect width="80" height="80" fill="%231ed760"/%3E%3C/svg%3E' }];
			window.addEventListener('unhandledrejection', event => { window.spotifyError = event.reason?.stack || String(event.reason); });
			App.apiFetch = async (endpoint, method, body) => {
				window.spotifyRequests.push({ endpoint, method, body });
				if (endpoint === '/spotify_test' && body.action === 'search') return { data: {
					tracks: { items: [] }, playlists: { items: [] }, albums: { items: [] },
					artists: { items: [{ id: 'artist12345', name: 'Artiste test', images }] }
				} };
				if (endpoint === '/spotify_test' && body.action === 'artist') return { data: {
					artist: { id: 'artist12345', name: 'Artiste test', images }, top_tracks: [],
					related_artists: [{ id: 'related12345', name: 'Artiste similaire', images }],
					albums: [{ id: 'album123456', name: 'Album test', artists: [{ id: 'artist12345', name: 'Artiste test' }] }]
				} };
				if (endpoint === '/spotify_test' && body.action === 'album') return { data: {
					id: 'album123456',
					external_urls: { spotify: 'https://open.spotify.com/album/album123456' },
					tracks: { items: [{ id: 'track123456', name: 'Titre test', artists: [{ id: 'artist12345', name: 'Artiste test' }] }] }
				} };
				if (endpoint === '/spotify_import_browser_playlist') return { playlist: body.playlist, count: body.items.length };
				if (endpoint === '/playlist_summaries' || endpoint === '/different_playlist') return {};
				throw new Error(`Unexpected request: ${endpoint}`);
			};
			const input = document.querySelector('[data-spotify-search-input]');
			input.value = 'Artiste test';
			document.querySelector('[data-spotify-search-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		await page.waitForFunction(() => {
			const card = document.querySelector('[data-entity-type="artist"][data-entity-id="artist12345"]');
			return card && !card.disabled && card.querySelector('img')?.naturalWidth > 0;
		});
		await page.$eval('[data-entity-type="artist"][data-entity-id="artist12345"]', element => element.click());
		await page.waitForFunction(() => {
			const card = document.querySelector('[data-entity-type="album"][data-entity-id="album123456"]');
			return card && !card.disabled;
		});
		await page.waitForFunction(() => document.querySelector('.spotify-hero-cover.artist')?.naturalWidth > 0
			&& document.querySelector('[data-entity-id="related12345"] img')?.naturalWidth > 0);
		for (const width of [320, 1280]) {
			await page.setViewport({ width, height: 844 });
			assert.equal(await page.$eval('.spotify-hero-cover.artist', image =>
				getComputedStyle(image).borderRadius === '50%' && image.getBoundingClientRect().width > 0), true);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `artist portraits fit at ${width}px`);
		}
		await page.$eval('[data-entity-type="album"][data-entity-id="album123456"]', element => element.click());
		await page.waitForSelector('.spotify-results [data-import-current]');
		assert.match(await page.$eval('.spotify-results', element => element.innerText), /Album test/);
		await page.$eval('.spotify-results [data-import-current]', element => element.click());
		await page.waitForFunction(() => window.spotifyRequests.some(request => request.endpoint === '/spotify_import_browser_playlist'));
		const imported = await page.evaluate(() => window.spotifyRequests.find(request => request.endpoint === '/spotify_import_browser_playlist').body);
		assert.equal(imported.playlist, 'Album test');
		assert.deepEqual(imported.items.map(item => item.title), ['Titre test']);
		await page.evaluate(() => {
			window.spotifyActions = [];
			window.spotifyApp.enqueueNextSong = async (track, options = {}) => window.spotifyActions.push({ action: options.playNow ? 'play' : 'queue', type: track.type });
			window.spotifyApp.toggleDiscoveredTrackLike = async track => window.spotifyActions.push({ action: 'like', type: track.type });
			window.spotifyApp.openAddModal = async track => window.spotifyActions.push({ action: 'playlist', type: track.type });
		});
		await page.$eval('.spotify-track-row', element => element.click());
		await page.$eval('.spotify-track-row [data-queue-track]', element => element.click());
		await page.$eval('.spotify-track-row .spotify-like', element => element.click());
		await page.$eval('.spotify-track-row [data-add-track]', element => element.click());
		const row = await page.$('.spotify-track-row');
		await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
		const bounds = await row.boundingBox();
		await page.mouse.move(bounds.x + 15, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + 115, bounds.y + bounds.height / 2, { steps: 8 });
		await page.mouse.up();
		await page.waitForFunction(() => window.spotifyActions.length === 5);
		assert.deepEqual(await page.evaluate(() => window.spotifyActions.map(item => item.action)), ['play', 'queue', 'like', 'playlist', 'queue']);
		await page.waitForFunction(() => {
			const transform = getComputedStyle(document.querySelector('.spotify-track-actions')).transform;
			return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
		});
		for (const width of [320, 390, 800, 1280]) {
			await page.setViewport({ width, height: 844 });
			assert.equal(await page.evaluate(() => {
				const row = document.querySelector('.spotify-track-row').getBoundingClientRect();
				const actions = document.querySelector('.spotify-track-actions').getBoundingClientRect();
				return row.left >= 0 && actions.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
			}), true, `Spotify actions fit at ${width}px`);
		}
	} catch (error) {
		t.diagnostic(JSON.stringify(await page.evaluate(() => ({
			requests: window.spotifyRequests,
			error: window.spotifyError,
			status: document.querySelector('[data-spotify-status]')?.textContent,
			results: document.querySelector('[data-spotify-results]')?.innerText
		}))));
		throw error;
	} finally {
		await page.close();
	}
});

test('YouTube results play on click, queue on swipe and open the playlist form from three dots', { timeout: 30000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const page = await browser.newPage();
	page.setDefaultTimeout(5000);
	page.on('pageerror', error => t.diagnostic(error.message));
	try {
		// Real playback of synthetic audio through the existing /play path.
		const audio = Buffer.alloc(44 + 8000 * 2 * 30);
		audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4);
		audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
		audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
		audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
		audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
		audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
		await page.setRequestInterception(true);
		page.on('request', request => {
			if (new URL(request.url()).pathname.startsWith('/play/')) {
				void request.respond({ status: 200, contentType: 'audio/wav', body: audio });
			} else void request.continue();
		});
		await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			document.body.classList.remove('auth-required');
			document.querySelector('.auth-screen').hidden = true;
			document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-add_youtube'));
			const thumbnail = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70"/>';
			const results = Array.from({ length: 15 }, (_, id) => ({
				id: { kind: 'youtube#video', videoId: `youtube-test-${id}` },
				snippet: { title: `YouTube fixture ${id} with a long title`, channelTitle: 'Source channel', thumbnails: { default: { url: thumbnail } } }
			}));
			results.push({ id: { kind: 'youtube#playlist', playlistId: 'playlist-fixture' }, snippet: { title: 'Playlist fixture' } });
			window.queued = []; window.played = []; window.imported = []; window.liked = [];
			let queue = [], currentId = null, current = null;
			App.prefetchUpcomingTrack = () => {};
			App.requestWakeLock = () => {};
			App.openYoutubePlaylistActionMenu = (_button, playlist) => window.imported.push(playlist.playlistId);
			App.apiFetch = async (path, method, body) => {
				if (path === '/send_search_youtube') return { items: results };
				if (path === '/different_playlist') return ['Existing fixture.json'];
				if (path === '/liked_tracks') {
					window.liked.push(body);
					return { items: body.liked ? [body.song] : [] };
				}
				if (path === '/add_song_ecoute') {
					window.queued.push(body.song.url);
					queue.unshift({ ...body.song, __sessionIndex: Number(body.song.url.split('-').at(-1)) });
					return { currentId, current, queue, random: false };
				}
				if (path.startsWith('/next_song')) {
					current = queue.shift(); currentId = current.__sessionIndex;
					window.played.push(currentId);
					return { mode: 'normal', currentId, current, queue, path: `/play/${currentId}` };
				}
				throw new Error(`Unexpected request: ${path}`);
			};
			App.waitForTrackReady = async id => `/play/${id}`;
			window.originalAudio = App.lecteur;
			document.getElementById('query_yt').value = 'fixture';
			await App.searchYoutube();
		});
		await page.click('.video-card[data-id="youtube-test-0"] p');
		await page.waitForFunction(() => window.played.length === 1 && !window.fixtureApp.lecteur.paused && !window.fixtureApp.nextSongLoading);
		assert.equal(await page.evaluate(() => window.fixtureApp.lecteur === window.originalAudio), true);
		const card = await page.$('.video-card[data-id="youtube-test-1"]');
		const rect = await card.boundingBox();
		const x = rect.x + 25, y = rect.y + rect.height / 2;
		await page.mouse.move(x, y); await page.mouse.down();
		await page.mouse.move(x + 100, y, { steps: 8 }); await page.mouse.up();
		await page.waitForFunction(() => window.queued.length === 2 && !window.fixtureApp.queueEditPromise);
		assert.deepEqual(await page.evaluate(() => [window.played, Number(window.fixtureApp.currentId), window.fixtureApp.lecteur.paused]), [[0], 0, false]);
		const cdp = await page.createCDPSession();
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
		for (let dx = 20; dx <= 100; dx += 20) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await page.waitForFunction(() => window.queued.length === 3 && !window.fixtureApp.queueEditPromise);
		// Another card avoids the deliberate click suppression immediately after a swipe.
		await page.click('.video-card[data-id="youtube-test-0"] .youtube-options');
		await page.waitForSelector('#playlist-modal', { visible: true });
		assert.equal(await page.$eval('#modal-playlist-select', el => el.options[0].textContent), 'Existing fixture');
		assert.equal(await page.$eval('#modal-new-playlist', el => el.value), '');
		assert.deepEqual(await page.evaluate(() => [window.queued.length, window.played]), [3, [0]]);
		await page.click('#btn-modal-close');
		await page.click('.video-card[data-id="youtube-test-0"] .youtube-like');
		await page.waitForFunction(() => window.liked.length === 1 && document.querySelector('.youtube-like').getAttribute('aria-pressed') === 'true');
		assert.equal(await page.evaluate(() => window.liked[0].song.type), 'youtube');
		await page.click('.video-card[data-id="youtube-test-2"] p');
		await page.waitForFunction(() => window.played.length === 2 && !window.fixtureApp.nextSongLoading);
		assert.deepEqual(await page.evaluate(() => window.played), [0, 2]);
		for (const width of [320, 390, 1280]) {
			await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
			assert.equal(await page.evaluate(() => {
				const button = document.querySelector('.youtube-options').getBoundingClientRect();
				return button.width >= 40 && button.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
			}), true, `Three dots fit at ${width}px`);
		}
		await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 550 }] });
		for (let dy = 20; dy <= 140; dy += 20) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 550 - dy }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await page.waitForFunction(() => document.querySelector('.views-container').scrollTop > 0 || window.fixtureApp.ytResults.scrollTop > 0);
		assert.deepEqual(await page.evaluate(() => [window.queued.length, window.played]), [4, [0, 2]]);
		await page.click('.import-youtube-playlist');
		assert.deepEqual(await page.evaluate(() => window.imported), ['playlist-fixture']);
		assert.deepEqual(await page.evaluate(() => window.played), [0, 2]);
	} catch (error) {
		t.diagnostic(JSON.stringify(await page.evaluate(() => ({
			queued: window.queued, played: window.played,
			currentId: window.fixtureApp?.currentId,
			paused: window.fixtureApp?.lecteur?.paused,
			loading: window.fixtureApp?.nextSongLoading,
			modal: document.getElementById('playlist-modal').style.display,
			scroll: document.querySelector('.views-container').scrollTop,
			resultsScroll: window.fixtureApp?.ytResults?.scrollTop
		}))));
		throw error;
	} finally {
		await page.close();
	}
});

test('browser login unlocks the playlist view', { timeout: 20000 }, async (t) => {
	if (browserSetupError) {
		t.skip(`Browser test unavailable: ${browserSetupError.message}`);
		return;
	}

	const page = await browser.newPage();
	try {
		await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('#login-form', { timeout: 5000 });
		await page.type('#login-pseudo', 'user');
		await page.type('#login-password', 'password123');
		await page.click('#login-form button[type="submit"]');
		await page.waitForFunction(() => !document.body.classList.contains('auth-required'), { timeout: 5000 });
		await page.waitForSelector('.playlist-selection-item', { timeout: 5000 });

		const state = await page.evaluate(() => ({
			sessionUser: document.getElementById('session-user')?.textContent || '',
			playlistCount: document.querySelectorAll('.playlist-selection-item').length,
			adminVisible: !document.querySelector('.nav-admin')?.hidden
		}));

		assert.match(state.sessionUser, /user/i);
		assert.ok(state.playlistCount > 0);
		assert.equal(state.adminVisible, false);
	} finally {
		await page.close();
	}
});

test('account password change preserves the session, logs out and rejects the previous password', { timeout: 20000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const pseudo = `synthetic-account-${process.pid}`;
	await app.locals.youplayerStore.createUser({ pseudo, password: 'synthetic-old-password', role: 'user' });
	const page = await browser.newPage();
	try {
		await page.setViewport({ width: 390, height: 844 });
		await page.setRequestInterception(true);
		page.on('request', request => {
			if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
			else request.abort();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			await App.logout();
		});
		await page.$eval('#login-pseudo', input => { input.value = ''; });
		await page.type('#login-pseudo', pseudo);
		await page.type('#login-password', 'synthetic-old-password');
		await page.$eval('#login-form', form => form.requestSubmit());
		await page.waitForFunction(() => !document.body.classList.contains('auth-required'));
		await page.evaluate(() => window.fixtureApp.loadView('parametres'));
		await page.type('#password-change-form [name="currentPassword"]', 'synthetic-old-password');
		await page.type('#password-change-form [name="newPassword"]', 'synthetic-new-password');
		await page.type('#password-change-form [name="confirmPassword"]', 'synthetic-mismatch');
		await page.$eval('#password-change-form', form => form.requestSubmit());
		await page.waitForFunction(() => document.getElementById('password-change-message').classList.contains('error-msg'));
		assert.equal(await page.$eval('#password-change-form [name="newPassword"]', input => input.value), 'synthetic-new-password');
		await page.$eval('#password-change-form [name="confirmPassword"]', input => { input.value = 'synthetic-new-password'; });
		await page.$eval('#password-change-form', form => form.requestSubmit());
		await page.waitForFunction(() => document.getElementById('password-change-message').classList.contains('success-msg'));
		assert.equal(await page.evaluate(() => document.body.classList.contains('auth-required')), false);
		assert.ok(await page.$$eval('#password-change-form input', inputs => inputs.every(input => input.value === '')));
		await page.evaluate(() => window.fixtureApp.logout());
		assert.equal(await page.evaluate(() => window.fixtureApp.currentUser), null);
		assert.equal(await page.evaluate(() => document.body.classList.contains('auth-required')), true);
		await page.type('#login-password', 'synthetic-old-password');
		await page.$eval('#login-form', form => form.requestSubmit());
		await page.waitForFunction(() => document.getElementById('login-error').innerText === 'Identifiants invalides.');
		assert.equal(await page.evaluate(() => document.body.classList.contains('auth-required')), true);
		await page.$eval('#login-password', input => { input.value = ''; });
		await page.type('#login-password', 'synthetic-new-password');
		await page.$eval('#login-form', form => form.requestSubmit());
		await page.waitForFunction(() => !document.body.classList.contains('auth-required'));
		assert.equal(await page.$eval('#login-password', input => input.value), '');
		assert.equal(await page.evaluate(() => window.fixtureApp.currentUser.pseudo), pseudo);
	} finally {
		await page.evaluate(() => window.fixtureApp?.logout()).catch(() => {});
		await page.close();
	}
});

test('admin account forms create a user and reset its password without exposing admin controls to that user', { timeout: 20000 }, async (t) => {
	if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
	const adminPseudo = `synthetic-admin-ui-${process.pid}`;
	const memberPseudo = `synthetic-member-ui-${process.pid}`;
	await app.locals.youplayerStore.createUser({ pseudo: adminPseudo, password: 'synthetic-admin-password', role: 'admin' });
	const page = await browser.newPage();
	let integrationChecks = 0;
	try {
		await page.setViewport({ width: 1280, height: 844 });
		await page.setRequestInterception(true);
		page.on('request', async request => {
			if (request.url() === `${baseUrl}/admin/integrations/check`) {
				integrationChecks++;
				await new Promise(resolve => setTimeout(resolve, 150));
				return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
					checkedAt: '2026-10-05T12:00:00Z', connections: {
						youtube: { state: 'quota_exceeded' }, spotifyPublic: { state: 'connected' }, spotifyOAuth: { state: 'rejected' }
					}, private: 'synthetic-private-token'
				}) });
			}
			if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
			else request.abort();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			await App.logout();
		});
		await page.$eval('#login-pseudo', input => { input.value = ''; });
		await page.type('#login-pseudo', adminPseudo);
		await page.type('#login-password', 'synthetic-admin-password');
		await page.$eval('#login-form', form => form.requestSubmit());
		await page.waitForFunction(() => !document.body.classList.contains('auth-required'));
		assert.equal(await page.$eval('.nav-admin', link => link.hidden), false);
		await page.waitForFunction(() => document.getElementById('admin-youtube-status').textContent === 'Non configurée');
		for (const width of [320, 390, 768, 1280]) {
			await page.setViewport({ width, height: 844 });
			const state = await page.evaluate(() => {
				const visible = selector => Array.from(document.querySelectorAll(selector)).some(el => el.getBoundingClientRect().width > 0);
				return {
					admin: document.getElementById('view-admin').classList.contains('active'),
					music: visible('.player-controls, .actions-add, [data-view="accueil"], [data-view="playlist"]'),
					overflow: document.documentElement.scrollWidth > innerWidth,
					spotify: document.getElementById('admin-spotify-status').textContent
				};
			});
			assert.equal(state.admin, true);
			assert.equal(state.music, false);
			assert.equal(state.overflow, false, `admin overflow at ${width}`);
			assert.equal(state.spotify, 'Non vérifiée');
		}
		assert.equal(await page.$eval('#admin-tab-integrations', el => el.getAttribute('aria-selected')), 'true');
		await page.focus('#admin-tab-integrations');
		await page.keyboard.press('ArrowRight');
		assert.equal(await page.$eval('#admin-tab-accounts', el => el.getAttribute('aria-selected')), 'true');
		assert.equal(await page.$eval('#admin-pane-integrations', el => el.hidden), true);
		await page.keyboard.press('End');
		assert.equal(await page.$eval('#admin-tab-updates', el => el === document.activeElement), true);
		await page.keyboard.press('Home');
		for (const width of [320, 390, 768, 1280]) {
			await page.setViewport({ width, height: 844 });
			for (const name of ['accounts', 'history', 'updates', 'integrations']) {
				await page.click(`#admin-tab-${name}`);
				assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits at ${width}`);
				assert.equal(await page.$$eval('#view-admin [role="tabpanel"]', panels => panels.filter(panel => !panel.hidden).length), 1);
			}
		}
		assert.equal(integrationChecks, 0, 'Opening Admin must not start a live probe');
		await page.click('#admin-integrations-check');
		await page.waitForFunction(() => document.getElementById('admin-integrations-check').disabled);
		await page.waitForFunction(() => document.getElementById('admin-youtube-status').textContent === 'Quota dépassé');
		assert.equal(integrationChecks, 1);
		assert.equal(await page.$eval('#admin-spotify-status', el => getComputedStyle(el).backgroundColor), 'rgb(23, 107, 59)');
		for (const width of [320, 390, 768, 1280]) {
			await page.setViewport({ width, height: 844 });
			const state = await page.evaluate(() => ({
				public: document.getElementById('admin-spotify-status').textContent,
				oauth: document.getElementById('admin-spotify-oauth-status').textContent,
				last: document.getElementById('admin-integrations-last-check').textContent,
				disabled: document.getElementById('admin-integrations-check').disabled,
				overflow: document.documentElement.scrollWidth > innerWidth,
				privateDetail: document.body.textContent.includes('synthetic-private-token')
			}));
			assert.equal(state.public, 'Accessible');
			assert.equal(state.oauth, 'Accès refusé');
			assert.match(state.last, /Dernière vérification/);
			assert.equal(state.disabled, false);
			assert.equal(state.overflow, false, `integration overflow at ${width}`);
			assert.equal(state.privateDetail, false);
		}
		await page.evaluate(() => window.fixtureApp.loadView('add_spotify'));
		assert.equal(await page.$eval('#view-admin', el => el.classList.contains('active')), true);
		await page.evaluate(() => window.fixtureApp.loadView('parametres'));
		assert.equal(await page.$eval('#spotify-settings-panel', el => el.getBoundingClientRect().width), 0);
		assert.ok(await page.$eval('#password-change-form', el => el.getBoundingClientRect().width) > 0);
		await page.setViewport({ width: 1280, height: 844 });
		await page.evaluate(() => window.fixtureApp.loadView('admin'));
		await page.click('#admin-tab-accounts');
		await page.waitForSelector('#admin-users .admin-user-row');
		await page.type('#admin-create-user [name="pseudo"]', memberPseudo);
		await page.type('#admin-create-user [name="password"]', 'synthetic-member-old');
		await page.select('#admin-create-user [name="role"]', 'user');
		await page.$eval('#admin-create-user', form => form.requestSubmit());
		await page.waitForFunction(pseudo => Array.from(document.querySelectorAll('#admin-users .admin-user-row')).some(row => row.querySelector('.admin-user-main span').textContent === pseudo), {}, memberPseudo);
		assert.equal(await page.$eval('#admin-create-user [name="password"]', input => input.value), '');
		await page.evaluate(pseudo => {
			const row = Array.from(document.querySelectorAll('#admin-users .admin-user-row')).find(row => row.querySelector('.admin-user-main span').textContent === pseudo);
			const form = row.querySelector('.admin-password-reset');
			window.syntheticResetForm = form;
			form.querySelector('input').value = 'synthetic-member-new';
			form.requestSubmit();
		}, memberPseudo);
		await page.waitForFunction(() => window.syntheticResetForm.querySelector('input').value === '');
		await page.evaluate(() => window.fixtureApp.logout());
		await page.$eval('#login-pseudo', (input, pseudo) => { input.value = pseudo; }, memberPseudo);
		await page.type('#login-password', 'synthetic-member-old');
		await page.$eval('#login-form', form => form.requestSubmit());
		await page.waitForFunction(() => document.getElementById('login-error').innerText === 'Identifiants invalides.');
		await page.$eval('#login-password', input => { input.value = ''; });
		await page.type('#login-password', 'synthetic-member-new');
		await page.$eval('#login-form', form => form.requestSubmit());
		await page.waitForFunction(() => !document.body.classList.contains('auth-required'));
		assert.equal(await page.$eval('.nav-admin', link => link.hidden), true);
		await page.evaluate(() => window.fixtureApp.loadView('admin'));
		assert.equal(await page.$eval('#view-admin', view => view.classList.contains('active')), false);
	} finally {
		await page.evaluate(() => window.fixtureApp?.logout()).catch(() => {});
		await page.close();
	}
});

test('mobile playlist cards keep readable titles and separate actions without horizontal overflow', { timeout: 20000 }, async (t) => {
	if (browserSetupError) {
		t.skip(`Browser test unavailable: ${browserSetupError.message}`);
		return;
	}

	const page = await browser.newPage();
	try {
		await page.setViewport({
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			isMobile: true
		});
		await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
		const authenticationRequired = await page.evaluate(() =>
			document.body.classList.contains('auth-required'));
		if (authenticationRequired) {
			await page.type('#login-pseudo', 'user');
			await page.type('#login-password', 'password123');
			await page.$eval('#login-form', (form) => form.requestSubmit());
			await page.waitForFunction(() => !document.body.classList.contains('auth-required'), { timeout: 5000 });
		}
		await page.waitForSelector('.playlist-selection-item', { timeout: 5000 });

		for (const width of [320, 390, 480]) {
			await page.setViewport({
				width,
				height: 844,
				deviceScaleFactor: 1,
				isMobile: true
			});

			const layout = await page.evaluate(() => {
				const card = document.querySelector('.playlist-selection-item');
				const preview = card.querySelector('.playlist-preview-button').getBoundingClientRect();
				const rowActions = card.querySelector('.library-row-actions');
				const children = [...rowActions.children].filter((element) => !element.hidden);
				const cardRect = card?.getBoundingClientRect();
				const childRects = children.map((element) => element.getBoundingClientRect());
				const centers = childRects.map((rect) => rect.top + rect.height / 2);
				const actions = document.querySelector('.actions-add');
				const player = document.querySelector('.player-controls');
				player.classList.add('visible');

				return {
					actionsBelowTitle: rowActions.getBoundingClientRect().top >= preview.bottom,
					childrenContained: childRects.every((rect) =>
						rect.left >= cardRect.left && rect.right <= cardRect.right
					),
					sameLine: Math.max(...centers) - Math.min(...centers) < 2,
					touchTargets: [...rowActions.querySelectorAll('button:not([hidden])')].every((button) => button.getBoundingClientRect().height >= 44),
					pageHasHorizontalOverflow:
						document.documentElement.scrollWidth > document.documentElement.clientWidth,
					actionsHaveHorizontalOverflow: actions.scrollWidth > actions.clientWidth,
					playerHasHorizontalOverflow: player.scrollWidth > player.clientWidth
				};
			});

			assert.equal(layout.actionsBelowTitle, true, `${width}px actions must sit below the title`);
			assert.equal(layout.touchTargets, true, `${width}px actions must remain touchable`);
			assert.equal(layout.childrenContained, true, `${width}px card children must stay contained`);
			assert.equal(layout.sameLine, true, `${width}px card controls must stay on one line`);
			assert.equal(layout.pageHasHorizontalOverflow, false, `${width}px page must not overflow`);
			assert.equal(layout.actionsHaveHorizontalOverflow, false, `${width}px actions must not overflow`);
			assert.equal(layout.playerHasHorizontalOverflow, false, `${width}px player must not overflow`);
		}
	} finally {
		await page.close();
	}
});

test('the persistent audio element binds ended exactly once', { timeout: 20000 }, async (t) => {
	if (browserSetupError) {
		t.skip(`Browser test unavailable: ${browserSetupError.message}`);
		return;
	}

	const page = await browser.newPage();
	try {
		await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('#lecteur');
		const result = await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			let calls = 0;
			const originalAdvance = App.advanceToNextSong;
			App.advanceToNextSong = () => { calls += 1; };
			try {
				App.lecteur.dispatchEvent(new Event('ended'));
				const afterFirstEnd = calls;
				App.bindAudioEvents();
				App.lecteur.dispatchEvent(new Event('ended'));
				return {
					afterFirstEnd,
					afterSecondEnd: calls,
					hasDetachedAudioPreloader: 'nextAudioPreloader' in App
				};
			} finally {
				App.advanceToNextSong = originalAdvance;
			}
		});

			assert.deepEqual(result, {
				afterFirstEnd: 1,
				afterSecondEnd: 2,
				hasDetachedAudioPreloader: false
			});
	} finally {
		await page.close();
	}
});

test('audio background diagnostics are opt-in and keep stable player instance ids', { timeout: 20000 }, async (t) => {
	if (browserSetupError) {
		t.skip(`Browser test unavailable: ${browserSetupError.message}`);
		return;
	}

	const page = await browser.newPage();
	const consoleMessages = [];
	page.on('console', (message) => consoleMessages.push(message.text()));
	try {
		await page.goto(`${baseUrl}/?audioDebug=1`, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => document.querySelectorAll('audio').length === 1);
		const result = await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			const before = [App.lecteur, App.specialPlayer]
				.map((audio) => App.diagnosticInstanceId(audio));
			App.logAudioEvent('test-event', App.lecteur, { role: 'main-player' });
			const after = [App.lecteur, App.specialPlayer]
				.map((audio) => App.diagnosticInstanceId(audio));
			return {
				enabled: App.audioBackgroundDebug,
				uniqueIds: new Set(before).size,
				stableIds: JSON.stringify(before) === JSON.stringify(after),
				heartbeatActive: App.heartbeatTimer !== null,
				bufferedEntries: window.__YOUPLAYER_AUDIO_DIAGNOSTICS__?.length || 0
			};
		});

		assert.equal(result.enabled, true);
		assert.equal(result.uniqueIds, 1);
		assert.equal(result.stableIds, true);
		assert.equal(result.heartbeatActive, true);
		assert.ok(result.bufferedEntries >= 5);
		assert.ok(consoleMessages.some((message) => message.startsWith('[PLAYER_INSTANCE]')));
		assert.ok(consoleMessages.some((message) => message.startsWith('[AUDIO_DIAG]')));
	} finally {
		await page.close();
	}
});

test('ended handling remains wired while the tab is in background', { timeout: 20000 }, async (t) => {
	if (browserSetupError) {
		t.skip(`Browser test unavailable: ${browserSetupError.message}`);
		return;
	}

	const page = await browser.newPage();
	const foregroundPage = await browser.newPage();
	try {
		await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.__backgroundEndedCalls = 0;
			window.__originalAdvanceToNextSong = App.advanceToNextSong;
			App.advanceToNextSong = () => { window.__backgroundEndedCalls += 1; };
		});

		await foregroundPage.goto('about:blank');
		await foregroundPage.bringToFront();
		const result = await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			const wasHidden = document.hidden;
			App.lecteur.dispatchEvent(new Event('ended'));
			const calls = window.__backgroundEndedCalls;
			App.advanceToNextSong = window.__originalAdvanceToNextSong;
			return { calls, wasHidden };
		});
		assert.deepEqual(result, { calls: 1, wasHidden: true });
	} finally {
		await foregroundPage.close();
		await page.close();
	}
});

test('second audio actually plays in background while first-stream stop HTTP is stalled', { timeout: 20000 }, async (t) => {
	if (browserSetupError) {
		t.skip(`Browser test unavailable: ${browserSetupError.message}`);
		return;
	}
	// Generated tone fixtures, no user media or external downloads.
	const tone = (seconds) => {
		const samples = 8000 * seconds;
		const data = Buffer.alloc(44 + samples * 2);
		data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4);
		data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
		data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
		data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
		data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
		data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
		for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(2000 * Math.sin(i * 2 * Math.PI * 440 / 8000)), 44 + i * 2);
		return data;
	};
	const page = await browser.newPage();
	const foregroundPage = await browser.newPage();
	let heldStop;
	const mediaRequests = [];
	try {
		await page.bringToFront();
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const route = new URL(request.url()).pathname;
			if (/^\/(audio|play|prefetched)/.test(route)) mediaRequests.push(route);
			if (route === '/audio/fixture/stop') { heldStop = request; return; }
			if (route === '/audio/fixture' || route === '/play/1') {
				void request.respond({ status: 200, contentType: 'audio/wav', body: tone(route === '/play/1' ? 4 : 1) });
			} else if (route === '/play_status/1') {
				void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready', path: '/play/1' }) });
			} else if (route === '/prefetched_next') {
				void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ currentId: 1, current: { title: 'Second fixture' }, queue: [] }) });
			} else void request.continue();
		});
		await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
		await page.waitForNetworkIdle();
		await page.evaluate(async () => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			const queue = [{ __sessionIndex: 1, title: 'Second fixture' }];
			App.currentId = 0;
			App.lastPlaybackState = { currentId: 0, queue };
			void App.startSpecialPlayback({ stream_id: 'fixture', audio_url: '/audio/fixture', queue });
		});
		await page.waitForFunction(() => window.fixtureApp.nextTrackPrefetch?.trackId === 1
			&& !window.fixtureApp.lecteur.paused, { timeout: 8000 });
		await foregroundPage.goto('about:blank');
		await foregroundPage.bringToFront();
		await page.waitForFunction(() => {
			const app = window.fixtureApp;
			return Number(app.currentId) === 1 && !app.lecteur.paused && app.lecteur.currentTime > 0.15;
		}, { timeout: 8000, polling: 100 });
		assert.ok(heldStop, 'stop request must still be awaiting a response');
		const result = await page.evaluate(() => ({ hidden: document.hidden, source: new URL(window.fixtureApp.lecteur.currentSrc).pathname }));
		assert.deepEqual(result, { hidden: true, source: '/play/1' });
	} catch (error) {
		t.diagnostic(JSON.stringify({ mediaRequests, state: await page.evaluate(() => {
			const app = window.fixtureApp;
			return app ? { id: app.currentId, prefetch: app.nextTrackPrefetch?.trackId,
				time: app.lecteur.currentTime, paused: app.lecteur.paused, error: app.lecteur.error?.message,
				source: app.lecteur.currentSrc, loading: app.nextSongLoading } : null;
		}) }));
		throw error;
	} finally {
		if (heldStop) await heldStop.respond({ status: 200, contentType: 'application/json', body: '{}' }).catch(() => {});
		await foregroundPage.close();
		await page.close();
	}
});

test('crossfade duration setting persists and zero disables overlap', { timeout: 15000 }, async (t) => {
	if (browserSetupError) { t.skip(`Browser test unavailable: ${browserSetupError.message}`); return; }
	const page = await browser.newPage();
	try {
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		for (const seconds of [10, 0]) {
			await page.evaluate(seconds => {
				const input = document.getElementById('crossfade-duration');
				input.value = String(seconds);
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			}, seconds);
			await page.reload({ waitUntil: 'networkidle0' });
			const state = await page.evaluate(async () => {
				const { App } = await import(document.querySelector('script[type="module"]').src);
				return { duration: App.crossfade.duration, enabled: App.crossfade.enabled,
					value: document.getElementById('crossfade-duration').value };
			});
			assert.deepEqual(state, { duration: seconds, enabled: seconds > 0, value: String(seconds) });
		}
	} finally {
		await page.evaluate(() => localStorage.removeItem('crossfade-duration'));
		await page.close();
	}
});

for (const startupLag of [0, 0.25]) {
test(`crossfade overlaps real audio and hands off once on the persistent player (lag ${startupLag}s)`, { timeout: 25000 }, async (t) => {
	if (browserSetupError) { t.skip(`Browser test unavailable: ${browserSetupError.message}`); return; }
	const samples = 8000 * 9;
	const tone = Buffer.alloc(44 + samples * 2);
	tone.write('RIFF'); tone.writeUInt32LE(tone.length - 8, 4);
	tone.write('WAVEfmt ', 8); tone.writeUInt32LE(16, 16);
	tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22);
	tone.writeUInt32LE(8000, 24); tone.writeUInt32LE(16000, 28);
	tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34);
	tone.write('data', 36); tone.writeUInt32LE(samples * 2, 40);
	for (let i = 0; i < samples; i++) tone.writeInt16LE(Math.round(2000 * Math.sin(i * Math.PI * 440 / 4000)), 44 + i * 2);
	const nextTone = Buffer.from(tone);
	for (let i = 0; i < samples; i++) nextTone.writeInt16LE(Math.round(2000 * Math.sin(i * Math.PI * 660 / 4000)), 44 + i * 2);
	const page = await browser.newPage();
	let transitions = 0;
	try {
		await page.setRequestInterception(true);
		page.on('request', request => {
			const route = new URL(request.url()).pathname;
			if (/^\/play\/[01]$/.test(route)) {
				const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
				const start = range ? Number(range[1]) : 0;
				const end = range?.[2] ? Math.min(Number(range[2]), tone.length - 1) : tone.length - 1;
				void request.respond({ status: range ? 206 : 200, contentType: 'audio/wav',
					headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${tone.length}` } : {}) },
					body: (route === '/play/1' ? nextTone : tone).subarray(start, end + 1) });
			} else if (route === '/play_status/1') {
				void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready', path: '/play/1' }) });
			} else if (route === '/prefetched_next') {
				transitions++;
				void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ currentId: 1, current: { title: 'Fixture B' }, queue: [] }) });
			} else void request.continue();
		});
		await page.goto(baseUrl, { waitUntil: 'networkidle0' });
		await page.evaluate(async startupLag => {
			const { App } = await import(document.querySelector('script[type="module"]').src);
			window.fixtureApp = App;
			window.originalAudio = App.lecteur;
			App.lecteur.addEventListener('loadedmetadata', () => {
				if (Number(App.currentId) === 1 && startupLag) App.lecteur.currentTime = Math.max(0, App.lecteur.currentTime - startupLag);
			});
			window.fadeEvents = [];
			for (const event of ['ended', 'pause', 'loadedmetadata', 'playing', 'error']) {
				App.lecteur.addEventListener(event, () => window.fadeEvents.push({ event, time: App.lecteur.currentTime,
					handoff: App.crossfade.handoff, preview: !!App.crossfade.preview, id: App.currentId }));
			}
			App.currentId = 0;
			const queue = [{ __sessionIndex: 1, title: 'Fixture B' }];
			App.lastPlaybackState = { currentId: 0, queue };
			await App.crossfade.unlock();
			const analyser = App.crossfade.context.createAnalyser();
			analyser.fftSize = 1024;
			App.crossfade.mainGain.connect(analyser);
			const originalTick = App.crossfade.tick.bind(App.crossfade);
			App.crossfade.tick = (...args) => {
				const previous = App.crossfade.preview;
				originalTick(...args);
				if (App.crossfade.preview && App.crossfade.preview !== previous) App.crossfade.preview.gain.connect(analyser);
			};
			window.handoffSamples = [];
			const data = new Float32Array(analyser.fftSize);
			window.handoffSampler = setInterval(() => {
				if (Number(App.currentId) !== 1) return;
				analyser.getFloatTimeDomainData(data);
				window.handoffSamples.push({ time: performance.now(), rms: Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length),
					preview: !!App.crossfade.preview, finishing: App.crossfade.handoffFinishing, loading: App.nextSongLoading,
					drift: App.crossfade.elapsed() - App.lecteur.currentTime });
			}, 10);
			await App.prefetchUpcomingTrack(queue);
			await App.loadAndPlayMainSource('/play/0');
		}, startupLag);
		await page.waitForFunction(() => window.fixtureApp.crossfade.prepared);
		// Seeking and pausing during an overlap must silence the preview immediately.
		await page.evaluate(() => window.fixtureApp.seekPlayer(6.1));
		await page.waitForFunction(() => window.fixtureApp.crossfade.preview);
		const paused = await page.evaluate(() => {
			const app = window.fixtureApp;
			app.togglePlayback();
			return { preview: !!app.crossfade.preview, paused: app.lecteur.paused };
		});
		assert.deepEqual(paused, { preview: false, paused: true });
		await page.evaluate(() => { window.fixtureApp.seekPlayer(5.5); window.fixtureApp.togglePlayback(); });
		await page.waitForFunction(() => {
			const c = window.fixtureApp.crossfade;
			return c.preview && c.mainGain.gain.value > 0.1 && c.mainGain.gain.value < 0.8
				&& c.preview.gain.gain.value > 0.1 && c.preview.gain.gain.value < 0.9;
		});
		assert.equal(await page.evaluate(() => window.fixtureApp.currentId), 0, 'preview does not advance the queue');
		await page.waitForFunction(() => {
			const app = window.fixtureApp;
			return Number(app.currentId) === 1 && !app.lecteur.paused && app.lecteur.currentTime >= 2.5 && !app.crossfade.preview;
		}, { timeout: 8000 });
		await page.waitForFunction(() => window.fixtureApp.pendingPrefetchedTransitions.length === 0);
		assert.equal(transitions, 1);
		const handoffTime = await page.evaluate(() => window.fadeEvents.find(e => e.event === 'playing' && Number(e.id) === 1)?.time);
		assert.ok(handoffTime >= 2, `next track must skip its previewed intro, got ${handoffTime}`);
		assert.equal(await page.evaluate(() => window.fixtureApp.lecteur === window.originalAudio), true);
		assert.equal(await page.evaluate(() => window.fixtureApp.crossfade.mainGain.gain.value), 1);
		const continuity = await page.evaluate(() => { clearInterval(window.handoffSampler); return window.handoffSamples; });
		assert.ok(continuity.some(s => s.preview && !s.loading), 'prefetch cleanup must preserve the introduction after play resolves');
		assert.ok(continuity.some(s => s.finishing), 'the scheduled handoff must actually run');
		t.diagnostic(`Handoff drift: ${continuity.find(s => s.finishing)?.drift.toFixed(3)} s`);
		assert.ok(Math.abs(continuity.find(s => s.finishing).drift) < 0.025, 'handoff must align both copies of the recording');
		assert.equal(await page.evaluate(() => window.fixtureApp.lecteur.playbackRate), 1);
		let silenceStart = null;
		for (const sample of continuity) {
			if (sample.rms >= 0.005) silenceStart = null;
			else silenceStart ??= sample.time;
			assert.ok(silenceStart === null || sample.time - silenceStart < 60, 'handoff must not produce 60 ms of silence');
		}
	} catch (error) {
		t.diagnostic(JSON.stringify(await page.evaluate(() => {
			const app = window.fixtureApp;
			return { id: app?.currentId, time: app?.lecteur.currentTime, paused: app?.lecteur.paused,
				src: app?.lecteur.currentSrc, pending: app?.nextSongLoading,
				preview: !!app?.crossfade.preview, handoff: app?.crossfade.handoff,
				gain: app?.crossfade.mainGain?.gain.value, prefetch: app?.nextTrackPrefetch?.path,
				events: window.fadeEvents };
		})));
		throw error;
	} finally { await page.close(); }
});
}

test('playlist switch keeps actual audio playing until its natural end', { timeout: 15000 }, async (t) => {
    if (browserSetupError) throw browserSetupError;
    const page = await browser.newPage();
    try {
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
            else request.abort();
        });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
            const { App } = await import(document.querySelector('script[type="module"]').src);
            window.fixtureApp = App;
            App.currentUser = { id: 'synthetic-switch', role: 'user' };
            App.showApp();
            if (App.crossfade) App.crossfade.enabled = false;
            App.prefetchUpcomingTrack = () => {};
            App.changeLibraryPreference = async () => {};
            App.requestWakeLock = () => {};
            window.switchNext = 0;
            App.nextSong = async () => { window.switchNext++; };
            App.apiFetch = async path => {
                if (path === '/playlist_used') return {
                    preserved: true, currentId: 0, current: { title: 'Current synthetic' },
                    queue: [{ title: 'New synthetic', __sessionIndex: 3 }]
                };
                return null;
            };
            const rate = 8000, samples = rate * 4;
            const data = new Uint8Array(44 + samples * 2), view = new DataView(data.buffer);
            const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
            text(0, 'RIFF'); view.setUint32(4, data.length - 8, true); text(8, 'WAVEfmt ');
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
            view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
            view.setUint16(32, 2, true); view.setUint16(34, 16, true);
            text(36, 'data'); view.setUint32(40, samples * 2, true);
            for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 220 / rate) * 1000, true);
            const audio = App.lecteur;
            audio.src = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
            await audio.play();
            window.originalSwitchAudio = audio;
            window.originalSwitchSrc = audio.src;
        });
        await page.waitForFunction(() => window.fixtureApp.lecteur.currentTime > 0.2);
        await page.evaluate(async () => {
            window.switchTime = window.fixtureApp.lecteur.currentTime;
            window.switchResult = await window.fixtureApp.selectLibraryPlaylists(['new.json']);
        });
        assert.deepEqual(await page.evaluate(() => ({
            success: window.switchResult,
            sameAudio: window.fixtureApp.lecteur === window.originalSwitchAudio,
            sameSrc: window.fixtureApp.lecteur.src === window.originalSwitchSrc,
            paused: window.fixtureApp.lecteur.paused,
            next: window.switchNext
        })), { success: true, sameAudio: true, sameSrc: true, paused: false, next: 0 });
        await page.waitForFunction(() => window.fixtureApp.lecteur.currentTime > window.switchTime + 0.3);
        await page.waitForFunction(() => window.fixtureApp.lecteur.ended && window.switchNext === 1);
    } finally { await page.close(); }
});

test('like buttons sync between playlist rows and expanded player on mobile', { timeout: 15000 }, async () => {
    if (browserSetupError) throw browserSetupError;
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
            else request.abort();
        });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
            const { App } = await import(document.querySelector('script[type="module"]').src);
            const { trackLikeKey } = await import('/client-utils.js');
            window.fixtureApp = App;
            window.likesFixture = [];
            window.likeWrites = 0;
            window.likePlaybackStarts = 0;
            const track = { type: 'youtube', id: 'like-browser', title: 'Un titre synthétique suffisamment long pour vérifier les petits écrans', artist: 'Artiste', __sessionIndex: 0 };
            App.refreshLikes = async () => { App.likedKeys = new Set(window.likesFixture.map(trackLikeKey)); App.renderLikeButtons(); };
            App.currentUser = { id: 'likes-browser', role: 'user' };
            App.showApp();
            App.richPlaylistDisplay = true;
            App.prefetchUpcomingTrack = () => {};
            App.nextSong = App.add_song_playlist = async () => { window.likePlaybackStarts++; };
            App.apiFetch = async (path, method, body) => {
                if (path === '/playlist') return [track, { ...track, __sessionIndex: 1 }];
                if (path === '/playback_state') return { currentId: 0, current: track, queue: [], random: false };
                if (path === '/liked_tracks') {
                    window.likeWrites++;
                    if (window.failLike) return null;
                    window.likesFixture = body.liked ? [track] : [];
                    return { items: window.likesFixture };
                }
                return null;
            };
            await App.loadView('playlist');
        });
        await page.click('#playlist-list .song-like');
        await page.waitForFunction(() => !window.fixtureApp.likeBusy && window.likeWrites === 1);
        assert.deepEqual(await page.$$eval('#playlist-list .song-like', buttons => buttons.map(button => button.getAttribute('aria-pressed'))), ['true', 'true']);
        await page.evaluate(() => window.fixtureApp.openNowPlaying());
        assert.equal(await page.$eval('#overlayLike', button => button.getAttribute('aria-pressed')), 'true');
        await page.click('#overlayLike');
        await page.waitForFunction(() => !window.fixtureApp.likeBusy && window.likeWrites === 2);
        assert.deepEqual(await page.$$eval('#playlist-list .song-like', buttons => buttons.map(button => button.getAttribute('aria-pressed'))), ['false', 'false']);
        await page.evaluate(() => { window.failLike = true; });
        await page.click('#overlayLike');
        await page.waitForFunction(() => !window.fixtureApp.likeBusy && window.likeWrites === 3);
        assert.equal(await page.$eval('#overlayLike', button => button.getAttribute('aria-pressed')), 'false');
        assert.equal(await page.evaluate(() => window.likePlaybackStarts), 0);
        for (const width of [320, 390]) {
            await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.ok(await page.$eval('#overlayLike', button => button.getBoundingClientRect().width >= 44));
        }
    } finally { await page.close(); }
});

test('home playlist preview uses row play, right swipe, heart and options on mobile', { timeout: 15000 }, async (t) => {
    if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 320, height: 700, isMobile: true, hasTouch: true });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
            else request.abort();
        });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
            const { App } = await import(document.querySelector('script[type="module"]').src);
            window.fixtureApp = App;
            window.previewCalls = [];
            window.previewAdded = [];
            window.previewPlayed = [];
            let items = [{ type: 'youtube', id: 'home-preview', title: 'Un titre assez long pour passer sur deux lignes', __playlistIndex: 0 }];
            App.currentUser = { id: 'preview-browser', role: 'user' };
            App.refreshLikes = async () => {};
            App.prefetchUpcomingTrack = async () => {};
            App.fetchAvailablePlaylists = async () => {};
            App.openAddModal = async track => { window.previewAdded.push(track.title); };
            App.nextSong = async reason => { window.previewPlayed.push(reason); };
            window.confirm = () => true;
            App.apiFetch = async (endpoint, method, body) => {
                if (endpoint.startsWith('/playlist_preview?')) return [...items];
                if (endpoint === '/liked_tracks') {
                    window.previewCalls.push(['like', body.index]);
                    return { items: body.liked ? [items[0]] : [] };
                }
                if (endpoint === '/add_song_ecoute') {
                    window.previewCalls.push(['enqueue', body.index]);
                    return { currentId: 0, queue: [{ ...items[0], __sessionIndex: 1 }] };
                }
                if (endpoint === '/delete_from_playlist') {
                    window.previewCalls.push(['delete', body.index]);
                    items = [];
                    return { message: 'OK' };
                }
                return null;
            };
            App.showApp();
            await App.openPlaylistPreview({ name: 'home-preview.json', title: 'Ma playlist' });
        });
        for (const width of [320, 390, 1280]) {
            await page.setViewport({ width, height: 700, isMobile: true, hasTouch: true });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.ok(await page.$$eval('#playlist-preview-list .playlist-preview-actions button', buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)));
            const rowHeight = await page.$eval('#playlist-preview-list .playlist-preview-track', row => row.getBoundingClientRect().height);
            assert.ok(rowHeight <= 70, `preview row ${rowHeight}px at ${width}px`);
        }
        await page.setViewport({ width: 320, height: 700, isMobile: true, hasTouch: true });
        await page.$eval('#playlist-preview-list .queue-title', element => element.scrollIntoView({ block: 'center' }));
        const box = await page.$eval('#playlist-preview-list .queue-title', element => {
            const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        const x = box.x + Math.min(20, box.width / 2), y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 100, y, { steps: 8 });
        await page.mouse.up();
        await page.waitForFunction(() => window.previewCalls.length === 1 && !window.fixtureApp.queueEditPromise);
        assert.deepEqual(await page.evaluate(() => window.previewPlayed), []);
        await new Promise(resolve => setTimeout(resolve, 550));
        await page.click('#playlist-preview-list .queue-title');
        await page.waitForFunction(() => window.previewPlayed.length === 1);
        await page.click('#playlist-preview-list .song-like');
        await page.waitForFunction(() => document.querySelector('#playlist-preview-list .song-like').getAttribute('aria-pressed') === 'true');
        await page.click('#playlist-preview-list .song-options');
        await page.click('.song-action-menu [data-action="add"]');
        await page.click('#playlist-preview-list .song-options');
        await page.click('.song-action-menu [data-action="delete"]');
        await page.waitForFunction(() => document.querySelector('#playlist-preview-list .playlist-preview-empty'));
        assert.deepEqual(await page.evaluate(() => ({ calls: window.previewCalls, added: window.previewAdded, played: window.previewPlayed })), {
            calls: [['enqueue', 0], ['enqueue', 0], ['like', 0], ['delete', 0]],
            added: ['Un titre assez long pour passer sur deux lignes'], played: ['select']
        });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await page.close(); }
});

test('large Liked playlists render without waiting for likes, scroll in batches of 60 and keep all tracks searchable', { timeout: 20000 }, async () => {
    if (browserSetupError) throw browserSetupError;
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 1280, height: 800, isMobile: true, hasTouch: true });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().startsWith(baseUrl) || /^(blob:|data:)/.test(request.url())) request.continue();
            else request.abort();
        });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
            const { App } = await import(document.querySelector('script[type="module"]').src);
            window.fixtureApp = App;
            App.currentUser = { id: 'large-liked-fixture', role: 'user' };
            App.refreshLikes = () => new Promise(() => {});
            App.refreshPlaybackState = async () => {};
            App.nextSong = async () => {};
            App.add_song_playlist = async index => { window.largeLikedSelection = index; };
            App.showApp();
            App.playerBar.classList.add('visible');
            const tracks = Array.from({ length: 3000 }, (_, index) => ({
                title: `Synthetic liked ${index}`, type: 'local', url: `fixture-${index}`,
                __playlistIndex: index, __sessionIndex: index + 10
            }));
            App.playlistTracks = tracks;
            App.apiFetch = async endpoint => endpoint === '/playlist' || endpoint.startsWith('/playlist_preview?') ? tracks : null;
            void App.openPlaylistPreview({ name: 'liked Youplayer.json', title: 'Liked' });
        });
        await page.waitForSelector('#playlist-preview-list .playlist-preview-track', { timeout: 1500 });
        assert.equal(await page.$$eval('#playlist-preview-list .playlist-preview-track', rows => rows.length), 60);
        await page.$eval('#playlist-preview-list .track-list-more button', button => button.click());
        assert.equal(await page.$$eval('#playlist-preview-list .playlist-preview-track', rows => rows.length), 120);
        assert.ok(await page.$$eval('#playlist-preview-list .song-like', buttons => buttons.every(button => button.getAttribute('aria-pressed') === 'true')));
        for (const width of [390, 1280]) {
            await page.setViewport({ width, height: 800, isMobile: true, hasTouch: true });
            for (const view of ['accueil', 'playlist']) {
                const selector = view === 'accueil' ? '#playlist-preview-list' : '#playlist-list';
                const rowSelector = `${selector} > li:not(.track-list-more)`;
                await page.evaluate(view => {
                    document.querySelectorAll('.view, .views-container, #playlist-preview-list, #playlist-list').forEach(element => { element.scrollTop = 0; });
                    document.querySelectorAll('.view').forEach(element => element.classList.toggle('active', element.id === `view-${view}`));
                    const App = window.fixtureApp;
                    if (view === 'accueil') App.renderPlaylistPreview({ name: 'liked Youplayer.json', title: 'Liked' }, App.playlistTracks);
                    else App.renderPlaylistTracks();
                }, view);
                assert.equal(await page.$$eval(rowSelector, rows => rows.length), 60);
                const bottom = await page.evaluate(selector => {
                    const list = document.querySelector(selector);
                    window.firstScrollRow = list.firstElementChild;
                    let scroller = list;
                    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
                    scroller.scrollTop = scroller.scrollHeight;
                    window.localPlaylistScroller = scroller;
                    return scroller.scrollTop;
                }, selector);
                await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 120, {}, rowSelector);
                assert.equal(await page.evaluate(() => window.localPlaylistScroller.scrollTop), bottom, `${view} at ${width}px keeps its position`);
                assert.equal(await page.$eval(selector, list => list.firstElementChild === window.firstScrollRow), true);
                await page.$eval(selector, list => list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })));
                assert.equal(await page.$$eval(rowSelector, rows => rows.length), 120);
                await page.evaluate(selector => {
                    const list = document.querySelector(selector);
                    // Continue swiping while already at the boundary, before a scroll event fires.
                    window.localPlaylistScroller.scrollTop = window.localPlaylistScroller.scrollHeight;
                    list.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientY: 250 }] }));
                    list.dispatchEvent(Object.assign(new Event('touchmove', { bubbles: true }), { touches: [{ clientY: 150 }] }));
                }, selector);
                await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 180, {}, rowSelector);
            }
        }
        await page.evaluate(() => {
            document.querySelectorAll('.view, .views-container, #playlist-list').forEach(element => { element.scrollTop = 0; });
            void window.fixtureApp.loadView('playlist');
        });
        await page.waitForSelector('#playlist-list .playlist-item', { timeout: 1500 });
        assert.equal(await page.$$eval('#playlist-list .playlist-item', rows => rows.length), 60);
        await page.type('#playlist-search', 'Synthetic liked 2999');
        assert.deepEqual(await page.$$eval('#playlist-list .playlist-item', rows => rows.map(row => row.dataset.trackId)), ['3009']);
        for (const width of [390, 1280]) {
            await page.setViewport({ width, height: 800, isMobile: true, hasTouch: true });
            assert.ok(await page.$eval('#playlist-list .song-title', element => element.getBoundingClientRect().width > 0));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        await page.click('#playlist-list .song-title');
        assert.equal(await page.evaluate(() => window.largeLikedSelection), 3009);
        await page.evaluate(() => {
            window.fixtureApp.apiFetch = async () => [];
            void window.fixtureApp.openPlaylistPreview({ name: 'empty.json', title: 'Empty' });
        });
        await page.waitForSelector('#playlist-preview-list .playlist-preview-empty');
        assert.equal(await page.$('#playlist-preview-list .track-list-more'), null);
        assert.equal(await page.evaluate(() => window.fixtureApp.trackPageCleanups.has(window.fixtureApp.playlistPreviewList)), false);
    } finally { await page.close(); }
});

test('local upload form sends edited title, artist and resized cover', { timeout: 15000 }, async (t) => {
    if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 390, height: 700, isMobile: true, hasTouch: true });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
            const { App } = await import(document.querySelector('script[type="module"]').src);
            window.fixtureApp = App;
            App.currentUser = { id: 'local-upload-browser', role: 'user' };
            App.refreshLikes = async () => {};
            App.apiFetch = async endpoint => endpoint === '/different_playlist' ? {} : null;
            App.showApp();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 2;
            canvas.getContext('2d').fillRect(0, 0, 2, 2);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const transfer = new DataTransfer();
            transfer.items.add(new File([blob], 'cover.png', { type: 'image/png' }));
            await App.openAddModal({ type: 'local', title: 'source', file: new File(['audio'], 'source.mp3', { type: 'audio/mpeg' }) });
            document.getElementById('modal-local-artwork').files = transfer.files;
            window.fetch = async (url, options) => {
                if (!String(url).endsWith('/upload_to_playlist')) throw new Error('Unexpected request');
                window.uploadData = {
                    title: options.body.get('title'), artist: options.body.get('artist'),
                    cover: options.body.get('albumCoverURL'), playlist: options.body.get('playlist')
                };
                return { ok: true };
            };
        });
        assert.equal(await page.$eval('#modal-local-metadata', element => element.hidden), false);
        for (const width of [320, 390]) {
            await page.setViewport({ width, height: 700, isMobile: true, hasTouch: true });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        await page.$eval('#modal-local-title', element => { element.value = 'Titre choisi'; });
        await page.$eval('#modal-local-artist', element => { element.value = 'Artiste choisi'; });
        await page.evaluate(() => window.fixtureApp.confirmAddSong('edited-local.json'));
        assert.deepEqual(await page.evaluate(() => ({
            title: window.uploadData?.title, artist: window.uploadData?.artist,
            playlist: window.uploadData?.playlist,
            coverIsImage: /^data:image\/(webp|png);base64,/.test(window.uploadData?.cover || '')
        })), { title: 'Titre choisi', artist: 'Artiste choisi', playlist: 'edited-local.json', coverIsImage: true });
        assert.equal(await page.$eval('#playlist-modal', element => element.style.display), 'none');
    } finally { await page.close(); }
});

test('YouTube playlist menu creates or appends an import, excludes Liked and keeps playback untouched', { timeout: 15000 }, async (t) => {
    if (browserSetupError) return t.skip(`Browser test unavailable: ${browserSetupError.message}`);
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
            const { App } = await import(document.querySelector('script[type="module"]').src);
            window.fixtureApp = App;
            window.originalAudio = App.lecteur;
            window.playlistImports = [];
            window.libraryReloads = 0;
            const { LIKED_PLAYLIST } = await import('/client-utils.js');
            App.currentUser = { id: 'synthetic-import-user', role: 'user' };
            App.showApp();
            App.loadView('add_youtube');
            App.currentId = 17;
            App.fetchAvailablePlaylists = async () => { window.libraryReloads++; };
            App.apiFetch = async (path, method, body) => {
                if (path === '/send_search_youtube') return { items: [{
                    id: { kind: 'youtube#playlist', playlistId: 'PLsynthetic' },
                    snippet: { title: 'Synthetic playlist' }
                }] };
                if (path === '/different_playlist') return ['Existing fixture.json', LIKED_PLAYLIST];
                if (path === '/youtube_import_playlist') {
                    window.playlistImports.push(body);
                    return { playlist: body.playlist || 'Synthetic playlist.json', count: 2 };
                }
                throw new Error(`Unexpected request: ${path}`);
            };
            document.getElementById('query_yt').value = 'synthetic';
            await App.searchYoutube();
        });
        await page.click('.import-youtube-playlist');
        await page.click('.song-action-menu [data-action="append"]');
        await page.waitForSelector('.song-action-menu [data-playlist]');
        assert.deepEqual(await page.$$eval('.song-action-menu [data-playlist]', buttons => buttons.map(button => button.dataset.playlist)), ['Existing fixture.json']);
        await page.click('.song-action-menu [data-action="back"]');
        await page.waitForSelector('.song-action-menu [data-action="create"]');
        await page.click('.song-action-menu [data-action="create"]');
        await page.waitForFunction(() => window.libraryReloads === 1);
        await page.click('.import-youtube-playlist');
        await page.click('.song-action-menu [data-action="append"]');
        await page.waitForSelector('.song-action-menu [data-playlist]');
        await page.click('.song-action-menu [data-playlist]');
        await page.waitForFunction(() => window.libraryReloads === 2);
        assert.deepEqual(await page.evaluate(() => window.playlistImports), [
            { playlistId: 'PLsynthetic', title: 'Synthetic playlist', playlist: null },
            { playlistId: 'PLsynthetic', title: 'Synthetic playlist', playlist: 'Existing fixture.json' }
        ]);
        assert.deepEqual(await page.evaluate(() => ({
            id: window.fixtureApp.currentId,
            sameAudio: window.fixtureApp.lecteur === window.originalAudio,
            source: window.fixtureApp.lecteur.getAttribute('src'),
            menuClosed: window.fixtureApp.songActionMenu === null
        })), { id: 17, sameAudio: true, source: null, menuClosed: true });
    } finally { await page.close(); }
});
