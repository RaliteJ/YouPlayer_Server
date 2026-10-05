import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaylistAccess } from '../../src/server/playlist-access.js';
import { LIKED_PLAYLIST } from '../../src/client-utils.js';

const first = { type: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Premier' };
const second = { ...first, id: 'lmnopqrstuv', url: 'https://www.youtube.com/watch?v=lmnopqrstuv', title: 'Second' };

async function local(t) {
	const playlistsDir = await mkdtemp(join(tmpdir(), 'youplayer-playlist-access-'));
	t.after(() => rm(playlistsDir, { recursive: true, force: true }));
	return { playlistsDir, access: createPlaylistAccess({ authEnabled: false, playlistsDir }) };
}

test('local playlist CRUD preserves source indices and protects the automatic liked playlist', async t => {
	const { access } = await local(t);
	assert.deepEqual(await access.playlistItemsForRequest({}, LIKED_PLAYLIST), []);
	assert.equal((await access.playlistSummariesForRequest({}))[0].name, LIKED_PLAYLIST);
	await access.appendPlaylistItemsForRequest({}, 'Test.json', [first, second]);
	assert.deepEqual((await access.playlistTracksForRequest({}, 'Test.json')).map(item => item.__playlistIndex), [0, 1]);
	assert.equal((await access.deletePlaylistItemForRequest({}, 'Test.json', 0)).title, 'Premier');
	assert.equal(await access.deletePlaylistItemForRequest({}, 'Test.json', 99), null);
	for (const operation of [
		() => access.appendPlaylistItemsForRequest({}, LIKED_PLAYLIST, first),
		() => access.deletePlaylistForRequest({}, LIKED_PLAYLIST),
		() => access.deletePlaylistItemForRequest({}, LIKED_PLAYLIST, 0)
	]) await assert.rejects(operation, /bouton cœur/);
	await access.deletePlaylistForRequest({}, 'Test.json');
	assert.deepEqual(await access.playlistFilesForRequest({}), []);
});

test('concurrent local likes retain both tracks and stable queue IDs survive a removal', async t => {
	const { access } = await local(t);
	await Promise.all([
		access.setTrackLikedForRequest({}, { ...first, __queueId: 'temporary' }, true),
		access.setTrackLikedForRequest({}, second, true)
	]);
	const tracks = await access.playlistTracksForRequest({}, LIKED_PLAYLIST);
	assert.equal(tracks.length, 2);
	assert.equal((await access.playlistItemsForRequest({}, LIKED_PLAYLIST))[0].__queueId, undefined);
	await access.setTrackLikedForRequest({}, first, false);
	const remaining = await access.playlistTracksForRequest({}, LIKED_PLAYLIST);
	assert.equal(remaining[0].__queueId, tracks[1].__queueId);
	assert.equal(remaining[0].__playlistIndex, 0);
});

test('a failed local like write does not poison later operations', async t => {
	const { access, playlistsDir } = await local(t);
	const path = join(playlistsDir, LIKED_PLAYLIST);
	await writeFile(path, 'broken JSON');
	await assert.rejects(access.setTrackLikedForRequest({}, first, true), SyntaxError);
	await writeFile(path, JSON.stringify({ items: [] }));
	await access.setTrackLikedForRequest({}, second, true);
	assert.equal(JSON.parse(await readFile(path, 'utf8')).items[0].title, 'Second');
});
