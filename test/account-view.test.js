import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { publicErrorMessage } from '../src/client-utils.js';

const accountSource = (await readFile(new URL('../src/account-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/m, '').replace('export function', 'function');

function element() {
	const classes = new Set();
	return { hidden: true, innerText: '', style: {}, dataset: {}, classList: {
		add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
		toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
	} };
}

function harness(fetch = async () => { throw new Error('Unexpected request'); }) {
	const body = element(), history = [], calls = [], timers = [];
	const window = { location: { origin: 'https://player.test', pathname: '/player', search: '', hash: '#tab' },
		localStorage: { getItem: () => null }, history: { replaceState: (...args) => history.push(args) } };
	const context = vm.createContext({ fetch, window, document: { body, title: 'Synthetic', getElementById: () => null },
		AbortSignal, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
		API_URL: window.location.origin, URLSearchParams, publicErrorMessage, console: { error() {} },
		FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key]; } }
	});
	vm.runInContext(accountSource + '\nglobalThis.view = createAccountView({ apiUrl: API_URL, fetchImpl: fetch });', context);
	const renderAuthState = context.view.renderAuthState;
	const view = Object.assign(context.view, {
		authEnabled: true, currentUser: null, playlistLoadRevision: 4, likesRevision: 2,
		playlistTracks: ['synthetic-track'], likedKeys: new Set(['synthetic-key']),
		playlistContainer: { replaceChildren: () => calls.push('clear-tracks') },
		sleepTimer: { cancel: () => calls.push('cancel-timer') },
		renderLibrary: () => calls.push('library'), clearTrackPageScrolling: () => calls.push('clear-scrolling'),
		renderAuthState: () => calls.push('auth-state'), loadView: name => calls.push('view:' + name),
		showNotice: (message, error) => calls.push({ message, error }), refreshLikes: async () => {},
		apiErrorMessage: fallback => fallback
	});
	return { view, renderAuthState, body, window, history, calls, timers, document: context.document };
}

function form(values) {
	return { values, resets: 0, reset() { this.resets++; } };
}
const event = form => ({ preventDefault() {}, currentTarget: form });
const ok = data => ({ ok: true, json: async () => data });

test('admin update controls follow version availability without exposing technical configuration', async () => {
	const state = { enabled: true, online: true, phase: 'idle', currentVersion: 'v1', latestVersion: 'v2', updateAvailable: true };
	const requests = [];
	const h = harness(async (url, options) => { requests.push({ url, options }); return ok(state); });
	Object.assign(h.view, { currentUser: { role: 'admin' }, adminUpdateStatus: {}, adminUpdateVersions: {}, adminUpdateCheck: {}, adminUpdateInstall: {} });
	await h.view.fetchUpdateStatus();
	assert.equal(h.view.adminUpdateInstall.disabled, false);
	assert.match(h.view.adminUpdateVersions.textContent, /v1.*v2/);
	state.enabled = false;
	await h.view.fetchUpdateStatus();
	assert.equal(h.view.adminUpdateCheck.disabled, true); assert.equal(h.view.adminUpdateInstall.disabled, true);
	h.view.currentUser.role = 'user';
	await h.view.startAppUpdate('install');
	assert.equal(requests.length, 2);
});

