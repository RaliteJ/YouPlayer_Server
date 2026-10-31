import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaylistAccess } from '../../src/server/playlist-access.js';
import { LIKED_PLAYLIST } from '../../src/client-utils.js';
import { registerPlaylistRoutes } from '../../src/server/playlist-routes.js';

const first = { type: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Premier' };
const second = { ...first, id: 'lmnopqrstuv', url: 'https://www.youtube.com/watch?v=lmnopqrstuv', title: 'Second' };

async function local(t) {
	const playlistsDir = await mkdtemp(join(tmpdir(), 'youplayer-playlist-access-'));
	t.after(() => rm(playlistsDir, { recursive: true, force: true }));
	return { playlistsDir, access: createPlaylistAccess({ authEnabled: false, playlistsDir }) };
}

test('playlist file transfer also persists new copies in the authentication-disabled file store', async t => {
    const { access, playlistsDir } = await local(t);
    await access.appendPlaylistItemsForRequest({}, 'Original.json', [first, second]);
    await access.appendPlaylistItemsForRequest({}, 'Vide.json', []);
    const routes = new Map();
    const app = {
        get: (path, ...handlers) => routes.set('GET ' + path, handlers.at(-1)),
        post: (path, ...handlers) => routes.set('POST ' + path, handlers.at(-1))
    };
    registerPlaylistRoutes(app, { authEnabled: false, playlistAccess: access,
        recordAction: async () => {}, sendJsonError: (_res, error) => { throw error; } });
    let data;
    const res = { set() { return this; }, type() { return this; },
        send(value) { data = JSON.parse(value); }, json(value) { data = value; } };
    await routes.get('GET /playlist/export')({}, res);
    await routes.get('POST /playlist/import')({ body: data }, res);
    assert.equal(data.imported.length, 2);
    const copy = data.imported.find(playlist => playlist.count === 2).name;
    assert.deepEqual(JSON.parse(await readFile(join(playlistsDir, copy), 'utf8')).items.map(t => t.title), ['Premier', 'Second']);
    assert.deepEqual((await access.playlistItemsForRequest({}, 'Original.json')).map(t => t.title), ['Premier', 'Second']);
    const emptyCopy = data.imported.find(playlist => playlist.count === 0).name;
    assert.deepEqual(await access.playlistItemsForRequest({}, emptyCopy), []);
});

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

test('single local additions go first while imported batches preserve their order', async t => {
	const { access } = await local(t);
	await access.appendPlaylistItemsForRequest({}, 'Test.json', [first, second]);
	await access.appendPlaylistItemsForRequest({}, 'Test.json', { ...first, title: 'Nouveau' });
	await access.appendPlaylistItemsForRequest({}, 'Test.json', [{ ...first, title: 'Import A' }, { ...first, title: 'Import B' }]);
	assert.deepEqual((await access.playlistItemsForRequest({}, 'Test.json')).map(item => item.title), ['Nouveau', 'Premier', 'Second', 'Import A', 'Import B']);
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
