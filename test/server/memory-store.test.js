import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryYouplayerStore } from '../../src/server/stores/memory-store.js';

async function withTempDir(fn) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'youplayer-memory-store-'));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function createStoreWithUsers() {
	const store = new MemoryYouplayerStore();
	const user = await store.createUser({
		pseudo: 'User',
		password: 'password123',
		displayName: 'Test User'
	});
	const admin = await store.createUser({
		pseudo: 'admin',
		password: 'password123',
		role: 'admin'
	});
	return { store, user, admin };
}

test('createUser normalizes pseudos, defaults role and hides password hashes', async () => {
	const { store, user } = await createStoreWithUsers();

	assert.deepEqual(user, {
		id: '1',
		pseudo: 'user',
		displayName: 'Test User',
		role: 'user',
		authLevel: 'local',
		spotify: {
			connected: false
		}
	});
	assert.equal(user.passwordHash, undefined);
	await assert.rejects(() => store.createUser({
		pseudo: ' USER ',
		password: 'password123'
	}), /existe deja/);
});

test('authenticate returns a public user only for the matching password', async () => {
	const { store } = await createStoreWithUsers();

	const authenticated = await store.authenticate(' USER ', 'password123');
	assert.equal(authenticated.pseudo, 'user');
	assert.equal(authenticated.passwordHash, undefined);
	assert.equal(await store.authenticate('user', 'wrongpass'), null);
	assert.equal(await store.authenticate('missing', 'password123'), null);
});

test('changePassword validates the current password before replacing it', async () => {
	const { store, user } = await createStoreWithUsers();

	await assert.rejects(() => store.changePassword(user.id, 'wrongpass', 'newpass123'), /actuel invalide/);
	const changed = await store.changePassword(user.id, 'password123', 'newpass123');

	assert.equal(changed.pseudo, 'user');
	assert.equal(await store.authenticate('user', 'password123'), null);
	assert.equal((await store.authenticate('user', 'newpass123')).pseudo, 'user');
});

test('setUserPassword replaces a password without the current password', async () => {
	const { store, user } = await createStoreWithUsers();

	const changed = await store.setUserPassword(user.id, 'adminpass123');

	assert.equal(changed.pseudo, 'user');
	assert.equal(await store.authenticate('user', 'password123'), null);
	assert.equal((await store.authenticate('user', 'adminpass123')).pseudo, 'user');
});

test('listUsers returns public users sorted by pseudo', async () => {
	const { store } = await createStoreWithUsers();
	await store.createUser({
		pseudo: 'alpha',
		password: 'password123'
	});

	assert.deepEqual((await store.listUsers()).map((user) => user.pseudo), ['admin', 'alpha', 'user']);
	assert.equal((await store.listUsers())[0].passwordHash, undefined);
});

test('spotify connections are attached without exposing encrypted tokens publicly', async () => {
	const { store, user } = await createStoreWithUsers();
	const connected = await store.attachSpotifyConnection(user.id, {
		accountId: 'spotify-account-1',
		displayName: 'Compte Spotify test',
		scopes: ['playlist-read-private'],
		accessTokenEncrypted: 'encrypted-access',
		refreshTokenEncrypted: 'encrypted-refresh',
		expiresAt: '2030-01-01T00:00:00.000Z'
	});

	assert.equal(connected.authLevel, 'spotify');
	assert.equal(connected.spotify.connected, true);
	assert.equal(connected.spotify.displayName, 'Compte Spotify test');
	assert.equal(connected.spotify.accessTokenEncrypted, undefined);

	const connection = await store.getSpotifyConnection(user.id, { includeTokens: true });
	assert.equal(connection.accountId, 'spotify-account-1');
	assert.equal(connection.accessTokenEncrypted, 'encrypted-access');
	await assert.rejects(() => store.attachSpotifyConnection('2', {
		accountId: 'spotify-account-1',
		accessTokenEncrypted: 'other-access'
	}), /deja lie/);
	assert.equal((await store.removeSpotifyConnection(user.id)).authLevel, 'local');
});

