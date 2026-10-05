import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildInitialQueue,
	buildControlledQueue,
	gestion_ecoute,
	getUpcomingQueue,
	getPlaybackCacheEvictions,
	listen_after,
	playbackState,
	rememberCurrentTrack,
	takePreviousTrack,
	preloadUpcomingSongs,
	removeSongFromSessionQueue,
	sessionTrackKey,
	shuffleArray,
	syncSessionQueue,
	stablePlaylistTracks
} from '../../src/server/queue.js';

function track(title, playlist = 'mix.json', index = 0, type = 'youtube') {
	return {
		title,
		type,
		__playlist: playlist,
		__playlistIndex: index
	};
}

test('shuffleArray mutates and returns the same array with deterministic random support', () => {
	const values = [0, 1, 2, 3];
	const result = shuffleArray(values, () => 0);
	assert.equal(result, values);
	assert.deepEqual(result, [1, 2, 3, 0]);
});

test('buildInitialQueue returns descending playback order and can shuffle it', () => {
	assert.deepEqual(buildInitialQueue(4, false), [3, 2, 1, 0]);
	assert.deepEqual(buildInitialQueue(4, true, () => 0), [2, 1, 0, 3]);
});

test('controlled playback rotates all source tracks and skips the previous current occurrence', () => {
	const ids = Array.from({ length: 12 }, (_, i) => i);
	assert.deepEqual(buildControlledQueue(ids, 7, 0).reverse(), [7, 8, 9, 10, 11, 1, 2, 3, 4, 5, 6]);
	assert.deepEqual(buildControlledQueue(ids, 11, 0).reverse(), [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.deepEqual(buildControlledQueue([4], 4, 4), [4]);
	assert.deepEqual(buildControlledQueue([4, 8, 13], 8, 8).reverse(), [8, 13, 4]);
	assert.throws(() => buildControlledQueue([4, 8], 13), /absent/);
});

test('sessionTrackKey identifies tracks by source playlist and position', () => {
	assert.equal(sessionTrackKey(track('One', 'a.json', 4)), 'a.json:4');
	assert.equal(sessionTrackKey(null), 'undefined:undefined');
});

test('syncSessionQueue initializes a new session queue', () => {
	const req = { session: { random: false } };
	syncSessionQueue(req, [track('One', 'a.json', 0), track('Two', 'a.json', 1)]);

	assert.equal(req.session.queue_initialized, true);
	assert.deepEqual(req.session.list_order, [1, 0]);
	assert.deepEqual(req.session.items.map((item) => item.title), ['One', 'Two']);
	assert.equal(req.session.ecoute_actuelle, undefined);
});

test('syncSessionQueue preserves current and queued tracks after playlist updates', () => {
	const req = {
		session: {
			random: false,
			queue_initialized: true,
			items: [track('One', 'a.json', 0), track('Two', 'a.json', 1)],
			list_order: [1],
			ecoute_actuelle: 0
		}
	};

	syncSessionQueue(req, [
		track('One renamed', 'a.json', 0),
		track('Two', 'a.json', 1),
		track('Three', 'a.json', 2)
	]);

	assert.equal(req.session.ecoute_actuelle, 0);
	assert.deepEqual(req.session.list_order, [2, 1]);
	assert.deepEqual(req.session.items.map((item) => item.title), ['One renamed', 'Two', 'Three']);
});

test('syncSessionQueue drops missing queued and current tracks', () => {
	const req = {
		session: {
			random: false,
			queue_initialized: true,
			items: [track('One', 'a.json', 0), track('Two', 'a.json', 1)],
			list_order: [1],
			ecoute_actuelle: 0
		}
	};

	syncSessionQueue(req, [track('Two', 'a.json', 1)]);

	assert.equal(req.session.ecoute_actuelle, null);
	assert.deepEqual(req.session.list_order, [0]);
	assert.equal(req.session.items[0].title, 'Two');
});

test('getUpcomingQueue returns playable tracks in next-pop order with session indexes', () => {
	const req = {
		session: {
			items: [track('One'), track('Two'), track('Three')],
			list_order: [0, 2, 1]
		}
	};

	assert.deepEqual(getUpcomingQueue(req, 2).map((item) => [item.title, item.__sessionIndex]), [
		['Two', 1],
		['Three', 2]
	]);
});

test('playbackState returns current track, queue and random mode', () => {
	const req = {
		session: {
			items: [track('One'), track('Two')],
			list_order: [0],
			ecoute_actuelle: 1,
			random: true
		}
	};

	assert.deepEqual(playbackState(req), {
		currentId: 1,
		current: req.session.items[1],
		previousId: null,
		queue: [{ ...req.session.items[0], __sessionIndex: 0 }],
		random: true
	});
});

test('previous follows listening history and returns the current song to the front of the queue', () => {
	const req = { session: { items: [track('A'), track('B'), track('C')], ecoute_actuelle: 2, list_order: [1] } };
	rememberCurrentTrack(req);
	req.session.ecoute_actuelle = 0;
	assert.equal(playbackState(req).previousId, 2);
	assert.equal(takePreviousTrack(req), 2);
	assert.deepEqual(req.session.list_order, [1, 0]);
	assert.deepEqual(req.session.playback_history, []);
	assert.equal(takePreviousTrack(req), null);
	assert.deepEqual(req.session.list_order, [1, 0]);
});

test('history survives reindexing and removes deleted tracks', () => {
	const a = track('A', 'a.json', 0), b = track('B', 'b.json', 0), c = track('C', 'b.json', 1);
	const req = { session: { queue_initialized: true, items: [a, b, c], ecoute_actuelle: 2, list_order: [], playback_history: [0, 1] } };
	syncSessionQueue(req, [b, c]);
	assert.deepEqual(req.session.playback_history, [0]);
	assert.equal(req.session.ecoute_actuelle, 1);
	removeSongFromSessionQueue(req, 'b.json', 0);
	assert.deepEqual(req.session.playback_history, []);
	assert.equal(req.session.ecoute_actuelle, 0);
});

test('audio cache retains three distinct previous tracks plus current, upcoming and local tracks', () => {
	const req = { session: {
		items: Array.from({ length: 9 }, (_, id) => track(String(id), 'mix.json', id, id === 8 ? 'local' : 'youtube')),
		ecoute_actuelle: 6, list_order: [7, 1], playback_history: [0, 1, 2, 3, 4, 4, 5, 6]
	} };
	assert.deepEqual(getPlaybackCacheEvictions(req), [0, 2]);
	// Going back must keep the interrupted current song, now queued next.
	req.session.ecoute_actuelle = takePreviousTrack(req);
	assert.deepEqual(getPlaybackCacheEvictions(req), [0, 2]);
});

test('listening history is bounded', () => {
	const req = { session: { items: [track('A')], ecoute_actuelle: 0 } };
	for (let i = 0; i < 100; i++) rememberCurrentTrack(req);
	assert.equal(req.session.playback_history.length, 50);
});

test('preloadUpcomingSongs loads only pending upcoming non-downloaded tracks', () => {
	const loaded = [];
	const req = {
		sessionID: 'session-a',
		session: {
			items: [track('One'), track('Two'), track('Three')],
			list_order: [0, 1, 2]
		}
	};

	preloadUpcomingSongs(
		req,
		2,
		(id) => id === 1,
		(item, id, sessionId) => loaded.push([item.title, id, sessionId])
	);

	assert.deepEqual(loaded, [['Three', 2, 'session-a']]);
});

test('removeSongFromSessionQueue removes a track and rewrites positions safely', () => {
	const deleted = [];
	const req = {
		sessionID: 'session-a',
		session: {
			items: [
				track('One', 'mix.json', 0),
				track('Two', 'mix.json', 1),
				track('Three', 'mix.json', 2),
				track('Local', 'mix.json', 3, 'local')
			],
			list_order: [3, 2, 1, 0],
			ecoute_actuelle: 2
		}
	};

	removeSongFromSessionQueue(req, 'mix.json', 1, (id, sessionId) => deleted.push([id, sessionId]));

	assert.deepEqual(deleted, [[1, 'session-a']]);
	assert.deepEqual(req.session.items.map((item) => [item.title, item.__playlistIndex]), [
		['One', 0],
		['Three', 1],
		['Local', 2]
	]);
	assert.deepEqual(req.session.list_order, [2, 1, 0]);
	assert.equal(req.session.ecoute_actuelle, 1);

	removeSongFromSessionQueue(req, 'mix.json', 2, (id, sessionId) => deleted.push([id, sessionId]));
	assert.deepEqual(deleted, [[1, 'session-a']]);
});

test('gestion_ecoute pops the next track and calls preload before and after', () => {
	const calls = [];
	const req = { session: { list_order: [0, 1, 2] } };
	const id = gestion_ecoute(req, (request, count) => calls.push([request, count]));

	assert.equal(id, 2);
	assert.deepEqual(req.session.list_order, [0, 1]);
	assert.deepEqual(calls, [[req, 5], [req, 1]]);
});

test('listen_after loads the requested track only when needed', () => {
	const loaded = [];
	const req = {
		sessionID: 'session-a',
		session: { items: [track('One')] }
	};

	listen_after(req, 0, () => false, (item, id, sessionId) => loaded.push([item.title, id, sessionId]));
	listen_after(req, 0, () => true, () => assert.fail('already downloaded track should not be loaded'));

	assert.deepEqual(loaded, [['One', 0, 'session-a']]);
});


test('stable selections keep playback IDs and deletion cannot shift another playing track', () => {
	const a = track('A', 'a.json', 0), b = track('B', 'b.json', 0), c = track('C', 'b.json', 1);
	const items = stablePlaylistTracks([a], [b, c]);
	const req = { session: { items, ecoute_actuelle: 0, list_order: [2, 1], playback_history: [], queue_initialized: true, stable_playlist_indices: true } };
	syncSessionQueue(req, stablePlaylistTracks(items, [b, c]));
	assert.equal(playbackState(req).current.title, 'A');
	assert.deepEqual(getUpcomingQueue(req).map(item => item.title), ['B', 'C']);
	removeSongFromSessionQueue(req, 'b.json', 0);
	assert.equal(req.session.ecoute_actuelle, 0);
	assert.deepEqual(req.session.list_order, [2]);
	removeSongFromSessionQueue(req, 'b.json', 0);
	assert.deepEqual(req.session.list_order, []);
	const reordered = stablePlaylistTracks([a, b], [b, a]);
	assert.deepEqual(reordered.filter(item => !item.__retained).sort((x, y) => x.__selectionIndex - y.__selectionIndex).map(item => item.title), ['B', 'A']);
});