test('integration controls show safe individual states and deduplicate explicit checks', async () => {
	let finish;
	const requests = [];
	const h = harness((url, options) => {
		requests.push({ url, options });
		return new Promise(resolve => { finish = resolve; });
	});
	const ids = ['admin-youtube-status', 'admin-spotify-status', 'admin-spotify-oauth-status', 'admin-integrations-last-check'];
	const elements = Object.fromEntries(ids.map(id => [id, element()]));
	h.document.getElementById = id => elements[id];
	h.view.currentUser = { id: 'manager', role: 'admin' };
	h.view.adminIntegrationCheck = {};
	const first = h.view.checkIntegrations();
	await h.view.checkIntegrations();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].options.method, 'POST');
	assert.equal(requests[0].options.credentials, 'include');
	assert.equal(h.view.adminIntegrationCheck.disabled, true);
	finish(ok({ checkedAt: '2026-10-05T12:00:00Z', connections: {
		youtube: { state: 'quota_exceeded' }, spotifyPublic: { state: 'connected' }, spotifyOAuth: { state: 'rejected' }
	}, private: 'synthetic-private-token' }));
	await first;
	assert.equal(elements['admin-youtube-status'].textContent, 'Quota dépassé');
	assert.equal(elements['admin-spotify-status'].textContent, 'Accessible');
	assert.equal(elements['admin-spotify-oauth-status'].textContent, 'Accès refusé');
	assert.equal(elements['admin-youtube-status'].dataset.state, 'quota_exceeded');
	assert.match(elements['admin-integrations-last-check'].textContent, /Dernière vérification/);
	assert.equal(h.view.adminIntegrationCheck.disabled, false);
	assert.ok(Object.values(elements).every(el => !/synthetic-private/.test(el.textContent)));
});

test('integration failures keep technical errors hidden and late results cannot update another account', async () => {
	const lastCheck = element();
	const h = harness(async () => ({ ok: false, status: 429, json: async () => { throw new Error('Unexpected body read'); } }));
	h.document.getElementById = id => id === 'admin-integrations-last-check' ? lastCheck : null;
	h.view.currentUser = { id: 'first', role: 'admin' };
	await h.view.checkIntegrations();
	assert.match(lastCheck.textContent, /Attends/);
	const late = harness(() => new Promise(resolve => { late.resolve = resolve; }));
	late.view.currentUser = { id: 'first', role: 'admin' };
	let rendered = 0;
	late.view.renderIntegrationStatus = () => { rendered++; };
	const request = late.view.checkIntegrations();
	late.view.currentUser = { id: 'second', role: 'user' };
	late.resolve(ok({ connections: {} }));
	await request;
	assert.equal(rendered, 0);
});

test('admin install keeps polling through a backend restart and reloads only after its own successful job', async () => {
	let offline = false, state = { enabled: true, online: true, phase: 'idle', requestId: 'old-job' };
	const requests = [];
	const h = harness(async (url, options) => {
		requests.push({ url, options });
		if (url.endsWith('/install')) return ok({ requestId: 'new-job' });
		if (offline) throw new Error('synthetic-private');
		return ok(state);
	});
	let reloads = 0; h.window.location.reload = () => { reloads++; };
	Object.assign(h.view, { currentUser: { role: 'admin' }, adminUpdateStatus: {}, adminUpdateVersions: {}, adminUpdateCheck: {}, adminUpdateInstall: {}, updateLatestVersion: 'v2' });
	await h.view.startAppUpdate('install');
	assert.deepEqual(JSON.parse(requests[0].options.body), { version: 'v2' });
	assert.equal(requests[0].options.credentials, 'include');
	assert.match(h.view.adminUpdateStatus.textContent, /attente/);
	offline = true;
	await h.view.fetchUpdateStatus();
	assert.equal(h.view.updateRequestId, 'new-job'); assert.equal(reloads, 0);
	assert.doesNotMatch(h.view.adminUpdateStatus.textContent, /synthetic-private/);
	offline = false; state = { ...state, phase: 'succeeded', requestId: 'new-job' };
	await h.view.fetchUpdateStatus();
	assert.equal(reloads, 1); assert.equal(h.view.updateRequestId, null);
});

test('an installation rollback and an expired session never trigger a successful-page reload', async () => {
	let state = { enabled: true, online: true, phase: 'failed', requestId: 'job', rolledBack: true };
	const h = harness(async () => state === null ? { status: 401 } : ok(state));
	let reloads = 0; h.window.location.reload = () => { reloads++; };
	Object.assign(h.view, { currentUser: { role: 'admin' }, adminUpdateStatus: {}, adminUpdateVersions: {}, adminUpdateCheck: {}, adminUpdateInstall: {}, updateRequestId: 'job', updateReloadRequested: true });
	await h.view.fetchUpdateStatus();
	assert.equal(reloads, 0); assert.match(h.view.adminUpdateStatus.textContent, /rétablie/);
	state = null;
	await h.view.fetchUpdateStatus();
	assert.equal(h.view.adminUpdateInstall.disabled, true);
});

