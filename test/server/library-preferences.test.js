import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryPreferences, updateLibraryPreferences } from '../../src/server/library-preferences.js';
import { MemoryYouplayerStore } from '../../src/server/stores/memory-store.js';

test('library preferences enforce limits, deduplicate visits and support removal', () => {
	let value = libraryPreferences();
	for (let i = 0; i < 25; i++) value = updateLibraryPreferences(value, { action: 'visit', playlist: `${i}.json` });
	assert.equal(value.recent.length, 12);
	value = updateLibraryPreferences(value, { action: 'visit', playlist: '24.json' });
	assert.equal(value.recent.length, 12);
	for (let i = 0; i < 20; i++) value = updateLibraryPreferences(value, { action: 'pin', playlist: `${i}.json`, enabled: true });
	assert.throws(() => updateLibraryPreferences(value, { action: 'pin', playlist: 'extra.json', enabled: true }), /20/);
	value = updateLibraryPreferences(value, { action: 'pin', playlist: '0.json', enabled: false });
	assert.equal(value.pinned.length, 19);
	assert.equal(updateLibraryPreferences(value, { action: 'clear_recent' }).recent.length, 0);
	assert.equal(value.recent.length, 12, 'actions do not mutate previous state');
	assert.throws(() => updateLibraryPreferences(value, { action: 'pin', playlist: 'x', enabled: 'true' }));
});

test('preferences are isolated by user and callers cannot mutate stored arrays', async () => {
	const store = new MemoryYouplayerStore();
	const first = await store.createUser({ pseudo: 'first', password: 'synthetic-password' });
	const second = await store.createUser({ pseudo: 'second', password: 'synthetic-password' });
	await store.appendPlaylistItems(first.id, 'first', [{ title: 'Synthetic' }]);
	await store.updateLibraryPreferences(first.id, { action: 'pin', playlist: 'first.json', enabled: true });
	const copy = await store.getLibraryPreferences(first.id);
	copy.pinned.push('outside.json');
	assert.deepEqual((await store.getLibraryPreferences(first.id)).pinned, ['first.json']);
	assert.deepEqual(await store.getLibraryPreferences(second.id), { pinned: [], recent: [] });
});

test('deleted playlist references do not consume the pin limit on the next update', () => {
	const previous = { pinned: Array.from({ length: 20 }, (_, i) => `deleted-${i}.json`) };
	const result = updateLibraryPreferences(previous, { action: 'pin', playlist: 'kept.json', enabled: true }, ['kept.json']);
	assert.deepEqual(result.pinned, ['kept.json']);
});
