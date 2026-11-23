import { artistView, artistLinksMarkup } from '../src/artist-view.js';
import { lyricsView } from '../src/lyrics-view.js';
import { publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitle as formatTrackTitleValue, getTrackArtwork as getTrackArtworkValue, playlistEntries as playlistEntriesValue, spotifyTrackIdForSource, youtubeVideoIdForSource } from '../src/client-utils.js';
import { bindQueueSwipe } from '../src/track-gestures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sponsorSource = (await readFile(new URL('../src/sponsorblock.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export const', 'const');
const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const controllerSource = (await readFile(new URL('../src/player-controller.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function', 'function');
const discoverySource = (await readFile(new URL('../src/discovery-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function', 'function');
const playerViewSource = (await readFile(new URL('../src/player-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export const', 'const');
const accountSource = (await readFile(new URL('../src/account-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/m, '').replace('export function', 'function');
const diagnosticSource = (await readFile(new URL('../src/audio-diagnostics.js', import.meta.url), 'utf8')).replace('export const', 'const');

const playlistSource = (await readFile(new URL('../src/playlist-view.js', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\n/, '').replace(/^import .*;\n/gm, '').replace('export const', 'const');
const librarySource = (await readFile(new URL('../src/library-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export const', 'const');
function playerHarness() {
	const requests = [];
	const noticeTimers = [];
	const context = vm.createContext({ artistView, artistLinksMarkup, lyricsView,
        bindQueueSwipe, publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitleValue, getTrackArtworkValue, playlistEntriesValue,
		URLSearchParams,
		console: { log() {}, debug() {}, error() {} },
		window: { location: { origin: 'https://player.test', search: '' }, localStorage: { getItem: () => null } },
		document: { hidden: true },
		setTimeout: callback => {
			noticeTimers.push(callback);
			return noticeTimers.length;
		},
		clearTimeout: () => {},
		fetch: (url) => {
			requests.push(url);
			return new Promise(() => {}); // Background network never responds.
		}
	});
	vm.runInContext(sponsorSource + '\n' + controllerSource + '\n' + discoverySource + '\n' + playerViewSource + '\n' + accountSource + '\n' + playlistSource + '\n' + librarySource + '\n' + diagnosticSource + '\n' + source.slice(source.indexOf('const API_URL'), source.indexOf('export { App }')) + '\nglobalThis.app = App;', context);
	const app = context.app;
	const calls = [];
	// Exposed before the harness stubs below replace the methods on the app.
	const playPrefetchedNextTrack = app.playPrefetchedNextTrack.bind(app);
	const showNotice = app.showNotice.bind(app);
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
	return { app, calls, requests, playPrefetchedNextTrack, showNotice, noticeTimers };
}

test('replacing a pending source with a private stream does not retry the old source or report a failure', async () => {
	const { app } = playerHarness();
	const notices = [], prefetched = [], sources = [];
	const audio = app.lecteur;
	app.currentSpecialStream = null;
	app.showNotice = message => notices.push(message);
	app.requestWakeLock = () => {};
	app.prefetchUpcomingTrack = queue => prefetched.push(queue);
	let rejectOld;
	audio.play = () => {
		sources.push(audio.src);
		return sources.length === 1 ? new Promise((resolve, reject) => { rejectOld = reject; }) : Promise.resolve();
	};
	audio.load = () => {
		if (rejectOld) {
			rejectOld(Object.assign(new Error('Media fetching was aborted'), { name: 'AbortError' }));
			rejectOld = null;
		}
	};
	audio.removeAttribute = () => { audio.src = ''; };
	const old = app.loadAndPlayMainSource('/play/0');
	await app.startSpecialPlayback({ stream_id: 'selected', audio_url: '/audio/selected', queue: [] });
	assert.equal(await old, null);
	assert.deepEqual(sources, ['https://player.test/play/0', 'https://player.test/audio/selected']);
	assert.deepEqual(notices, []);
	assert.equal(prefetched.length, 1);
	assert.equal(app.lastPlayRejection, null);
	assert.equal(audio.src, 'https://player.test/audio/selected');
});

test('an intentional pause cancels a pending play without reporting an audio failure', async () => {
	const { app } = playerHarness();
	const notices = [];
	app.showNotice = message => notices.push(message);
	let rejectPlay;
	app.lecteur.play = () => new Promise((resolve, reject) => { rejectPlay = reject; });
	app.lecteur.pause = () => rejectPlay(Object.assign(new Error('Paused'), { name: 'AbortError' }));
	const playing = app.playAudioWithDiagnostics(app.lecteur);
	app.pauseAudioWithDiagnostics(app.lecteur, 'play-pause-control');
	assert.equal(await playing, null);
	assert.deepEqual(notices, []);
});

test('a real failure of the current play attempt still reports the audio error', async () => {
	const { app } = playerHarness();
	const notices = [];
	app.showNotice = message => notices.push(message);
	const error = Object.assign(new Error('Unsupported audio'), { name: 'NotSupportedError' });
	app.lecteur.play = () => Promise.reject(error);
	assert.equal(await app.playAudioWithDiagnostics(app.lecteur), false);
	assert.equal(app.lastPlayRejection, error);
	assert.deepEqual(notices, ['La lecture audio n’a pas pu démarrer.']);
});

for (const outcome of ['resolve', 'reject']) {
	test(`an obsolete play that ${outcome}s cannot overwrite the current attempt's error`, async () => {
		const { app } = playerHarness();
		const notices = [];
		app.showNotice = message => notices.push(message);
		let finishOld;
		app.lecteur.play = () => new Promise((resolve, reject) => {
			finishOld = () => outcome === 'resolve' ? resolve() : reject(Object.assign(new Error('Replaced'), { name: 'AbortError' }));
		});
		const old = app.playAudioWithDiagnostics(app.lecteur);
		const error = Object.assign(new Error('Unsupported audio'), { name: 'NotSupportedError' });
		app.lecteur.play = () => Promise.reject(error);
		assert.equal(await app.playAudioWithDiagnostics(app.lecteur), false);
		finishOld();
		assert.equal(await old, null);
		assert.equal(app.lastPlayRejection, error);
		assert.equal(notices.length, 1);
	});
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

test('failed Spotify startup waits for the same cached track instead of skipping it', async () => {
	const { app, calls } = playerHarness();
	app.currentId = 7;
	app.lastPlaybackState = { current: { type: 'spotify' } };
	app.waitForTrackReady = async (id, timeout, { isCurrent }) => {
		assert.equal(id, 7);
		assert.equal(isCurrent(), true);
		return '/play/7';
	};
	app.loadAndPlayMainSource = async path => { calls.push(path); return true; };
	await app.handleSpecialStreamError();
	assert.deepEqual(calls, ['/play/7']);
	assert.equal(app.currentId, 7);
	assert.equal(app.spotifyStreamRecovery, null);
});

test('Spotify recovery does not replace a track selected while waiting', async () => {
	const { app, calls } = playerHarness();
	app.currentId = 7;
	app.lastPlaybackState = { current: { type: 'spotify' } };
	app.waitForTrackReady = async () => { app.currentId = 8; return '/play/7'; };
	await app.handleSpecialStreamError();
	assert.deepEqual(calls, []);
});

test('exhausted Spotify recovery advances only after the same-track download fails', async () => {
	const { app, calls } = playerHarness();
	app.currentId = 7;
	app.lastPlaybackState = { current: { type: 'spotify' } };
	app.waitForTrackReady = async () => null;
	await app.handleSpecialStreamError();
	assert.deepEqual(calls, ['play:1']);
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

test('only listen-next requests mark the queue insertion as pending priority', async () => {
	const { app } = playerHarness();
	app.syncPrefetchedTransitions = async () => {};
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.prefetchUpcomingTrack = () => {};
	app.nextSong = async () => {};
	const bodies = [];
	app.apiFetch = async (_path, _method, body) => {
		bodies.push({ ...body });
		return { currentId: 3, queue: [{ __sessionIndex: 7 }] };
	};
	await app.enqueueNextSong(7);
	await app.enqueueNextSong(7, { playNow: true });
	app.controlledPlayback = true;
	await app.enqueueNextSong(7, { playNow: true });
	assert.deepEqual(bodies, [
		{ arg: 7, enqueue: true },
		{ arg: 7 },
		{ arg: 7, controlled: true }
	]);
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
    const context = vm.createContext({ artistView, artistLinksMarkup, lyricsView,
        bindQueueSwipe, publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitleValue, getTrackArtworkValue, playlistEntriesValue,
        URLSearchParams, window: { location: { origin: 'https://player.test' } },
        document: { getElementById: () => ({ checked: false, style: {} }) },
        setTimeout: () => 0
    });
    vm.runInContext(sponsorSource + '\n' + controllerSource + '\n' + discoverySource + '\n' + playerViewSource + '\n' + accountSource + '\n' + playlistSource + '\n' + librarySource + '\n' + diagnosticSource + '\n' + contextSource + '\nglobalThis.methods = App;', context);
    app.applyLibraryPlaylists = context.methods.applyLibraryPlaylists;
    assert.equal(await app.selectLibraryPlaylists(['new.json']), true);
    assert.equal(app.lecteur, audio);
    assert.equal(app.currentSpecialStream, stream);
    assert.equal(app.queueEditPromise, null);
    assert.deepEqual(calls, ['clear-prefetch', 'current:0', 'prefetch:5']);
});

test('the mini shuffle button mirrors the pressed state and shares the request guard', async () => {
    const elements = new Map();
    const elementFor = id => {
        if (!elements.has(id)) {
            elements.set(id, {
                checked: false,
                disabled: false,
                attributes: {},
                setAttribute(name, value) { this.attributes[name] = value; }
            });
        }
        return elements.get(id);
    };
    // DOM and timeout are supplied separately by this minimal VM harness.
    const contextSource = source.slice(source.indexOf('const API_URL'), source.indexOf('export { App }'));
    const context = vm.createContext({ artistView, artistLinksMarkup, lyricsView,
        bindQueueSwipe, publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitleValue, getTrackArtworkValue, playlistEntriesValue,
        URLSearchParams, window: { location: { origin: 'https://player.test' } },
        document: { getElementById: elementFor },
        setTimeout: () => 0
    });
    vm.runInContext(sponsorSource + '\n' + controllerSource + '\n' + discoverySource + '\n' + playerViewSource + '\n' + accountSource + '\n' + playlistSource + '\n' + librarySource + '\n' + diagnosticSource + '\n' + contextSource + '\nglobalThis.methods = App;', context);
    const app = context.methods;
    app.updatePlaybackUi = () => {};
    app.clearNextTrackPrefetch = () => {};
    app.prefetchUpcomingTrack = () => {};
    app.selectedPlaylists = ['mix.json'];
    const disabledDuringRequest = {};
    app.apiFetch = async (path, method, body) => {
        assert.equal(path, '/random');
        disabledDuringRequest.shuffle = elementFor('miniShuffle').disabled;
        disabledDuringRequest.overlay = elementFor('overlayShuffle').disabled;
        return { currentId: 0, queue: [], random: body.enabled };
    };
    app.updateShuffleUi(true);
    assert.equal(elementFor('miniShuffle').attributes['aria-pressed'], 'true');
    assert.equal(elementFor('overlayShuffle').attributes['aria-pressed'], 'true');
    assert.equal(elementFor('miniShuffle').attributes['title'], 'Désactiver la lecture aléatoire');
    await app.setShuffleMode(false);
    assert.equal(elementFor('miniShuffle').disabled, false, 'the mini button is usable again after the request');
    assert.equal(elementFor('overlayShuffle').disabled, false);
    assert.deepEqual(disabledDuringRequest, { shuffle: true, overlay: true }, 'all controls share the busy guard');
    assert.equal(elementFor('miniShuffle').attributes['aria-pressed'], 'false', 'the server state wins');
});

test('media and private-stream failures report the failed track without waiting for telemetry', async () => {
	for (const special of [false, true]) {
		const { app, calls } = playerHarness();
		const reports = [];
		app.currentId = '0';
		app.lastPlaybackState = { current: { type: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' } };
		app.apiFetch = (endpoint, method, body) => { reports.push({ endpoint, method, body }); return new Promise(() => {}); };
		if (!special) app.currentSpecialStream = null;
		await (special ? app.handleSpecialStreamError() : app.handleMainAudioError());
		assert.equal(reports.length, 1);
		assert.equal(reports[0].endpoint, '/playback/unplayable');
		assert.equal(reports[0].body.key, 'youtube:abcdefghijk');
		assert.equal(reports[0].body.trackId, 0);
		assert.equal(reports[0].body.reason, special ? 'stream_error' : 'media_error');
		assert.deepEqual(calls, ['play:1']);
	}
});

test('failed readiness and play attempts report each skipped track but autoplay blocks do not', async () => {
	for (const failure of ['not_ready', 'play_failed', 'autoplay']) {
		const { app } = playerHarness();
		const reports = [];
		let index = 0;
		app.currentSpecialStream = null;
		app.nextTrackPrefetch = null;
		app.showPlayer = () => {};
		app.updatePlaybackUi = data => { app.lastPlaybackState = data; };
		app.waitForTrackReady = async () => failure === 'not_ready' ? null : '/play/fixture';
		app.loadAndPlayMainSource = async () => {
			app.lastPlayRejection = { name: failure === 'autoplay' ? 'NotAllowedError' : 'NotSupportedError' };
			return false;
		};
		app.apiFetch = async (endpoint, method, body) => {
			if (endpoint === '/playback/unplayable') { reports.push(body); return {}; }
			assert.equal(endpoint, '/next_song');
			return { currentId: index++, current: { type: 'youtube', id: 'abcdefghijk' }, queue: [], path: '/play/fixture' };
		};
		await app.nextSong();
		assert.equal(reports.length, failure === 'autoplay' ? 0 : 3);
		assert.deepEqual(reports.map(report => report.trackId), failure === 'autoplay' ? [] : [0, 1, 2]);
		assert.equal(reports.every(report => report.reason === failure), true);
	}
});

test('successful Spotify fallback and manual skips do not report an unplayable track', async () => {
	const { app } = playerHarness();
	const reports = [];
	app.currentId = 0;
	app.lastPlaybackState = { current: { type: 'spotify', url: 'https://open.spotify.com/track/' + 'A'.repeat(22) } };
	app.apiFetch = async (...args) => { reports.push(args); return {}; };
	app.waitForTrackReady = async () => '/play/0';
	app.loadAndPlayMainSource = async () => true;
	await app.handleSpecialStreamError();
	assert.deepEqual(reports, []);
	await app.advanceToNextSong('manual');
	assert.deepEqual(reports, []);
});

test('a prefetched track that fails to play reports once after its transition is accepted', async () => {
	const { app, playPrefetchedNextTrack } = playerHarness();
	const reports = [];
	app.currentSpecialStream = null;
	app.currentId = 0;
	app.lastPlaybackState = { currentId: 0, current: { type: 'youtube', id: 'currentclip' }, queue: [] };
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.showPlayer = () => {};
	app.advanceToNextSong = async () => {};
	app.loadAndPlayMainSource = async () => {
		app.lastPlayRejection = { name: 'NotSupportedError', message: 'unsupported' };
		return false;
	};
	app.syncPrefetchedTransitions = async () => { app.pendingPrefetchedTransitions.shift(); };
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	const prefetched = { trackId: 3, path: '/play/3', track: { type: 'youtube', id: 'nextclip', __sessionIndex: 3 } };
	await playPrefetchedNextTrack(prefetched, 'ended');
	assert.equal(reports.length, 1);
	assert.equal(reports[0].reason, 'play_failed');
	assert.equal(reports[0].trackId, 3);
	assert.equal(reports[0].key, 'youtube:nextclip');
	assert.equal(app.nextSongLoading, false);
});

test('a rejected transition sync, an autoplay block or an abort never report a prefetched failure', async () => {
	for (const rejectionName of ['NotAllowedError', 'NotSupportedError', 'AbortError']) {
		const { app, playPrefetchedNextTrack } = playerHarness();
		const reports = [];
		app.currentSpecialStream = null;
		app.currentId = 0;
		app.lastPlaybackState = { currentId: 0, current: { type: 'youtube', id: 'currentclip' }, queue: [] };
		app.updatePlaybackUi = () => {};
		app.showNotice = () => {};
		app.showPlayer = () => {};
		app.advanceToNextSong = async () => {};
		app.loadAndPlayMainSource = async () => {
			app.lastPlayRejection = { name: rejectionName };
			return false;
		};
		// The sync leaves the transition pending: the server rejected it.
		app.syncPrefetchedTransitions = async () => {};
		app.apiFetch = async (endpoint, method, body) => {
			if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
			return {};
		};
		// An abort still runs the existing sync and advance control; it only
		// must not create a failure report.
		await playPrefetchedNextTrack({ trackId: 3, path: '/play/3', track: { type: 'youtube', id: 'nextclip' } }, 'ended');
		assert.equal(reports.length, 0, rejectionName);
		assert.equal(app.pendingPrefetchedTransitions.length, 1, rejectionName);
	}
});

test('a definitive manual play failure reports once and the media error path keeps its handling', async () => {
	const { app, calls } = playerHarness();
	const reports = [];
	app.currentSpecialStream = null;
	app.currentId = 2;
	app.lastPlaybackState = { currentId: 2, current: { type: 'youtube', id: 'brokensource' }, queue: [] };
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.advanceToNextSong = async reason => { calls.push(`advance:${reason}`); };
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	const audio = app.lecteur;
	audio.paused = true;
	audio.play = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotSupportedError' }));
	await app.restartCurrentTrack();
	assert.equal(reports.length, 1);
	assert.equal(reports[0].reason, 'play_failed');
	assert.equal(reports[0].trackId, 2);
	assert.equal(reports[0].key, 'youtube:brokensource');
	assert.equal(app.playFailureReportedKey, `2:${audio.currentSrc}`);
	// A later media error on the same source adds no duplicate report and
	// keeps its own error handling, including the advance.
	audio.error = { code: 4 };
	await app.handleMainAudioError();
	assert.equal(reports.length, 1);
	assert.deepEqual(calls, ['advance:error']);
	assert.equal(app.consecutivePlaybackErrors, 1);
});

test('blocked autoplay and aborted manual plays never report a failure', async () => {
	for (const name of ['NotAllowedError', 'AbortError']) {
		const { app } = playerHarness();
		const reports = [];
		app.currentSpecialStream = null;
		app.currentId = 2;
		app.lastPlaybackState = { currentId: 2, current: { type: 'youtube', id: 'brokensource' }, queue: [] };
		app.updatePlaybackUi = () => {};
		app.showNotice = () => {};
		app.apiFetch = async (endpoint, method, body) => {
			if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
			return {};
		};
		const audio = app.lecteur;
		audio.paused = true;
		audio.play = () => Promise.reject(Object.assign(new Error('x'), { name }));
		await app.restartCurrentTrack();
		assert.equal(reports.length, 0, name);
		assert.equal(app.playFailureReportedKey ?? null, null, name);
	}
});

test('the play/pause toggle reports a definitive failure through the shared helper', async () => {
	const { app } = playerHarness();
	const reports = [];
	app.currentSpecialStream = null;
	app.currentId = 5;
	app.lastPlaybackState = { currentId: 5, current: { type: 'youtube', id: 'toggleclip' }, queue: [] };
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	const audio = app.lecteur;
	audio.paused = true;
	audio.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
	app.togglePlayback();
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
	assert.equal(reports.length, 1);
	assert.equal(reports[0].reason, 'play_failed');
	assert.equal(reports[0].trackId, 5);
	assert.equal(reports[0].key, 'youtube:toggleclip');
});

test('a terminal toggle rejection on the current special stream follows the stream failure routine', async () => {
	const { app, calls } = playerHarness();
	const reports = [];
	app.currentId = 1;
	app.lastPlaybackState = { currentId: 1, current: { type: 'youtube', id: 'streamclip' }, queue: [] };
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.advanceToNextSong = async reason => { calls.push(`advance:${reason}`); };
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	const stream = { id: 'live', nextEnabled: true };
	app.currentSpecialStream = stream;
	const audio = app.specialPlayer;
	audio.paused = true;
	audio.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
	app.togglePlayback();
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
	assert.equal(reports.length, 1);
	assert.equal(reports[0].reason, 'stream_error');
	assert.equal(reports[0].trackId, 1);
	assert.equal(reports[0].key, 'youtube:streamclip');
	assert.deepEqual(calls, ['advance:error']);
	// The per-stream guard keeps a later error event from repeating it.
	assert.equal(stream.failureHandled, true);
	await app.handleSpecialStreamError();
	assert.equal(reports.length, 1);
	assert.deepEqual(calls, ['advance:error']);
});

test('a media-session play without an audio player returns false without reporting', async () => {
	const { app } = playerHarness();
	const reports = [];
	app.currentSpecialStream = null;
	app.currentId = 1;
	app.lastPlaybackState = { currentId: 1, current: { type: 'youtube', id: 'nullclip' }, queue: [] };
	app.showNotice = () => {};
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	assert.equal(await app.playCurrentTrackWithReporting(null, { trigger: 'media-session-play' }), false);
	assert.equal(reports.length, 0);
});

test('manual source helpers refuse implicit values and derive the key from the Spotify url only', () => {
	assert.equal(spotifyTrackIdForSource({
		type: 'spotify', id: 'yt123456789',
		url: 'https://open.spotify.com/track/' + 'B'.repeat(22)
	}), 'B'.repeat(22), 'a resolved YouTube id never affects the derived key');
	assert.equal(spotifyTrackIdForSource({ type: 'spotify', url: 'http://open.spotify.com/track/' + 'B'.repeat(22) }), null);
	assert.equal(spotifyTrackIdForSource({ type: 'youtube', url: 'https://open.spotify.com/track/' + 'B'.repeat(22) }), null);
	assert.equal(youtubeVideoIdForSource(['https://www.youtube.com/watch?v=abcdefghijk']), null, 'arrays are never coerced');
	assert.equal(youtubeVideoIdForSource({ href: 'https://www.youtube.com/watch?v=abcdefghijk' }), null, 'objects are never coerced');
	assert.equal(youtubeVideoIdForSource('https://youtu.be/abcdefghijk'), 'abcdefghijk');
	assert.equal(youtubeVideoIdForSource('https://music.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
});

test('the manual source menu entry appears only for eligible spotify tracks of user accounts', () => {
	const created = [];
	const elementFactory = () => ({
		innerHTML: '', className: '', style: {}, dataset: {},
		addEventListener(type, handler) { this.listeners ||= {}; this.listeners[type] = handler; },
		querySelector: () => null,
		getBoundingClientRect: () => ({ bottom: 10, right: 10, width: 0, height: 0 }),
		focus() {}, remove() {}, contains: () => false
	});
	const context = vm.createContext({ artistView, artistLinksMarkup, lyricsView,
		bindQueueSwipe, publicErrorMessage, LIKED_PLAYLIST, trackLikeKey, formatTrackTitleValue, getTrackArtworkValue, playlistEntriesValue,
		spotifyTrackIdForSource, youtubeVideoIdForSource,
		URLSearchParams, window: { location: { origin: 'https://player.test' }, open: () => {}, innerWidth: 400, innerHeight: 800 },
		document: {
			getElementById: () => null,
			createElement: () => { const element = elementFactory(); created.push(element); return element; },
			body: { appendChild: () => {} }
		},
		fetch: () => new Promise(() => {})
	});
	const contextSource = source.slice(source.indexOf('const API_URL'), source.indexOf('export { App }'));
	vm.runInContext(sponsorSource + '\n' + controllerSource + '\n' + discoverySource + '\n' + playerViewSource + '\n' + accountSource + '\n' + playlistSource + '\n' + librarySource + '\n' + diagnosticSource + '\n' + contextSource + '\nglobalThis.methods = App;', context);
	const app = context.methods;
	const spotifyTrack = {
		type: 'spotify', title: 'Dans la vibe',
		url: 'https://open.spotify.com/track/' + 'A'.repeat(22)
	};
	const anchor = elementFactory();

	app.currentUser = { id: 'u1', role: 'user' };
	app.openSongActionMenu(anchor, spotifyTrack, { discovered: true });
	assert.match(created.at(-1).innerHTML, /data-action="source"/, 'a user with a valid Spotify track sees the entry');

	app.currentUser = { id: 'u2', role: 'admin' };
	app.openSongActionMenu(anchor, spotifyTrack, { discovered: true });
	assert.doesNotMatch(created.at(-1).innerHTML, /data-action="source"/, 'admin accounts never manage sources');

	app.currentUser = null;
	app.openSongActionMenu(anchor, spotifyTrack, { discovered: true });
	assert.doesNotMatch(created.at(-1).innerHTML, /data-action="source"/, 'anonymous sessions never manage sources');

	app.currentUser = { id: 'u3', role: 'user' };
	app.openSongActionMenu(anchor, { type: 'youtube', title: 'Clip', url: 'https://www.youtube.com/watch?v=yt123456789' }, { discovered: true });
	assert.doesNotMatch(created.at(-1).innerHTML, /data-action="source"/, 'non-spotify tracks never show the entry');
});

test('floating error notices never show while confirmations still appear', async () => {
	const { app, showNotice, noticeTimers } = playerHarness();
	const toggles = [];
	const banner = {
		hidden: true,
		innerText: '',
		classList: { toggle: (name, value) => toggles.push([name, value]) }
	};
	app.appNotice = banner;
	showNotice('Connexion perdue', true);
	assert.equal(banner.hidden, true, 'an error notice must not reveal the banner');
	assert.deepEqual(toggles, [], 'the error class is never applied anymore');
	showNotice('Musique ajoutée aux prochains titres.');
	assert.equal(banner.hidden, false);
	assert.equal(banner.innerText, 'Musique ajoutée aux prochains titres.');
	assert.equal(noticeTimers.length, 1, 'only the confirmation schedules an auto-hide');
	noticeTimers[0]();
	assert.equal(banner.hidden, true);
});

test('the floating notice never blocks clicks and keeps a single style', async () => {
	const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
	assert.equal(css.includes('.app-notice.is-error'), false, 'the dead error rule is gone');
	const rule = css.slice(css.indexOf('.app-notice {'), css.indexOf('.file-input'));
	assert.match(rule, /pointer-events:\s*none/, 'the remaining notice can never intercept clicks');
});

test('a lone terminal rejection of a special stream start reports once and a later error event is deduped', async () => {
	const { app, calls } = playerHarness();
	const reports = [];
	app.currentSpecialStream = null;
	app.currentId = 1;
	app.lastPlaybackState = { currentId: 1, current: { type: 'youtube', id: 'firstclip' }, queue: [] };
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.requestWakeLock = () => {};
	app.prefetchUpcomingTrack = () => {};
	app.advanceToNextSong = async reason => { calls.push(`advance:${reason}`); };
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	app.specialPlayer.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
	await app.startSpecialPlayback({ stream_id: 'stream-one', audio_url: '/audio/stream-one', first_track_next_enabled: true, queue: [] });
	assert.equal(reports.length, 1);
	assert.equal(reports[0].reason, 'stream_error');
	assert.equal(reports[0].trackId, 1);
	assert.equal(reports[0].key, 'youtube:firstclip');
	assert.deepEqual(calls, ['pause', 'remove-src', 'load', 'advance:error']);
	// The per-stream guard stops a late error event from repeating the routine.
	await app.handleSpecialStreamError();
	assert.equal(reports.length, 1);
	assert.deepEqual(calls, ['pause', 'remove-src', 'load', 'advance:error']);
});

test('a lone rejection of a spotify stream recovers and never reports a failure', async () => {
	const { app } = playerHarness();
	const reports = [];
	app.currentSpecialStream = null;
	app.currentId = 1;
	app.lastPlaybackState = { currentId: 1, current: { type: 'spotify', id: 'spotify-track' }, queue: [] };
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.requestWakeLock = () => {};
	app.prefetchUpcomingTrack = () => {};
	app.waitForTrackReady = async () => '/play/recovered';
	app.loadAndPlayMainSource = async () => true;
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	app.specialPlayer.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
	await app.startSpecialPlayback({ stream_id: 'stream-two', audio_url: '/audio/stream-two', first_track_next_enabled: true, queue: [] });
	assert.equal(reports.length, 0);
	assert.equal(app.spotifyStreamRecovery, null);
	// A late error event must not add a report once the recovery completed.
	app.currentSpecialStream = { id: 'stream-two', failureHandled: true, nextEnabled: true };
	await app.handleSpecialStreamError();
	assert.equal(reports.length, 0);
});

test('a failing special-stream repeat reports the unavailable track', async () => {
	const { app } = playerHarness();
	const reports = [];
	app.currentSpecialStream = { id: 'first', nextEnabled: true };
	app.currentId = 1;
	app.lastPlaybackState = { currentId: 1, current: { type: 'spotify', id: 'spotify-repeat' }, queue: [] };
	app.updatePlaybackUi = () => {};
	app.showNotice = () => {};
	app.stopSpecialPlayback = async () => {};
	app.waitForTrackReady = async () => null;
	app.apiFetch = async (endpoint, method, body) => {
		if (endpoint === '/playback/unplayable') { reports.push({ ...body }); return {}; }
		return {};
	};
	await app.repeatCurrentTrack();
	assert.equal(reports.length, 1);
	assert.equal(reports[0].reason, 'not_ready');
	assert.equal(reports[0].trackId, 1);
	assert.equal(reports[0].key, 'spotify:spotify-repeat');
	assert.equal(app.nextSongLoading, false);
});
