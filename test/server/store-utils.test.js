import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	normalizePlaylistName,
	normalizePseudo,
	normalizeRole,
	playlistImage,
	playlistTitle,
	publicUser,
	readPlaylistFile,
	requestContext
} from '../../src/server/stores/store-utils.js';

async function withTempDir(fn) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'youplayer-store-utils-'));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('normalizePseudo trims input and compares pseudos case-insensitively', () => {
	assert.equal(normalizePseudo('  User.Name  '), 'user.name');
	assert.equal(normalizePseudo(null), '');
});

test('normalizeRole only preserves the admin role explicitly', () => {
	assert.equal(normalizeRole('admin'), 'admin');
	assert.equal(normalizeRole('ADMIN'), 'user');
	assert.equal(normalizeRole(null), 'user');
});

test('normalizePlaylistName adds json extension and rejects path traversal', () => {
	assert.equal(normalizePlaylistName('Road Mix'), 'Road Mix.json');
	assert.equal(normalizePlaylistName('Road Mix.json'), 'Road Mix.json');
	assert.throws(() => normalizePlaylistName('../Road Mix.json'), /invalide/);
	assert.throws(() => normalizePlaylistName('nested/Road Mix.json'), /invalide/);
	assert.throws(() => normalizePlaylistName(''), /invalide/);
});

test('playlistTitle returns the display name without the json extension', () => {
	assert.equal(playlistTitle('Road Mix.json'), 'Road Mix');
	assert.equal(playlistTitle('Road Mix'), 'Road Mix');
});

test('playlistImage returns the first non-empty supported artwork field', () => {
	assert.equal(playlistImage([{ albumCoverURL: '' }, { thumbnail: 'thumb.jpg' }]), 'thumb.jpg');
	assert.equal(playlistImage([{ image: 'image.jpg' }]), 'image.jpg');
	assert.equal(playlistImage([{ cover: '   ' }]), '');
});

test('publicUser exposes only safe account fields and accepts postgres display_name', () => {
	assert.deepEqual(publicUser({
		id: 42,
		pseudo: 'user',
		display_name: 'Display User',
		role: 'admin',
		passwordHash: 'secret'
	}), {
		id: '42',
		pseudo: 'user',
		displayName: 'Display User',
		role: 'admin',
		authLevel: 'local',
		spotify: {
			connected: false
		}
	});
	assert.equal(publicUser(null), null);
});

test('requestContext prefers Express helpers and falls back to socket headers', () => {
	assert.deepEqual(requestContext({
		ip: '10.0.0.1',
		get: (name) => name === 'user-agent' ? 'Browser A' : ''
	}), {
		ip: '10.0.0.1',
		userAgent: 'Browser A'
	});
	assert.deepEqual(requestContext({
		socket: { remoteAddress: '127.0.0.1' },
		headers: { 'user-agent': 'Browser B' }
	}), {
		ip: '127.0.0.1',
		userAgent: 'Browser B'
	});
});

test('readPlaylistFile returns items arrays and treats other JSON shapes as empty', async () => {
	await withTempDir(async (dir) => {
		const withItems = path.join(dir, 'with-items.json');
		const withoutItems = path.join(dir, 'without-items.json');
		await writeFile(withItems, JSON.stringify({ items: [{ title: 'Track' }] }), 'utf8');
		await writeFile(withoutItems, JSON.stringify({ title: 'No items' }), 'utf8');

		assert.deepEqual(await readPlaylistFile(withItems), [{ title: 'Track' }]);
		assert.deepEqual(await readPlaylistFile(withoutItems), []);
	});
});
