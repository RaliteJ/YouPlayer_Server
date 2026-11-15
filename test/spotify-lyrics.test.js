import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupSpotifyLyrics, lyricsCanSync, lyricsView, matchSpotifyLyricsTrack } from '../src/lyrics-view.js';
import { musicTrackIdentity } from '../src/client-utils.js';

const id = 'A'.repeat(22);
const track = { url: `https://open.spotify.com/track/${id}?si=test`, duration_ms: 180000 };
const youtube = { type: 'youtube', id: 'chosen00001', url: 'https://www.youtube.com/watch?v=chosen00001',
    title: 'Étoile - La lumière (Clip Officiel)', artist: 'Une chaîne de clips' };
const candidate = { id, name: 'La lumière', artists: [{ name: 'Étoile' }], duration_ms: 180000 };

test('YouTube identity is shared with artist navigation and preserves alternative versions', () => {
    assert.deepEqual(musicTrackIdentity(youtube), { title: 'La lumière', artist: 'Étoile' });
    assert.deepEqual(musicTrackIdentity({ type: 'youtube', name: 'La lumière [Official Audio]', channelTitle: 'Étoile - Topic' }),
        { title: 'La lumière', artist: 'Étoile' });
    assert.deepEqual(musicTrackIdentity({ type: 'youtube', title: 'Étoile // La lumière (Live) (Official Video)' }),
        { title: 'La lumière (Live)', artist: 'Étoile' });
    assert.deepEqual(musicTrackIdentity(), { title: '', artist: '' });
    assert.equal(musicTrackIdentity({ type: 'spotify', title: 'Artist - Title', artist: 'Artist' }).title, 'Artist - Title');
});

test('YouTube lyrics require one Spotify recording with the same title, main artist and compatible duration', () => {
    assert.equal(matchSpotifyLyricsTrack(youtube, [candidate]), candidate);
    assert.equal(matchSpotifyLyricsTrack({ ...youtube, duration_ms: 182000 }, [candidate]), candidate);
    assert.equal(matchSpotifyLyricsTrack(youtube, [candidate, candidate]), candidate);
    const invalid = [null, { ...candidate, id: 'invalid' }, { ...candidate, name: 'La lumière 2' },
        { ...candidate, name: 'La lumière (Live)' }, { ...candidate, name: 'La lumière (Remix)' },
        { ...candidate, artists: [{ name: 'Une chaîne de clips' }, { name: 'Étoile' }] },
        { ...candidate, artists: [] }, { ...candidate, duration_ms: 0 }, { ...candidate, duration_ms: Infinity }];
    for (const result of invalid) assert.equal(matchSpotifyLyricsTrack(youtube, [result]), null);
    assert.equal(matchSpotifyLyricsTrack({ ...youtube, duration_ms: 220000 }, [candidate]), null);
    assert.equal(matchSpotifyLyricsTrack(youtube, [candidate, { ...candidate, id: 'B'.repeat(22) }]), null);
    assert.equal(matchSpotifyLyricsTrack({ title: 'La lumière' }, [candidate]), null);
    assert.equal(matchSpotifyLyricsTrack({ artist: 'Étoile' }, [candidate]), null);
    assert.equal(matchSpotifyLyricsTrack(youtube), null);
});

test('YouTube resolves its Spotify lyrics reference through the bridge without changing the audio source', async () => {
    const original = structuredClone(youtube);
    const calls = [];
    const bridge = {
        status: async () => ({ authenticated: true }),
        search: async (query, options) => {
            calls.push('search');
            assert.equal(query, 'Étoile La lumière');
            assert.deepEqual(options, { limit: 16 });
            return { tracks: { items: [candidate] } };
        },
        getLyrics: async received => {
            calls.push('lyrics');
            assert.equal(received, id);
            return { available: true, found: true, timedLines: [{ time: 1, text: 'La lumière' }] };
        }
    };
    const result = await lookupSpotifyLyrics(youtube, bridge);
    assert.deepEqual(calls, ['search', 'lyrics']);
    assert.equal(result.sourceUrl, track.url.split('?')[0]);
    assert.equal(result.duration, 180);
    assert.equal(lyricsCanSync(result, 181), true);
    assert.deepEqual(youtube, original);
    assert.equal(await lookupSpotifyLyrics({ ...youtube, duration_ms: 220000 }, bridge), null);
    // Older playlists can contain a bare YouTube ID without a type or URL.
    assert.equal((await lookupSpotifyLyrics({ id: youtube.id, title: 'La lumière', artist: 'Étoile' }, bridge)).duration, 180);
});

