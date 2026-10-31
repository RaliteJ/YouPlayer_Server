import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileYouplayerStore } from '../../src/server/stores/file-store.js';
import { PostgresYouplayerStore } from '../../src/server/stores/postgres-store.js';

test('file storage persists newest individual tracks first after concurrent writes and reopening', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'youplayer-insertion-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'store.json');
    const store = new FileYouplayerStore({ filePath });
    await store.init();
    await store.appendPlaylistItems('user', 'mix', [{ title: 'Import A' }, { title: 'Import B' }]);
    await Promise.all(['First', 'Second'].map(title => store.appendPlaylistItems('user', 'mix', { title })));
    const reopened = new FileYouplayerStore({ filePath });
    await reopened.init();
    assert.deepEqual((await reopened.getPlaylistItems('user', 'mix')).map(item => item.title), ['Second', 'First', 'Import A', 'Import B']);
});

test('PostgreSQL prepend keeps contiguous positions under the immediate uniqueness constraint', async () => {
    const rows = [{ position: 0, title: 'A' }, { position: 1, title: 'B' }];
    let released = 0, locked = false;
    const store = new PostgresYouplayerStore({ connectionString: 'synthetic' });
    store.ensurePlaylist = async () => ({ id: '1', name: 'mix.json' });
    store.pool = { connect: async () => ({
        release() { released++; },
        async query(sql, params) {
            if (sql.includes('FOR UPDATE')) locked = true;
            if (sql.includes('MAX(position)')) return { rows: [{ max_position: Math.max(-1, ...rows.map(row => row.position)) }] };
            if (sql.includes('SET position')) {
                assert.equal(locked, true);
                const positions = new Set(rows.map(row => row.position));
                for (const row of rows) {
                    positions.delete(row.position);
                    const next = sql.includes('-position - 1') ? -row.position - 1 : -row.position;
                    assert.equal(positions.has(next), false, 'each updated row must respect immediate uniqueness');
                    positions.add(next);
                    row.position = next;
                }
            }
            if (sql.includes('INSERT INTO yp_playlist_items')) {
                assert.equal(rows.some(row => row.position === params[1]), false);
                rows.push({ position: params[1], title: JSON.parse(params[2]).title });
            }
            return { rows: [] };
        }
    }) };
    assert.equal((await store.appendPlaylistItems('user', 'mix', { title: 'Nouveau' })).count, 3);
    assert.equal((await store.appendPlaylistItems('user', 'mix', [{ title: 'C' }, { title: 'D' }])).count, 5);
    assert.deepEqual(rows.sort((a, b) => a.position - b.position), [
        { position: 0, title: 'Nouveau' }, { position: 1, title: 'A' }, { position: 2, title: 'B' },
        { position: 3, title: 'C' }, { position: 4, title: 'D' }
    ]);
    assert.equal(released, 2);
});

test('background resolution preserves Spotify artist identities and never overwrites a track shifted by a prepend', async t => {
    const { randomUUID } = await import('node:crypto');
    const { writeFile } = await import('node:fs/promises');
    const { download_spotify } = await import('../../src/server/download.js');
    const name = `metadata-fixture-${randomUUID()}.json`;
    const file = new URL(`../../src/playlists/${name}`, import.meta.url);
    t.after(() => rm(file, { force: true }));
    const artist = { id: 'A'.repeat(22), name: 'Artiste' };
    const original = { type: 'spotify', url: `https://open.spotify.com/track/${'B'.repeat(22)}`, title: 'Original', artist: artist.name, spotifyArtists: [artist] };
    const song = { ...original, __playlist: name, __playlistIndex: 0 };
    const options = { resolveTrack: async track => ({ ...track, id: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }), downloadYoutube: async () => 'synthetic download' };
    await writeFile(file, JSON.stringify({ items: [original] }), { flag: 'wx' });
    await download_spotify([original.url, 0], 'synthetic', song, options);
    assert.deepEqual(JSON.parse(await readFile(file)).items[0].spotifyArtists, [artist]);
    const shifted = { items: [{ type: 'local', url: 'new.mp3', title: 'Nouveau' }, original] };
    await writeFile(file, JSON.stringify(shifted));
    await download_spotify([original.url, 0], 'synthetic', song, options);
    assert.deepEqual(JSON.parse(await readFile(file)), shifted);
});

test('played video source stays inside its session and is removed with the private audio cache', async t => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { downloadedYoutubeSource, deleteDownloadedTrack } = await import('../../src/server/download.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'youplayer-caption-source-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'owner'));
    const source = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
    await writeFile(path.join(root, 'owner', 'queue-owned.mp3'), 'synthetic');
    await writeFile(path.join(root, 'owner', 'queue-owned.source.json'), JSON.stringify({ source }));
    assert.equal(await downloadedYoutubeSource('queue-owned', 'owner', { musiqDir: root }), source);
    assert.equal(await downloadedYoutubeSource('queue-owned', 'stranger', { musiqDir: root }), null);
    assert.equal(await downloadedYoutubeSource('../owner/queue-owned', 'stranger', { musiqDir: root }), null);
    await deleteDownloadedTrack('queue-owned', 'owner', { musiqDir: root });
    assert.equal(await downloadedYoutubeSource('queue-owned', 'owner', { musiqDir: root }), null);
    await assert.rejects(readFile(path.join(root, 'owner', 'queue-owned.mp3')), { code: 'ENOENT' });
});
