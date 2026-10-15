import test from 'node:test';
import assert from 'node:assert/strict';
import { orderLibrary, rediscoverPlaylist, SleepTimer } from '../src/library-tools.js';
import { libraryView } from '../src/library-view.js';

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
	assert.equal(orderLibrary(playlists, { recent: ['rock.json', 'ete.json'] })[0].name, 'rock.json');
	assert.equal(orderLibrary(playlists, { sort: 'name', recent: ['rock.json'] })[0].name, 'ete.json');
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


function searchFixture(t, query = 'ete') {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    const elements = {
        'library-search': { value: query },
        'library-play-selection': {}
    };
    globalThis.document = { getElementById: id => elements[id], createElement: () => ({}) };
    const app = {
        ...libraryView,
        currentUser: { id: 'first' },
        availablePlaylists: [{ name: 'one.json', title: 'Calme' }, { name: 'two.json', title: 'Rock' }],
        selectedPlaylists: [],
        playlistPreviewTitle: {}, playlistPreviewCount: {},
        playlistPreviewList: { appendChild(button) { this.retry = button; } },
        clearTrackPageScrolling() {},
        renderPlaylistPreview(playlist, tracks) { this.rendered = { playlist, tracks }; },
        apiFetch: async endpoint => endpoint.includes('one.json')
            ? [{ title: 'Été', artist: 'Alice', __playlistIndex: 8 }]
            : [{ title: 'Hiver', artist: 'Été', __playlistIndex: 2 }]
    };
    return { app, elements };
}

test('library search matches titles, artists and playlist names while preserving source indexes', async t => {
    const { app, elements } = searchFixture(t);
    await app.searchLibraryTracks();
    assert.deepEqual(app.rendered.tracks.map(track => [track.__libraryPlaylist.name, track.__playlistIndex]),
        [['one.json', 8], ['two.json', 2]]);
    elements['library-search'].value = 'alice ete';
    await app.searchLibraryTracks();
    assert.deepEqual(app.rendered.tracks.map(track => track.title), ['Été']);
    elements['library-search'].value = 'rock';
    await app.searchLibraryTracks();
    assert.deepEqual(app.rendered.tracks.map(track => track.title), ['Hiver']);
});

test('library search discards responses after account or search changes', async t => {
    const { app } = searchFixture(t);
    for (const invalidate of [app => { app.currentUser = { id: 'other' }; }, app => { app.librarySearchRevision++; }]) {
        app.currentUser = { id: 'first' };
        let complete;
        app.apiFetch = () => new Promise(resolve => { complete = resolve; });
        const pending = app.searchLibraryTracks();
        invalidate(app);
        complete([{ title: 'Été' }]);
        await pending;
        assert.equal(app.rendered, undefined);
    }
});

test('partial library search offers retry and selection counts include filtered playlists', async t => {
    const { app, elements } = searchFixture(t);
    app.apiFetch = async () => null;
    await app.searchLibraryTracks();
    assert.match(app.playlistPreviewCount.textContent, /incomplète/);
    assert.equal(app.playlistPreviewList.retry.textContent, 'Réessayer');
    app.updateLibrarySelectionLabel();
    assert.equal(elements['library-play-selection'].disabled, true);
    app.draftPlaylists = new Set(['one.json', 'two.json']);
    app.updateLibrarySelectionLabel();
    assert.match(elements['library-play-selection'].textContent, /2 playlists/);
    assert.equal(elements['library-play-selection'].disabled, false);
});
