import test from 'node:test';
import assert from 'node:assert/strict';
import { orderLibrary, rediscoverPlaylist, SleepTimer } from '../src/library-tools.js';

const playlists = [
	{ name: 'ete.json', title: 'Été calme', count: 2 },
	{ name: 'rock.json', title: 'Rock', count: 8 },
	{ name: 'vide.json', title: 'Vide', count: 0 }
];

test('library search ignores accents and supports multiple words without mutating input', () => {
	assert.deepEqual(orderLibrary(playlists, { query: 'calme ete' }).map((item) => item.name), ['ete.json']);
	assert.equal(orderLibrary(playlists, { query: 'unknown' }).length, 0);
	assert.equal(playlists[0].name, 'ete.json');
});

test('library ordering keeps pins first then sorts by recency or size', () => {
	assert.equal(orderLibrary(playlists, { sort: 'count' })[0].name, 'rock.json');
	assert.equal(orderLibrary(playlists, { sort: 'recent', recent: ['rock.json'] })[0].name, 'rock.json');
	assert.equal(orderLibrary(playlists, { sort: 'count', pinned: ['ete.json'] })[0].name, 'ete.json');
});

test('rediscovery prefers unvisited nonempty playlists and has a bounded fallback', () => {
	assert.equal(rediscoverPlaylist(playlists, ['rock.json'], () => 0).name, 'ete.json');
	assert.equal(rediscoverPlaylist(playlists, ['rock.json', 'ete.json'], () => 0.99).name, 'rock.json');
	assert.equal(rediscoverPlaylist([playlists[2]]), null);
});

function timerFixture() {
	let now = 0;
	let fired = 0;
	let callback;
	const timer = new SleepTimer({
		now: () => now, onExpire: () => fired++,
		schedule: (fn) => { callback = fn; return 1; }, unschedule: () => { callback = null; }
	});
	return { timer, advance: (value) => { now = value; }, fire: () => callback?.(), get fired() { return fired; } };
}

test('sleep timer expires once on wall-clock time including after delayed wake', () => {
	const f = timerFixture();
	f.timer.set(15);
	f.advance(14 * 60_000);
	assert.equal(f.timer.check(), false);
	f.advance(17 * 60_000);
	f.timer.check();
	f.timer.check();
	assert.equal(f.fired, 1);
	assert.equal(f.timer.expired, true);
	f.timer.resume();
	assert.equal(f.timer.check(), false);
});

test('sleep timer cancellation and replacement cancel the previous deadline', () => {
	const f = timerFixture();
	f.timer.set(15);
	f.timer.set(30);
	f.advance(16 * 60_000);
	assert.equal(f.timer.check(), false);
	f.timer.cancel();
	f.advance(60 * 60_000);
	f.fire();
	assert.equal(f.timer.check(), false);
	assert.equal(f.fired, 0);
	assert.throws(() => f.timer.set(-1));
});

test('explicit resume after a suspended timer acknowledges the elapsed deadline', () => {
	const f = timerFixture();
	f.timer.set(15);
	f.advance(20 * 60_000);
	f.timer.resume();
	assert.equal(f.timer.check(), false);
	assert.equal(f.fired, 0);
});