test('missing, ambiguous or unavailable Spotify search never requests lyrics for a guessed track', async () => {
    for (const results of [undefined, {}, { tracks: { items: [] } }, { tracks: { items: [candidate, { ...candidate, id: 'B'.repeat(22) }] } }]) {
        assert.equal(await lookupSpotifyLyrics(youtube, {
            status: async () => ({ authenticated: true }), search: async () => results,
            getLyrics: () => assert.fail('No lyrics for an uncertain match')
        }), null);
    }
    assert.equal(await lookupSpotifyLyrics(youtube, {
        status: async () => ({ authenticated: true }), search: async () => { throw Error('Unavailable'); }
    }), null);
    assert.equal(await lookupSpotifyLyrics({ type: 'youtube', id: youtube.id }, {
        status: async () => ({ authenticated: true }), search: () => assert.fail('No identity')
    }), null);
});

test('a changed track or account cancels each asynchronous stage of YouTube lyrics lookup', async () => {
    for (const stage of ['status', 'search', 'getLyrics']) {
        let current = true;
        const bridge = {
            status: async () => { if (stage === 'status') current = false; return { authenticated: true }; },
            search: async () => {
                assert.notEqual(stage, 'status');
                if (stage === 'search') current = false;
                return { tracks: { items: [candidate] } };
            },
            getLyrics: async () => {
                assert.equal(stage, 'getLyrics');
                current = false;
                return { available: true, found: true };
            }
        };
        assert.equal(await lookupSpotifyLyrics(youtube, bridge, { isCurrent: () => current }), null);
    }
});

test('Spotify lyrics use the authenticated browser bridge and preserve the version duration guard', async () => {
    const data = { available: true, found: true, source: 'Spotify', timedLines: [{ time: 0.81, text: 'Test' }] };
    const bridge = { status: async () => ({ authenticated: true }), getLyrics: async received => {
        assert.equal(received, id);
        return data;
    } };
    const result = await lookupSpotifyLyrics(track, bridge);
    assert.equal(result.duration, 180);
    assert.deepEqual(result.timedLines, data.timedLines);
    assert.equal(lyricsCanSync(result, 181), true);
    assert.equal(lyricsCanSync(result, 185), false);
    assert.equal(lyricsCanSync(await lookupSpotifyLyrics({ ...track, duration_ms: undefined }, bridge), 180), false);
});

test('Spotify absence, invalid identities and bridge failures return no Spotify lyrics', async () => {
    const unexpected = { status: () => assert.fail('No extension request for this identity') };
    for (const url of ['https://evil.test/track/' + id, 'https://open.spotify.com/album/' + id, 'invalid', undefined]) {
        assert.equal(await lookupSpotifyLyrics({ url }, unexpected), null);
    }
    assert.equal(await lookupSpotifyLyrics(track, null), null);
    for (const bridge of [
        { status: async () => ({ authenticated: false }), getLyrics: () => assert.fail() },
        { status: async () => { throw Error('No extension'); } },
        { status: async () => ({ authenticated: true }), getLyrics: async () => { throw Error('401'); } },
        { status: async () => ({ authenticated: true }), getLyrics: async () => ({ available: true, found: false }) }
    ]) assert.equal(await lookupSpotifyLyrics(track, bridge), null);
});

test('local tracks do not trigger a backend lyrics request', async () => {
    const app = {
        currentUser: { id: 'user', role: 'user' }, currentId: 1,
        playerState: { currentTrack: { type: 'local', url: 'song.mp3' } },
        lyricsContent: { replaceChildren() {}, classList: { remove() {} } },
        lyricsStatus: {}, lyricsSync: {}, lyricsOffset: {},
        apiFetch: () => assert.fail('No backend lyrics lookup'),
        renderLyrics: () => assert.fail('No lyrics to render')
    };
    await lyricsView.loadLyrics.call(app);
    assert.match(app.lyricsStatus.textContent, /Aucune parole Spotify/);
});
