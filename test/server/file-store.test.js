import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileYouplayerStore } from '../../src/server/stores/file-store.js';
import { bootstrapFileAdmin, createYouplayerStore, seedTestStore } from '../../src/server/youplayer-store.js';

async function fixture(t) {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const directory = await mkdtemp(path.join(root, '.test-file-store-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const filePath = path.join(directory, 'private', 'store.json');
	async function reopen() {
		const store = new FileYouplayerStore({ filePath });
		await store.init();
		return store;
	}
	return { directory, filePath, reopen, store: await reopen() };
}

test('file store restores accounts, password changes, isolated playlists, tokens and logs', async (t) => {
	const { store, filePath, reopen } = await fixture(t);
	const first = await store.createUser({ pseudo: 'first', password: 'initial-test-password' });
	const second = await store.createUser({ pseudo: 'second', password: 'another-test-password' });
	await store.changePassword(first.id, 'initial-test-password', 'changed-test-password');
	await store.appendPlaylistItems(first.id, 'mix', [{ title: 'First' }, { title: 'Remove' }]);
	await store.appendPlaylistItems(second.id, 'mix', [{ title: 'Second' }]);
	await store.deletePlaylistItem(first.id, 'mix', 1);
	await store.updateLibraryPreferences(first.id, { action: 'pin', playlist: 'mix.json', enabled: true });
	await store.updateLibraryPreferences(first.id, { action: 'visit', playlist: 'mix.json' });
	await store.attachSpotifyConnection(first.id, {
		accountId: 'synthetic-account', accessTokenEncrypted: 'v1:encrypted-test-token'
	});
	await store.recordLoginEvent({ userId: first.id, pseudo: 'first', success: true });
	await store.recordAuditLog({ userId: first.id, action: 'synthetic-action' });
	await store.close();
	const restarted = await reopen();
	assert.deepEqual(await restarted.getLibraryPreferences(first.id), { pinned: ['mix.json'], recent: ['mix.json'] });
	assert.deepEqual(await restarted.getLibraryPreferences(second.id), { pinned: [], recent: [] });
	assert.equal(await restarted.authenticate('first', 'initial-test-password'), null);
	assert.equal((await restarted.authenticate('first', 'changed-test-password')).id, first.id);
	assert.deepEqual(await restarted.getPlaylistItems(first.id, 'mix'), [{ title: 'First' }]);
	assert.deepEqual(await restarted.getPlaylistItems(second.id, 'mix'), [{ title: 'Second' }]);
	assert.equal((await restarted.getSpotifyConnection(first.id, { includeTokens: true })).accessTokenEncrypted, 'v1:encrypted-test-token');
	assert.equal((await restarted.listLoginEvents()).length, 1);
	assert.equal((await restarted.listAuditLogs()).length, 1);
	assert.equal((await stat(filePath)).mode & 0o777, 0o600);
	const serialized = await readFile(filePath, 'utf8');
	assert.ok(!serialized.includes('changed-test-password'));
	assert.ok(!serialized.includes('initial-test-password'));
	const third = await restarted.createUser({ pseudo: 'third', password: 'third-test-password' });
	assert.notEqual(third.id, first.id);
	assert.notEqual(third.id, second.id);
	await restarted.deletePlaylist(first.id, 'mix');
	await restarted.removeSpotifyConnection(first.id);
	const again = await reopen();
	assert.deepEqual(await again.listPlaylistFiles(first.id), []);
	assert.equal(await again.getSpotifyConnection(first.id), null);
});

test('concurrent writes do not lose playlist items or allow duplicate accounts', async (t) => {
	const { store, reopen } = await fixture(t);
	const results = await Promise.allSettled([
		store.createUser({ pseudo: 'same', password: 'test-password-one' }),
		store.createUser({ pseudo: 'same', password: 'test-password-two' })
	]);
	assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
	const user = await store.findUserByPseudo('same');
	await Promise.all(Array.from({ length: 12 }, (_, index) =>
		store.appendPlaylistItems(user.id, 'mix', [{ title: `Track ${index}` }])));
	assert.equal((await (await reopen()).getPlaylistItems(user.id, 'mix')).length, 12);
});

test('failed disk commit preserves both memory and the previous file and allows retry', async (t) => {
	const { store, filePath, reopen } = await fixture(t);
	const user = await store.createUser({ pseudo: 'test', password: 'initial-test-password' });
	const previous = await readFile(filePath, 'utf8');
	const originalWrite = store.writeSnapshot.bind(store);
	store.writeSnapshot = async () => { throw new Error('synthetic disk full'); };
	await assert.rejects(store.setUserPassword(user.id, 'replacement-test-password'), /disk full/);
	assert.ok(await store.authenticate('test', 'initial-test-password'));
	assert.equal(await readFile(filePath, 'utf8'), previous);
	store.writeSnapshot = originalWrite;
	await store.setUserPassword(user.id, 'replacement-test-password');
	assert.ok(await (await reopen()).authenticate('test', 'replacement-test-password'));
});

test('failed rename cleans up the temporary snapshot', async (t) => {
	const { store, filePath } = await fixture(t);
	await mkdir(filePath, { recursive: true });
	await assert.rejects(store.createUser({ pseudo: 'test', password: 'synthetic-password' }));
	assert.deepEqual(await store.listUsers(), []);
	assert.deepEqual(await readdir(path.dirname(filePath)), ['store.json']);
});

test('damaged existing storage is rejected without resetting or overwriting it', async (t) => {
	const { filePath, reopen } = await fixture(t);
	await mkdir(path.dirname(filePath), { recursive: true });
	for (const content of ['{"private":"synthetic-private-value", broken', JSON.stringify({ version: 99 })]) {
		await writeFile(filePath, content);
		await assert.rejects(reopen(), (error) => {
			assert.match(error.message, /Stockage YouPlayer invalide/);
			assert.ok(!error.message.includes('synthetic-private-value'));
			return true;
		});
		assert.equal(await readFile(filePath, 'utf8'), content);
	}
});

test('admin bootstrap requires chosen credentials, is one-time and refuses test seeding', async (t) => {
	const { store, reopen } = await fixture(t);
	await assert.rejects(bootstrapFileAdmin(store, {}), /Premier demarrage/);
	await assert.rejects(bootstrapFileAdmin(store, {
		YOUPLAYER_ADMIN_PSEUDO: '${YOUPLAYER_ADMIN_PSEUDO}',
		YOUPLAYER_ADMIN_PASSWORD: '${YOUPLAYER_ADMIN_PASSWORD}'
	}), /Premier demarrage/);
	await bootstrapFileAdmin(store, {
		YOUPLAYER_ADMIN_PSEUDO: 'Owner', YOUPLAYER_ADMIN_PASSWORD: 'synthetic-initial-password'
	});
	const user = await store.findUserByPseudo('owner');
	assert.equal(user.role, 'admin');
	await store.changePassword(user.id, 'synthetic-initial-password', 'synthetic-new-password');
	const restarted = await reopen();
	await bootstrapFileAdmin(restarted, {
		YOUPLAYER_ADMIN_PSEUDO: 'Owner', YOUPLAYER_ADMIN_PASSWORD: 'synthetic-initial-password'
	});
	assert.equal(await restarted.authenticate('owner', 'synthetic-initial-password'), null);
	assert.ok(await restarted.authenticate('owner', 'synthetic-new-password'));
	assert.equal((await restarted.listUsers()).length, 1);
	await assert.rejects(seedTestStore(restarted, 'unused'), /interdits/);
});

test('imported playlists survive restart and remain isolated', async (t) => {
	const { directory, store, reopen } = await fixture(t);
	const user = await store.createUser({ pseudo: 'owner', password: 'synthetic-password' });
	await writeFile(path.join(directory, 'example.json'), JSON.stringify({ items: [{ title: 'Imported' }] }));
	await store.importPlaylistsFromDirectory(user.id, directory);
	assert.deepEqual(await (await reopen()).getPlaylistItems(user.id, 'example'), [{ title: 'Imported' }]);
});

test('runtime factory selects persistent storage and reopens it without bootstrap credentials', async (t) => {
	const { filePath } = await fixture(t);
	const values = {
		NODE_ENV: 'development', YOUPLAYER_STORE: 'file', YOUPLAYER_AUTH_ENABLED: 'true',
		YOUPLAYER_DATA_FILE: filePath, YOUPLAYER_ADMIN_PSEUDO: 'owner',
		YOUPLAYER_ADMIN_PASSWORD: 'synthetic-initial-password'
	};
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	Object.assign(process.env, values);
	const store = await createYouplayerStore();
	assert.ok(store instanceof FileYouplayerStore);
	const user = await store.findUserByPseudo('owner');
	await store.appendPlaylistItems(user.id, 'saved', [{ title: 'Synthetic' }]);
	await store.close();
	delete process.env.YOUPLAYER_ADMIN_PSEUDO;
	delete process.env.YOUPLAYER_ADMIN_PASSWORD;
	const restarted = await createYouplayerStore();
	assert.ok(await restarted.authenticate('owner', 'synthetic-initial-password'));
	assert.deepEqual(await restarted.listPlaylistFiles(user.id), ['saved.json']);
	await restarted.close();
});

test('likes persist, deduplicate concurrent requests and stay isolated after restart', async (t) => {
    const { store, reopen } = await fixture(t);
    const user = await store.createUser({ pseudo: 'likes-one', password: 'synthetic-password' });
    const other = await store.createUser({ pseudo: 'likes-two', password: 'synthetic-password' });
    const track = { type: 'youtube', id: 'likes-fixture', title: 'Synthetic', __sessionIndex: 0 };
    await Promise.all([store.setTrackLiked(user.id, track, true), store.setTrackLiked(user.id, track, true)]);
    const restored = await reopen();
    const liked = await restored.getPlaylistItems(user.id, 'liked Youplayer.json');
    assert.equal(liked.length, 1);
    assert.equal(liked[0].__sessionIndex, undefined);
    assert.deepEqual(await restored.listPlaylistFiles(other.id), []);
    await restored.setTrackLiked(user.id, track, false);
    assert.deepEqual(await (await reopen()).getPlaylistItems(user.id, 'liked Youplayer.json'), []);
});