test('provider and session refresh preserve cookie credentials and local authentication mode', async () => {
	const requests = [];
	const h = harness(async (url, options) => {
		requests.push({ url, options });
		return ok(url.endsWith('/providers') ? { spotify: { enabled: true } } : { authEnabled: false, user: null });
	});
	await h.view.refreshAuthProviders();
	assert.equal(h.view.spotifyOAuthEnabled, true);
	assert.equal(await h.view.refreshAuth(), true);
	assert.equal(h.view.authEnabled, false);
	assert.equal(h.view.currentUser, null);
	assert.ok(requests.every(({ url, options }) => url.startsWith('https://player.test/auth/') && options.credentials === 'include'));
	assert.equal(h.body.classList.contains('auth-required'), false);
});

test('successful login clears the entered password and opens the library with the returned account', async () => {
	const user = { id: 'synthetic-user', role: 'user' };
	const h = harness(async (url, options) => {
		assert.equal(url, 'https://player.test/auth/login');
		assert.equal(options.credentials, 'include');
		assert.deepEqual(JSON.parse(options.body), { pseudo: 'synthetic', password: 'synthetic-password' });
		return ok({ user });
	});
	h.view.loginPseudo = { value: 'synthetic' };
	h.view.loginPassword = { value: 'synthetic-password' };
	await h.view.handleLogin(event(null));
	assert.equal(h.view.currentUser, user);
	assert.equal(h.view.loginPassword.value, '');
	assert.ok(h.calls.includes('view:accueil'));
});

test('showing authentication clears stale tracks, likes and library preferences', () => {
	const h = harness();
	h.view.libraryPreferences = { pinned: ['old.json'], recent: ['old.json'] };
	h.view.availablePlaylists = ['old.json'];
	h.view.draftPlaylists = new Set(['old.json']);
	h.view.authScreen = element();
	h.view.loginError = element();
	h.view.showAuth('Reconnecte-toi.');
	assert.equal(h.view.playlistLoadRevision, 5);
	assert.equal(h.view.likesRevision, 3);
	assert.equal(h.view.playlistTracks.length, 0);
	assert.equal(h.view.likedKeys.size, 0);
	assert.equal(h.view.availablePlaylists.length, 0);
	assert.equal(h.view.libraryPreferences.pinned.length, 0);
	assert.equal(h.view.draftPlaylists, null);
	assert.equal(h.view.authScreen.hidden, false);
	assert.equal(h.body.classList.contains('auth-required'), true);
});

test('logout clears account and playback state even if its HTTP request fails', async () => {
	const h = harness(async (_url, options) => { assert.equal(options.credentials, 'include'); throw new Error('Synthetic offline'); });
	const audio = { removeAttribute: name => h.calls.push('remove:' + name) };
	Object.assign(h.view, {
		lecteur: audio, currentUser: { id: 'synthetic' }, selectedPlaylists: ['old.json'], pendingPrefetchedTransitions: [{}],
		stopSpecialPlayback: async reason => h.calls.push('stop:' + reason),
		clearNextTrackPrefetch: () => h.calls.push('clear-prefetch'), renderUpcomingQueue: queue => assert.equal(queue.length, 0),
		pauseAudioWithDiagnostics: (target, reason) => { assert.equal(target, audio); h.calls.push('pause:' + reason); },
		closeNowPlaying: () => h.calls.push('close-player')
	});
	await h.view.logout();
	assert.equal(h.view.lecteur, audio);
	assert.equal(h.view.currentUser, null);
	assert.equal(h.view.selectedPlaylists.length, 0);
	assert.equal(h.view.pendingPrefetchedTransitions.length, 0);
	assert.ok(h.calls.includes('stop:logout'));
	assert.ok(h.calls.includes('pause:logout'));
	assert.ok(h.calls.includes('remove:src'));
});

