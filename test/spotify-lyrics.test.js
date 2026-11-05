import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupSpotifyLyrics, lyricsCanSync, lyricsView } from '../src/lyrics-view.js';

const id = 'A'.repeat(22);
const track = { url: `https://open.spotify.com/track/${id}?si=test`, duration_ms: 180000 };

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
