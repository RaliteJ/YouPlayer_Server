import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	getPlaylistSummary,
	listPlaylistFiles,
	playlistImageFromItems,
	playlistPath,
	updateJsonFile
} from '../../src/server/playlist-files.js';

async function withTempDir(fn) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'youplayer-playlists-'));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('playlistPath accepts only local json filenames', () => {
	const baseDir = '/tmp/playlists';
	assert.equal(playlistPath('mix.json', baseDir), path.join(baseDir, 'mix.json'));
	assert.throws(() => playlistPath('../mix.json', baseDir), /invalide/);
	assert.throws(() => playlistPath('mix.txt', baseDir), /invalide/);
	assert.throws(() => playlistPath('', baseDir), /invalide/);
});

test('updateJsonFile appends single and multiple items while preserving existing items', async () => {
	await withTempDir(async (dir) => {
		const filePath = path.join(dir, 'mix.json');
		await writeFile(filePath, JSON.stringify({ items: [{ title: 'Existing' }] }), 'utf8');

		await updateJsonFile(filePath, { title: 'Single' });
		await updateJsonFile(filePath, [{ title: 'Batch 1' }, { title: 'Batch 2' }]);

		const saved = JSON.parse(await readFile(filePath, 'utf8'));
		assert.deepEqual(saved.items.map((item) => item.title), ['Existing', 'Single', 'Batch 1', 'Batch 2']);
		assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
	});
});

test('updateJsonFile creates an items array when the playlist file has another shape', async () => {
	await withTempDir(async (dir) => {
		const filePath = path.join(dir, 'empty.json');
		await writeFile(filePath, JSON.stringify({ title: 'No items yet' }), 'utf8');

		await updateJsonFile(filePath, { title: 'First' });

		const saved = JSON.parse(await readFile(filePath, 'utf8'));
		assert.deepEqual(saved.items, [{ title: 'First' }]);
	});
});

test('listPlaylistFiles returns sorted json files only', async () => {
	await withTempDir(async (dir) => {
		await writeFile(path.join(dir, 'b.json'), '{}', 'utf8');
		await writeFile(path.join(dir, 'a.json'), '{}', 'utf8');
		await writeFile(path.join(dir, 'notes.txt'), '{}', 'utf8');

		assert.deepEqual(await listPlaylistFiles(dir), ['a.json', 'b.json']);
	});
});

test('playlistImageFromItems finds the first usable image field', () => {
	assert.equal(playlistImageFromItems([{ albumCoverURL: '' }, { thumbnail: 'thumb.jpg' }]), 'thumb.jpg');
	assert.equal(playlistImageFromItems([{ image: 'image.jpg' }]), 'image.jpg');
	assert.equal(playlistImageFromItems([{ cover: 'cover.jpg' }]), 'cover.jpg');
	assert.equal(playlistImageFromItems([{ cover: '   ' }]), '');
});

test('getPlaylistSummary reads title, count, image and updatedAt', async () => {
	await withTempDir(async (dir) => {
		await writeFile(path.join(dir, 'mix.json'), JSON.stringify({
			items: [{ title: 'Track', albumCoverURL: 'track-cover.jpg' }],
			updatedAt: '2026-07-22T12:00:00.000Z'
		}), 'utf8');

		assert.deepEqual(await getPlaylistSummary('mix.json', dir), {
			name: 'mix.json',
			title: 'mix',
			image: 'track-cover.jpg',
			count: 1,
			updatedAt: '2026-07-22T12:00:00.000Z'
		});
	});
});

test('getPlaylistSummary returns a safe empty summary for invalid or unreadable playlists', async () => {
	await withTempDir(async (dir) => {
		assert.deepEqual(await getPlaylistSummary('missing.json', dir), {
			name: 'missing.json',
			title: 'missing',
			image: '',
			count: 0,
			updatedAt: null
		});
	});
});
