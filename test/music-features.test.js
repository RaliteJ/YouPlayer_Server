import test from 'node:test';
import assert from 'node:assert/strict';
import { artistLinksMarkup } from '../src/artist-view.js';
import { spotifyArtists, matchSpotifyArtist } from '../src/client-utils.js';
import { parseLrc, lyricsCanSync } from '../src/lyrics-view.js';
import { sanitizeTrackInput } from '../src/server/validation.js';
import { spotifyTrackToStoredTrack, spotifyWebApiTrackToStoredTrack, toFinalStoredTrack } from '../src/server/spotify-metadata.js';

const artist = { id: 'A'.repeat(22), name: 'Artiste Étoile' };

test('Spotify artist identities survive imports and validation without bearer fields', () => {
    const identities = [artist];
    const web = spotifyWebApiTrackToStoredTrack({ name: 'Titre', artists: [{ ...artist, token: 'private' }], id: 'B'.repeat(22) });
    const pathfinder = spotifyTrackToStoredTrack({ name: 'Titre', uri: `spotify:track:${'B'.repeat(22)}`,
        artists: { items: [{ uri: `spotify:artist:${artist.id}`, profile: { name: artist.name } }] } });
    for (const track of [web, pathfinder]) {
        assert.deepEqual(track.spotifyArtists, identities);
        assert.deepEqual(sanitizeTrackInput(track).spotifyArtists, identities);
        assert.deepEqual(toFinalStoredTrack(track).spotifyArtists, identities);
    }
    assert.deepEqual(spotifyArtists({ items: {} }), []);
    assert.deepEqual(spotifyArtists([{ id: 'javascript:alert(1)', name: 'Bad' }]), []);
});

test('YouTube artist mapping requires the same title and a unique matching artist identity', () => {
    const track = { name: 'Le titre', artists: [artist] };
    assert.deepEqual(matchSpotifyArtist({ name: 'artiste etoile', title: 'Le Titre' }, [track]), artist);
    assert.equal(matchSpotifyArtist({ name: artist.name, title: 'Le titre (Live)' }, [track]), null);
    assert.equal(matchSpotifyArtist({ name: 'Une chaîne de clips', title: 'Le titre' }, [track]), null);
    assert.equal(matchSpotifyArtist({ name: artist.name, title: 'Le titre' }, [track, { ...track, artists: [{ ...artist, id: 'C'.repeat(22) }] }]), null);
    assert.deepEqual(matchSpotifyArtist({ name: artist.name, title: 'Le titre' }, [track, track]), artist);
    assert.deepEqual(matchSpotifyArtist({ name: 'artiste etoile' }, [], [artist]), artist);
    assert.equal(matchSpotifyArtist({ name: artist.name }, [], [artist, { ...artist, id: 'C'.repeat(22) }]), null);
    assert.equal(matchSpotifyArtist({ name: 'Une chaîne de clips' }, [], [artist]), null);
    assert.equal(matchSpotifyArtist({ name: artist.name, title: 'Le titre' }, [track, { ...track, artists: [{ ...artist, id: 'C'.repeat(22) }] }], [artist]), null);
});

test('artist links escape names and preserve separate collaborators', () => {
    const markup = artistLinksMarkup({ title: '<Titre>', spotifyArtists: [artist, { id: 'C'.repeat(22), name: '<Autre>' }] });
    assert.equal((markup.match(/data-track-artist=/g) || []).length, 2);
    assert.match(markup, /&lt;Autre&gt;/);
    assert.match(markup, /data-artist-track="&lt;Titre&gt;"/);
    assert.equal(artistLinksMarkup(null), '');
    const youtube = artistLinksMarkup({ type: 'youtube', title: 'Artiste - Titre (Official Music Video)', channelTitle: 'Une chaîne de clips' });
    assert.match(youtube, /data-track-artist="Artiste"/);
    assert.match(youtube, /data-artist-track="Titre"/);
    assert.match(artistLinksMarkup({ artist: 'Artiste - Topic', title: 'Titre' }), /data-track-artist="Artiste"/);
});

test('LRC parsing handles fractions, repeated timestamps and safe duration gating', () => {
    assert.deepEqual(parseLrc('[ar:Test]\n[00:01.5]Première\n[00:03.025][00:05.20]Refrain\n[00:04.00]'), [
        { time: 1.5, text: 'Première' }, { time: 3.025, text: 'Refrain' },
        { time: 4, text: '' }, { time: 5.2, text: 'Refrain' }
    ]);
    assert.deepEqual(parseLrc('[offset:1200]\n[00:01.00]Texte'), []);
    assert.equal(lyricsCanSync({ duration: 180 }, 181.9), true);
    for (const duration of [0, NaN, Infinity, 183, 160]) assert.equal(lyricsCanSync({ duration: 180 }, duration), false);
    assert.equal(lyricsCanSync({ duration: null }, 180), false);
    assert.equal(lyricsCanSync({ source: 'YouTube', sameSource: true }, 0), true);
    assert.equal(lyricsCanSync({ source: 'YouTube', sameSource: false }, 0), false);
    assert.equal(lyricsCanSync({ source: 'LRCLIB', sameSource: true }, 0), false);
    assert.equal(lyricsCanSync({ source: 'lyrics.ovh', sameSource: true, duration: 180 }, 180), false);
});