test('password change rejects mismatched confirmation and resets the form only after success', async () => {
	const h = harness();
	const messages = [], requests = [];
	h.view.showPasswordChangeMessage = (...args) => messages.push(args);
	let success = false;
	h.view.apiFetch = async (path, method, payload) => { requests.push({ path, method, payload }); return success ? {} : null; };
	const f = form({ currentPassword: 'synthetic-old', newPassword: 'synthetic-new', confirmPassword: 'different' });
	await h.view.changeOwnPassword(event(f));
	assert.equal(requests.length, 0);
	assert.equal(messages.at(-1)[1], true);
	f.values.confirmPassword = f.values.newPassword;
	await h.view.changeOwnPassword(event(f));
	assert.equal(f.resets, 0);
	success = true;
	await h.view.changeOwnPassword(event(f));
	assert.equal(f.resets, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), { path: '/auth/password', method: 'POST', payload: { currentPassword: 'synthetic-old', newPassword: 'synthetic-new' } });
});

test('admin data is fetched only for admins and forms retain values after a rejected operation', async () => {
	const h = harness();
	const requests = [];
	h.view.apiFetch = async path => { requests.push(path); return []; };
	h.view.renderAdminUsers = () => {};
	h.view.renderAdminList = () => {};
	h.view.currentUser = { role: 'user' };
	await h.view.fetchAdminData();
	assert.deepEqual(requests, []);
	h.view.currentUser.role = 'admin';
	await h.view.fetchAdminData();
	assert.deepEqual(requests, ['/admin/users', '/admin/login_events', '/admin/audit_logs', '/admin/integrations']);
	const f = form({ pseudo: 'synthetic', password: 'synthetic-password', role: 'user', newPassword: 'synthetic-new' });
	f.dataset = { userId: 'synthetic/id' };
	h.view.apiFetch = async path => { requests.push(path); return null; };
	await h.view.createAdminUser(event(f));
	await h.view.resetAdminUserPassword(event(f));
	assert.equal(f.resets, 0);
	assert.equal(requests.at(-1), '/admin/users/synthetic%2Fid/password');
});

test('account rendering isolates controlled playback preferences and hides admin controls', () => {
	const h = harness();
	h.window.localStorage.getItem = key => key === 'controlledPlayback:first' ? 'true' : 'false';
	h.view.adminNav = element();
	h.view.renderSpotifyConnectPanel = () => {};
	h.view.renderAuthState = h.renderAuthState;
	h.view.currentUser = { id: 'first', role: 'admin' };
	h.view.renderAuthState();
	assert.equal(h.view.controlledPlayback, true);
	assert.equal(h.view.adminNav.hidden, false);
	assert.equal(h.body.classList.contains('management-only'), true);
	h.view.currentUser = { id: 'second', role: 'user' };
	h.view.renderAuthState();
	assert.equal(h.view.controlledPlayback, false);
	assert.equal(h.view.adminNav.hidden, true);
	assert.equal(h.body.classList.contains('management-only'), false);
});

test('admin login opens management without fetching personal likes or connecting Spotify', async () => {
	const h = harness(async () => ok({ user: { id: 'manager', role: 'admin' } }));
	h.view.loginPassword = { value: 'synthetic-password' };
	h.view.refreshLikes = () => { throw new Error('Unexpected music request'); };
	await h.view.handleLogin({ preventDefault() {} });
	assert.ok(h.calls.includes('view:admin'));
	const location = h.window.location.href;
	h.view.connectSpotify();
	assert.equal(h.window.location.href, location);
});

test('Spotify redirects clear only OAuth parameters and never display raw error details', () => {
	const h = harness();
	h.window.location.search = '?spotify_error=SYNTHETIC_PRIVATE_DETAIL&view=add_spotify&keep=1';
	assert.equal(h.view.handleSpotifyRedirectNotice(), 'add_spotify');
	assert.equal(h.history[0][2], '/player?keep=1#tab');
	assert.ok(h.calls.every(call => typeof call === 'string' || !call.message.includes('SYNTHETIC_PRIVATE_DETAIL')));
	h.view.connectSpotify();
	assert.equal(h.window.location.href, 'https://player.test/auth/spotify/start');
});