test('memory store persists only encrypted Spotify connections in a private file', async () => {
	await withTempDir(async (dir) => {
		const connectionsFile = path.join(dir, 'private', 'spotify-connections.json');
		const first = new MemoryYouplayerStore({ spotifyConnectionsFile: connectionsFile });
		await first.init();
		const user = await first.createUser({ pseudo: 'user', password: 'password123' });
		await first.attachSpotifyConnection(user.id, {
			accountId: 'spotify-account-1',
			displayName: 'Compte Spotify test',
			scopes: ['playlist-read-private'],
			accessTokenEncrypted: 'v1:encrypted-access',
			refreshTokenEncrypted: 'v1:encrypted-refresh',
			expiresAt: '2030-01-01T00:00:00.000Z'
		});

		assert.equal((await stat(connectionsFile)).mode & 0o777, 0o600);
		const second = new MemoryYouplayerStore({ spotifyConnectionsFile: connectionsFile });
		await second.init();
		const restored = await second.createUser({ pseudo: 'user', password: 'password123' });
		const connection = await second.getSpotifyConnection(restored.id, { includeTokens: true });
		assert.equal(connection.accountId, 'spotify-account-1');
		assert.equal(connection.accessTokenEncrypted, 'v1:encrypted-access');
	});
});

test('playlist operations are isolated per user and return copied items', async () => {
	const { store, user, admin } = await createStoreWithUsers();

	await store.appendPlaylistItems(user.id, 'shared', [
		{ title: 'User track', albumCoverURL: 'user.jpg' },
		{ title: 'Second user track' }
	]);
	await store.appendPlaylistItems(admin.id, 'shared', { title: 'Admin track' });

	assert.deepEqual(await store.listPlaylistFiles(user.id), ['shared.json']);
	assert.deepEqual(await store.getPlaylistItems(admin.id, 'shared.json'), [{ title: 'Admin track' }]);

	const items = await store.getPlaylistItems(user.id, 'shared.json');
	items[0].title = 'Mutated outside';
	assert.equal((await store.getPlaylistItems(user.id, 'shared.json'))[0].title, 'User track');

	const summaries = await store.getPlaylistSummaries(user.id);
	assert.deepEqual(summaries.map(({ name, title, image, count }) => ({ name, title, image, count })), [{
		name: 'shared.json',
		title: 'shared',
		image: 'user.jpg',
		count: 2
	}]);
});

test('deletePlaylistItem removes by playlist index and rewrites later summaries', async () => {
	const { store, user } = await createStoreWithUsers();
	await store.appendPlaylistItems(user.id, 'mix.json', [
		{ title: 'First' },
		{ title: 'Second' }
	]);

	assert.deepEqual(await store.deletePlaylistItem(user.id, 'mix.json', 0), { title: 'First' });
	assert.equal(await store.deletePlaylistItem(user.id, 'mix.json', 10), null);
	assert.deepEqual(await store.getPlaylistItems(user.id, 'mix.json'), [{ title: 'Second' }]);
	assert.equal(await store.deletePlaylist(user.id, 'mix.json'), true);
	await assert.rejects(() => store.getPlaylistItems(user.id, 'mix.json'), /introuvable/);
});

test('event and audit logs are newest first and respect limits', async () => {
	const { store, user } = await createStoreWithUsers();

	await store.recordLoginEvent({ userId: user.id, pseudo: 'user', success: false });
	await store.recordLoginEvent({ userId: user.id, pseudo: 'user', success: true });
	await store.recordAuditLog({ userId: user.id, action: 'first' });
	await store.recordAuditLog({ userId: user.id, action: 'second', details: { ok: true } });

	assert.deepEqual((await store.listLoginEvents({ limit: 1 })).map((event) => event.success), [true]);
	assert.deepEqual((await store.listAuditLogs({ limit: 2 })).map((log) => log.action), ['second', 'first']);
});

test('importPlaylistsFromDirectory imports only json files for the selected user', async () => {
	await withTempDir(async (dir) => {
		const { store, user, admin } = await createStoreWithUsers();
		await writeFile(path.join(dir, 'mix.json'), JSON.stringify({
			items: [{ title: 'Imported' }]
		}), 'utf8');
		await writeFile(path.join(dir, 'notes.txt'), JSON.stringify({
			items: [{ title: 'Ignored' }]
		}), 'utf8');

		await store.importPlaylistsFromDirectory(user.id, dir);

		assert.deepEqual(await store.listPlaylistFiles(user.id), ['mix.json']);
		assert.deepEqual(await store.getPlaylistItems(user.id, 'mix.json'), [{ title: 'Imported' }]);
		assert.deepEqual(await store.listPlaylistFiles(admin.id), []);
	});
});
