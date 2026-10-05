import test from 'node:test';
import assert from 'node:assert/strict';
import {
	escapeHtml,
	formatTrackTitle,
	getTrackArtwork,
	playlistEntries
} from '../src/client-utils.js';

test('escapeHtml escapes HTML-sensitive characters', () => {
	assert.equal(escapeHtml(`<script>"x" & 'y'</script>`), '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
	assert.equal(escapeHtml(null), '');
});

test('formatTrackTitle formats known and missing track fields', () => {
	assert.equal(formatTrackTitle({ artist: 'Artist', title: 'Title' }), 'Artist - Title');
	assert.equal(formatTrackTitle({ name: 'Name Only' }), 'Name Only');
	assert.equal(formatTrackTitle({ artist: 'Artist' }), 'Artist - Titre inconnu');
	assert.equal(formatTrackTitle(null), 'Titre inconnu');
});

test('getTrackArtwork resolves absolute and relative artwork URLs', () => {
	assert.equal(getTrackArtwork({ albumCoverURL: '/cover.jpg' }, 'https://youplayer.local'), 'https://youplayer.local/cover.jpg');
	assert.equal(getTrackArtwork({ thumbnail: 'thumb.jpg' }, 'https://youplayer.local/app/'), 'https://youplayer.local/app/thumb.jpg');
	assert.equal(getTrackArtwork({}, 'https://youplayer.local'), '');
});

test('playlistEntries normalizes legacy string and summary playlist shapes', () => {
	assert.deepEqual(playlistEntries([
		'mix.json',
		{ filename: 'legacy.json', coverUrl: 'legacy.jpg', count: 2 },
		{ name: 'named.json', title: 'Named', image: 'named.jpg', count: 0 },
		{ title: 'ignored because no name' }
	]), [
		{ name: 'mix.json', title: 'mix', image: '', count: null },
		{ name: 'legacy.json', title: 'legacy', image: 'legacy.jpg', count: 2 },
		{ name: 'named.json', title: 'Named', image: 'named.jpg', count: 0 }
	]);
});

test('playlistEntries accepts object maps from older API responses', () => {
	assert.deepEqual(playlistEntries({
		first: 'one.json',
		second: { name: 'two.json', count: 3 }
	}), [
		{ name: 'one.json', title: 'one', image: '', count: null },
		{ name: 'two.json', title: 'two', image: '', count: 3 }
	]);
});
