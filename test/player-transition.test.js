import { publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitle as formatTrackTitleValue, getTrackArtwork as getTrackArtworkValue, playlistEntries as playlistEntriesValue } from '../src/client-utils.js';
import { bindQueueSwipe } from '../src/track-gestures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const controllerSource = (await readFile(new URL('../src/player-controller.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function', 'function');
const discoverySource = (await readFile(new URL('../src/discovery-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function', 'function');
const playerViewSource = (await readFile(new URL('../src/player-view.js', import.meta.url), 'utf8')).replace('export const', 'const');
const accountSource = (await readFile(new URL('../src/account-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/m, '').replace('export function', 'function');
const diagnosticSource = (await readFile(new URL('../src/audio-diagnostics.js', import.meta.url), 'utf8')).replace('export const', 'const');

const playlistSource = (await readFile(new URL('../src/playlist-view.js', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\n/, '').replace('export const', 'const');
const librarySource = (await readFile(new URL('../src/library-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export const', 'const');
function playerHarness() {
	const requests = [];
	const context = vm.createContext({
        bindQueueSwipe, publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitleValue, getTrackArtworkValue, playlistEntriesValue,
		URLSearchParams,
		console: { log() {}, debug() {}, error() {} },
		window: { location: { origin: 'https://player.test', search: '' }, localStorage: { getItem: () => null } },
		document: { hidden: true },
		fetch: (url) => {
			requests.push(url);
			return new Promise(() => {}); // Background network never responds.
		}
	});
	vm.runInContext(controllerSource + '\n' + discoverySource + '\n' + playerViewSource + '\n' + accountSource + '\n' + playlistSource + '\n' + librarySource + '\n' + diagnosticSource + '\n' + source.slice(source.indexOf('const API_URL'), source.indexOf('export { App }')) + '\nglobalThis.app = App;', context);
	const app = context.app;
	const calls = [];
	app.lecteur = app.specialPlayer = {
		currentSrc: 'https://player.test/audio/first', src: 'https://player.test/audio/first',
		pause: () => calls.push('pause'),
		removeAttribute: () => calls.push('remove-src'),
		load: () => calls.push('load')
	};
	app.currentSpecialStream = { id: 'first', nextEnabled: true };
	app.nextTrackPrefetch = { trackId: 1, path: '/play/1' };
	app.playPrefetchedNextTrack = async (track) => {
		app.nextSongLoading = true;
		calls.push(`play:${track.trackId}`);
	};
	app.showNotice = () => {};
	return { app, calls, requests };
}

test('a failed playlist selection does not discard the next queued selection', async () => {
	const { app } = playerHarness();
	const selections = [];
	app.applyLibraryPlaylists = async (names) => {
		selections.push(names[0]);
		if (names[0] === 'first') throw new Error('Selection failed');
		return true;
	};
	const first = app.selectLibraryPlaylists(['first']);
	const second = app.selectLibraryPlaylists(['second']);
	const results = await Promise.allSettled([first, second]);
	assert.equal(results[0].status, 'rejected');
	assert.equal(results[1].status, 'fulfilled');
	assert.equal(results[1].value, true);
	assert.deepEqual(selections, ['first', 'second']);
	assert.equal(app.queueEditPromise, null);
});

test('a failed playlist selection does not discard a queued track addition', async () => {
	const { app } = playerHarness();
	app.applyLibraryPlaylists = async () => { throw new Error('Selection failed'); };
	app.syncPrefetchedTransitions = async () => {};
	const requests = [];
	app.apiFetch = async (endpoint, method, body) => {
		requests.push({ endpoint, method, body });
		return null;
	};
	const results = await Promise.allSettled([
		app.selectLibraryPlaylists(['first']), app.enqueueNextSong(7)
	]);
	assert.equal(results[0].status, 'rejected');
	assert.equal(results[1].status, 'fulfilled');
	assert.equal(requests.length, 1);
	assert.equal(requests[0].endpoint, '/add_song_ecoute');
	assert.equal(requests[0].body.arg, 7);
	assert.equal(app.queueEditPromise, null);
});

for (const reason of ['ended', 'manual', 'media-session', 'error']) {
	test(`special-to-normal ${reason} starts without waiting for stop response`, async () => {
		const { app, calls, requests } = playerHarness();
		const transition = reason === 'ended' ? app.handleSpecialStreamEnded()
			: reason === 'error' ? app.handleSpecialStreamError()
			: app.advanceToNextSong(reason);
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(calls, ['play:1'], 'handoff must not clear/pause the persistent media element or wait for HTTP');
		assert.equal(requests.length, 1);
		assert.equal(app.currentSpecialStream, null);
		await transition;
	});
}

test('duplicate advance during transition does not consume another track', async () => {
	const { app, calls } = playerHarness();
	void app.advanceToNextSong('manual');
	void app.advanceToNextSong('ended');
	await Promise.resolve();
	assert.deepEqual(calls, ['play:1']);
});

test('explicit stop still clears the persistent audio element', async () => {
	const { app, calls } = playerHarness();
	await app.stopSpecialPlayback('stop', { notifyBackend: false });
	assert.deepEqual(calls, ['pause', 'remove-src', 'load']);
	assert.equal(app.currentSpecialStream, null);
});

test('disabling manual next does not prevent natural end from advancing', async () => {
	const { app, calls } = playerHarness();
	app.currentSpecialStream.nextEnabled = false;
	await app.advanceToNextSong('manual');
	assert.deepEqual(calls, []);
	await app.handleSpecialStreamEnded();
	assert.deepEqual(calls, ['play:1']);
});

for (const reason of ['ended', 'ended-after-wake']) {
	test(`repeat on ${reason} keeps the current track and prepared queue`, async () => {
		const { app, calls, requests } = playerHarness();
		app.repeatTrack = true;
		app.currentSpecialStream = null;
		app.restartCurrentTrack = () => calls.push('repeat');
		await app.advanceToNextSong(reason);
		assert.deepEqual(calls, ['repeat']);
		assert.equal(app.nextTrackPrefetch.trackId, 1);
		assert.deepEqual(requests, []);
	});
}

test('manual next still advances when repeat is enabled', async () => {
	const { app, calls } = playerHarness();
	app.repeatTrack = true;
	await app.advanceToNextSong('manual');
	assert.deepEqual(calls, ['play:1']);
});

test('repeat converts a finished private stream to the same downloaded track without advancing', async () => {
	const { app, calls } = playerHarness();
	app.repeatTrack = true;
	app.currentId = 0;
	app.stopSpecialPlayback = async () => { app.currentSpecialStream = null; };
	app.waitForTrackReady = async id => `/play/${id}`;
	app.loadAndPlayMainSource = async path => calls.push(path);
	await app.advanceToNextSong('ended');
	assert.deepEqual(calls, ['/play/0']);
	assert.equal(app.currentId, 0);
	assert.equal(app.nextTrackPrefetch.trackId, 1);
	assert.equal(app.nextSongLoading, false);
});

for (const time of [0, 3.99, 4, 12]) {
	test(`previous at ${time}s uses the strict four-second threshold`, async () => {
		const { app, calls } = playerHarness();
		app.lecteur.currentTime = time;
		app.restartCurrentTrack = () => calls.push('restart');
		app.syncPrefetchedTransitions = async () => {};
		app.apiFetch = async () => ({ previousId: 0 });
		app.nextSong = async reason => calls.push(reason);
		await app.previousTrack();
		assert.deepEqual(calls, [time < 4 ? 'previous' : 'restart']);
	});
}

test('previous restarts the first song when there is no listening history', async () => {
	const { app, calls } = playerHarness();
	app.lecteur.currentTime = 1;
	app.restartCurrentTrack = () => calls.push('restart');
	app.syncPrefetchedTransitions = async () => {};
	app.apiFetch = async () => ({ previousId: null });
	await app.previousTrack();
	assert.deepEqual(calls, ['restart']);
});

test('enqueue next preserves current playback and invalidates the old prefetch', async () => {
	const { app, calls } = playerHarness();
	app.currentId = 3;
	app.lastPlaybackState = { currentId: 3, current: { title: 'Current' }, random: false };
	app.syncPrefetchedTransitions = async () => {};
	app.apiFetch = async (path, method, body) => {
		calls.push([path, method, body.arg]);
		return { queue: [{ __sessionIndex: 7 }], random: false };
	};
	app.updatePlaybackUi = state => { app.lastPlaybackState = state; };
	app.prefetchUpcomingTrack = queue => calls.push(`prefetch:${queue[0].__sessionIndex}`);
	await app.enqueueNextSong(7);
	assert.deepEqual(calls, [['/add_song_ecoute', 'POST', 7], 'prefetch:7']);
	assert.equal(app.lastPlaybackState.currentId, 3);
	assert.equal(app.nextTrackPrefetch, null);
	assert.equal(app.queueEditPromise, null);
});

test('controlled playback applies only to immediate selection and serializes playlist clicks', async () => {
	const { app, calls } = playerHarness();
	app.controlledPlayback = true;
	app.syncPrefetchedTransitions = async () => {};
	app.updatePlaybackUi = () => {};
	app.prefetchUpcomingTrack = () => {};
	const bodies = [];
	app.apiFetch = async (_path, _method, body) => {
		bodies.push(body);
		return { currentId: 0, queue: [{ __sessionIndex: 7 }] };
	};
	app.nextSong = async reason => {
		assert.equal(app.queueEditPromise, null);
		assert.equal(app.nextTrackPrefetch, null);
		calls.push(reason);
	};
	await app.enqueueNextSong(7);
	assert.equal(bodies[0].controlled, undefined);
	await app.add_song_playlist(7);
	assert.equal(bodies[1].controlled, true);
	assert.deepEqual(calls, ['select']);
	const collection = [{ type: 'spotify', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' }];
	app.controlledPlayback = false;
	await app.enqueueNextSong(collection[0], { playNow: true, collection });
	assert.equal(bodies[2].controlled, undefined);
	assert.equal(bodies[2].collection, collection);
	assert.equal(bodies[2].collectionIndex, 0);
});

test('YouTube click selects immediately even when the private stream disables manual next', async () => {
	const { app, calls } = playerHarness();
	app.currentSpecialStream.nextEnabled = false;
	app.syncPrefetchedTransitions = async () => {};
	app.updatePlaybackUi = () => {};
	app.showPlayer = () => {};
	app.startSpecialPlayback = async () => calls.push('start-selected-stream');
	const song = { title: 'YouTube fixture', url: 'https://www.youtube.com/watch?v=test-video1', type: 'youtube' };
	app.apiFetch = async (path, method, body) => {
		calls.push(path);
		if (path === '/add_song_ecoute') {
			assert.equal(body.song, song);
			return { currentId: 0, queue: [{ ...song, __sessionIndex: 1 }] };
		}
		assert.equal(path, '/next_song?reason=select');
		assert.equal(app.queueEditPromise, null, 'selection must run outside the queue edit to avoid a deadlock');
		return { mode: 'special_stream', currentId: 1, stream_id: 'selected', current: song, queue: [] };
	};
	await app.enqueueNextSong(song, { playNow: true });
	assert.deepEqual(calls, ['/add_song_ecoute', '/next_song?reason=select', 'start-selected-stream']);
	assert.equal(app.currentId, 1);
	assert.equal(app.nextTrackPrefetch, null);
});

test('playlist selection leaves current audio and stream intact and replaces the prefetch', async () => {
    const { app, calls } = playerHarness();
    const stream = app.currentSpecialStream;
    const audio = app.lecteur;
    app.syncPrefetchedTransitions = async () => {};
    app.clearNextTrackPrefetch = () => calls.push('clear-prefetch');
    app.updatePlaybackUi = state => calls.push(`current:${state.currentId}`);
    app.prefetchUpcomingTrack = queue => calls.push(`prefetch:${queue[0].__sessionIndex}`);
    app.changeLibraryPreference = async () => {};
    app.apiFetch = async (path, method, body) => {
        assert.equal(path, '/playlist_used');
        assert.equal(body.preservePlayback, true);
        return { preserved: true, currentId: 0, queue: [{ __sessionIndex: 5 }] };
    };
    // DOM and timeout are supplied separately by this minimal VM harness.
    const contextSource = source.slice(source.indexOf('const API_URL'), source.indexOf('export { App }'));
    const context = vm.createContext({
        bindQueueSwipe, publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitleValue, getTrackArtworkValue, playlistEntriesValue,
        URLSearchParams, window: { location: { origin: 'https://player.test' } },
        document: { getElementById: () => ({ checked: false, style: {} }) },
        setTimeout: () => 0
    });
    vm.runInContext(controllerSource + '\n' + discoverySource + '\n' + playerViewSource + '\n' + accountSource + '\n' + playlistSource + '\n' + librarySource + '\n' + diagnosticSource + '\n' + contextSource + '\nglobalThis.methods = App;', context);
    app.applyLibraryPlaylists = context.methods.applyLibraryPlaylists;
    assert.equal(await app.selectLibraryPlaylists(['new.json']), true);
    assert.equal(app.lecteur, audio);
    assert.equal(app.currentSpecialStream, stream);
    assert.equal(app.queueEditPromise, null);
    assert.deepEqual(calls, ['clear-prefetch', 'current:0', 'prefetch:5']);
});
