import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricsLookup, createLyricsOvhLookup, registerLyricsRoutes, lyricsIdentity } from '../../src/server/lyrics.js';
import { createYoutubeCaptions, youtubeCaptionLines } from '../../src/server/youtube-captions.js';

const track = { type: 'local', url: 'test.mp3', title: 'Titre', artist: 'Artiste', album: 'Album' };
const record = { id: 42, trackName: 'Titre', artistName: 'Artiste', albumName: 'Album', duration: 180,
    plainLyrics: 'Texte de test', syncedLyrics: '[00:01.00]Texte de test' };

test('lyrics lookup selects the matching version, bounds output and deduplicates concurrent lookups', async () => {
    let calls = 0;
    const lookup = createLyricsLookup({ wait: async () => {}, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url.origin, 'https://lrclib.net');
        assert.equal(url.searchParams.get('track_name'), 'Titre');
        assert.match(options.headers['User-Agent'], /YouPlayer/);
        assert.equal(options.redirect, 'error');
        return url.pathname === '/api/get' ? new Response('', { status: 404 }) : Response.json([{ ...record, trackName: 'Titre Live' }, { ...record, id: 1, duration: 240 }, record]);
    } });
    const [a, b] = await Promise.all([lookup(track, 180), lookup(track, 180)]);
    assert.deepEqual(a, b);
    assert.equal(calls, 2);
    assert.equal(a.sourceUrl, 'https://lrclib.net/api/get/42');
    assert.equal(a.duration, 180);
    assert.match(a.syncedLyrics, /00:01/);
    assert.equal((await lookup(track, 180)).available, true);
    assert.equal(calls, 2);
});

test('lyrics lookup rejects unrelated matches and only returns plain text for a different album', async () => {
    const other = createLyricsLookup({ wait: async () => {}, fetchImpl: async () => Response.json([{ ...record, artistName: 'Autre' }]) });
    assert.deepEqual(await other(track, 180), { available: true, found: false });
    const album = createLyricsLookup({ wait: async () => {}, fetchImpl: async () => Response.json([{ ...record, albumName: 'Autre album' }]) });
    assert.equal((await album(track, 180)).syncedLyrics, '');
    const missing = createLyricsLookup({ wait: async () => {}, fetchImpl: () => assert.fail('No metadata, no request') });
    assert.equal((await missing({ title: 'Titre' }, 0)).found, false);
});

test('lyrics service respects upstream cooldown and does not cache failures indefinitely', async () => {
    let now = 1000, calls = 0;
    const lookup = createLyricsLookup({ wait: async () => {}, now: () => now, fetchImpl: async () => {
        calls++;
        return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '120' } }) : Response.json(record);
    } });
    assert.equal((await lookup(track, 180)).available, false);
    now += 61_000;
    assert.equal((await lookup({ ...track, title: 'Autre' }, 180)).available, false);
    assert.equal(calls, 1);
    now += 200_000;
    assert.equal((await lookup(track, 180)).available, true);
    assert.equal(calls, 2);
    const huge = createLyricsLookup({ wait: async () => {}, fetchImpl: async () => new Response('x'.repeat(1_000_001)) });
    assert.equal((await huge(track, 180)).available, false);
});

test('lyrics routes bind metadata to the owned session track and reject stale keys before lookup', async () => {
    let handler, calls = 0, authorized = 0;
    registerLyricsRoutes({ get: (_path, auth, route) => { handler = async (req, res) => auth(req, res, () => route(req, res)); } }, {
        requireAuth: (_req, _res, next) => { authorized++; return next(); },
        validateSessionTrack: (req, id) => { assert.equal(req.session.userId, 'listener'); assert.equal(id, 0); return track; },
        lookup: async song => { calls++; assert.equal(song, track); return { available: true, found: false }; },
        plainLookup: async () => ({ available: true, found: false }),
        sendJsonError: (res, error) => { res.code = error.statusCode; }
    });
    const response = { set(name, value) { assert.equal(value, 'private, no-store'); }, json(value) { this.body = value; } };
    for (const query of [{ trackId: '../x', key: 'local:test.mp3' }, { trackId: '0', key: 'wrong' },
        { trackId: '0', key: 'local:test.mp3', duration: 'Infinity' }]) {
        await handler({ session: { userId: 'listener' }, query }, response);
        assert.ok([400, 409].includes(response.code));
    }
    assert.equal(calls, 0);
    await handler({ session: { userId: 'listener' }, query: { trackId: '0', key: 'local:test.mp3', duration: '180' } }, response);
    assert.equal(response.body.key, 'local:test.mp3');
    assert.equal(calls, 1);
    assert.equal(authorized, 4);
});

test('lyrics normalize YouTube decorations, Topic channels and collaborations without accepting a different artist', async () => {
    const identity = lyricsIdentity({ type: 'youtube', title: 'Artiste - Titre (Official Music Video)', channelTitle: 'Une chaîne de clips' });
    assert.equal(identity.title, 'Titre'); assert.equal(identity.primary, 'Artiste');
    assert.equal(lyricsIdentity({ title: 'Titre', artist: 'Artiste - Topic' }).artist, 'Artiste');
    const lookup = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => {
        assert.equal(url.searchParams.get('artist_name'), 'Artiste');
        assert.equal(url.searchParams.get('track_name'), 'Titre');
        return Response.json({ ...record, artistName: 'Artiste feat. Invité' });
    } });
    assert.equal((await lookup({ title: 'Titre', artist: 'Artiste, Invité' }, 180)).found, true);
    const wrong = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => url.pathname === '/api/get'
        ? Response.json({ ...record, artistName: 'Artiste feat. Autre' }) : Response.json([]) });
    assert.equal((await wrong({ title: 'Titre', artist: 'Artiste, Invité' }, 180)).found, false);
    assert.match(lyricsIdentity({ title: 'Titre (Live)', artist: 'Artiste' }).title, /Live/);
});

test('concurrent different songs are queued rather than rejected, with matching lookups deduplicated', async () => {
    const calls = [];
    let finish;
    const lookup = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => {
        calls.push(url.searchParams.get('track_name'));
        if (calls.length === 1) await new Promise(resolve => { finish = resolve; });
        return Response.json({ ...record, trackName: url.searchParams.get('track_name') });
    } });
    const first = lookup(track, 180), duplicate = lookup(track, 180);
    const second = lookup({ ...track, title: 'Second' }, 180);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['Titre']);
    finish();
    assert.equal((await first).found, true);
    assert.equal((await duplicate).found, true);
    assert.equal((await second).found, true);
    assert.deepEqual(calls, ['Titre', 'Second']);
});

test('an album mismatch does not discard text available only in timed lyrics', async () => {
    const lookup = createLyricsLookup({ wait: async () => {}, fetchImpl: async () => Response.json({ ...record, albumName: 'Autre album', plainLyrics: null }) });
    const result = await lookup(track, 180);
    assert.equal(result.syncedLyrics, '');
    assert.equal(result.plainLyrics, 'Texte de test');
});

test('YouTube fallback uses the owned played source only after lyrics are missing', async () => {
    let handler, sourceCalls = 0, captionCalls = 0;
    registerLyricsRoutes({ get: (_path, _auth, route) => { handler = route; } }, {
        requireAuth() {}, validateSessionTrack: () => track,
        lookup: async () => ({ available: true, found: false }),
        youtubeSource: async req => { assert.equal(req.sessionID, 'owned'); sourceCalls++; return 'https://www.youtube.com/watch?v=aaaaaaaaaaa'; },
        captions: async source => { captionCalls++; assert.match(source, /aaaaaaaaaaa/); return { available: true, found: true, source: 'YouTube' }; },
        plainLookup: () => assert.fail('Plain fallback must not replace YouTube subtitles'),
        sendJsonError: (_res, error) => { throw error; }
    });
    const res = { set() {}, json(value) { this.body = value; } };
    await handler({ sessionID: 'owned', query: { trackId: '0', key: 'local:test.mp3' } }, res);
    assert.equal(res.body.source, 'YouTube');
    assert.equal(sourceCalls, 1); assert.equal(captionCalls, 1);
    await assert.rejects(handler({ sessionID: 'stranger', query: { trackId: '0', key: 'wrong' } }, res), /morceau a changé/);
    assert.equal(sourceCalls, 1);
});

const captionUrl = 'https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&fmt=json3';
const captionData = { events: [
    { tStartMs: 1000, segs: [{ utf8: 'Première ' }, { utf8: 'ligne' }] },
    { tStartMs: 1100, segs: [{ utf8: 'Première ligne' }] },
    { tStartMs: 2000, segs: [{ utf8: '\n' }] },
    { tStartMs: 5000, segs: [{ utf8: 'Deuxième ligne' }] },
    { tStartMs: -1, segs: [{ utf8: 'Invalide' }] }
] };

test('YouTube captions prefer manual original-language subtitles, deduplicate cues and cache by played video', async () => {
    let executions = 0, requests = 0;
    const lookup = createYoutubeCaptions({ execFileImpl: async (program, args, options) => {
        executions++;
        assert.equal(program, 'yt-dlp'); assert.ok(args.includes('--ignore-config')); assert.ok(args.includes('--no-cookies'));
        assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=aaaaaaaaaaa']);
        assert.ok(options.timeout <= 15000); assert.ok(options.maxBuffer <= 4 * 1024 * 1024);
        return { stdout: JSON.stringify({ id: 'aaaaaaaaaaa', language: 'fr', duration: 220,
            subtitles: { fr: [{ ext: 'json3', url: captionUrl }] },
            automatic_captions: { 'fr-orig': [{ ext: 'json3', url: captionUrl }] } }) };
    }, fetchImpl: async (url, options) => {
        requests++; assert.equal(url, captionUrl); assert.equal(options.redirect, 'error'); return Response.json(captionData);
    } });
    const [first, second] = await Promise.all([lookup('https://www.youtube.com/watch?v=aaaaaaaaaaa'), lookup('https://www.youtube.com/watch?v=aaaaaaaaaaa')]);
    assert.equal(first.source, 'YouTube'); assert.equal(first.sameSource, true); assert.equal(first.automatic, false);
    assert.equal(first.language, 'fr'); assert.equal(first.duration, 220);
    assert.deepEqual(first.timedLines, [{ time: 1, text: 'Première ligne' }, { time: 5, text: 'Deuxième ligne' }]);
    assert.deepEqual(first, second); assert.equal(executions, 1); assert.equal(requests, 1);
});

test('automatic captions are identified and arbitrary input URLs or translated subtitle endpoints are refused', async () => {
    let executions = 0;
    const lookup = createYoutubeCaptions({ execFileImpl: async () => {
        executions++;
        return { stdout: JSON.stringify({ id: 'aaaaaaaaaaa', automatic_captions: { 'fr-orig': [
            { ext: 'json3', url: 'http://127.0.0.1/private' },
            { ext: 'json3', url: captionUrl + '&tlang=fr' },
            { ext: 'json3', url: captionUrl }
        ] } }) };
    }, fetchImpl: async url => { assert.equal(url, captionUrl); return Response.json(captionData); } });
    for (const source of ['file:///etc/passwd', 'https://evil.test/watch?v=aaaaaaaaaaa', 'https://www.youtube.com/watch?v=--config']) assert.equal(await lookup(source), null);
    assert.equal(executions, 0);
    assert.equal((await lookup('https://www.youtube.com/watch?v=aaaaaaaaaaa')).automatic, true);
    const bad = createYoutubeCaptions({ execFileImpl: async () => ({ stdout: JSON.stringify({ id: 'aaaaaaaaaaa', subtitles: { fr: [{ ext: 'json3', url: 'http://127.0.0.1/private' }] } }) }),
        fetchImpl: () => assert.fail('No request outside the timedtext endpoint') });
    assert.equal(await bad('https://www.youtube.com/watch?v=aaaaaaaaaaa'), null);
    assert.deepEqual(youtubeCaptionLines({ events: null }), []);
});

test('featuring annotations can move between title and artist fields while live versions stay distinct', async () => {
    const lookup = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => {
        assert.equal(url.searchParams.get('track_name'), 'Titre');
        return Response.json({ ...record, trackName: 'Titre', artistName: 'Artiste, Invité' });
    } });
    assert.equal((await lookup({ title: 'Titre (feat. Invité)', artist: 'Artiste' }, 180)).found, true);
    const live = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => url.pathname === '/api/get'
        ? Response.json({ ...record, trackName: 'Titre (Live)' }) : Response.json([]) });
    assert.equal((await live(track, 180)).found, false);
});

test('a failing exact endpoint still tries search, and the provider queue stays bounded', async () => {
    const requests = [];
    const lookup = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => {
        requests.push(url.pathname);
        return url.pathname === '/api/get' ? new Response('', { status: 500 }) : Response.json([record]);
    } });
    assert.equal((await lookup(track, 180)).found, true);
    assert.deepEqual(requests, ['/api/get', '/api/search']);
    let count = 0;
    const bounded = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => {
        count++; return Response.json({ ...record, trackName: url.searchParams.get('track_name') });
    } });
    const results = await Promise.all(Array.from({ length: 17 }, (_, index) => bounded({ ...track, title: `Titre ${index}` }, 180)));
    assert.equal(results.filter(item => item.found).length, 16);
    assert.equal(count, 16);
});

test('unknown audio duration chooses complete text over an arbitrary short exact result', async () => {
    const full = 'Texte complet de test. '.repeat(20);
    const lookup = createLyricsLookup({ wait: async () => {}, fetchImpl: async url => url.pathname === '/api/get'
        ? Response.json({ ...record, plainLyrics: 'Test', syncedLyrics: '[00:01.00]Test' })
        : Response.json([{ ...record, id: 43, plainLyrics: full }]) });
    const result = await lookup(track, 0);
    assert.equal(result.sourceUrl, 'https://lrclib.net/api/get/43');
    assert.equal(result.plainLyrics, full);
});

test('lyrics.ovh encodes normalized metadata, deduplicates requests and only returns bounded plain text', async () => {
    let calls = 0;
    const lookup = createLyricsOvhLookup({ wait: async () => {}, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.lyrics.ovh/v1/Artiste/Titre%20%2F%20Test');
        assert.equal(options.redirect, 'error'); assert.ok(options.signal);
        assert.match(options.headers['User-Agent'], /YouPlayer/);
        return Response.json({ lyrics: ' \nTexte <img src=x> de test\n ', syncedLyrics: '[00:01.00]Fake', duration: 180, token: 'private' });
    } });
    const song = { type: 'spotify', artist: 'Artiste, Invité', title: 'Titre / Test' };
    const [first, second] = await Promise.all([lookup(song), lookup(song)]);
    assert.deepEqual(first, second);
    assert.equal(first.source, 'lyrics.ovh'); assert.equal(first.plainLyrics, 'Texte <img src=x> de test');
    assert.equal(first.syncedLyrics, ''); assert.equal(first.duration, null); assert.equal(first.token, undefined);
    assert.equal(first.sourceUrl, 'https://api.lyrics.ovh/v1/Artiste/Titre%20%2F%20Test');
    await lookup(song); assert.equal(calls, 1);
    const long = createLyricsOvhLookup({ fetchImpl: async () => Response.json({ lyrics: 'x'.repeat(100_001) }) });
    assert.equal((await long(track)).plainLyrics.length, 100_000);
});

test('lyrics.ovh caches missing lyrics, rejects malformed responses and recovers from temporary failures', async () => {
    let now = 1000, calls = 0;
    const lookup = createLyricsOvhLookup({ now: () => now, wait: async () => {}, fetchImpl: async () => {
        calls++;
        return calls === 1 ? new Response('', { status: 404 }) : Response.json({ lyrics: 'Texte' });
    } });
    assert.deepEqual(await lookup(track), { available: true, found: false });
    await lookup(track); assert.equal(calls, 1);
    now += 5 * 60_000 + 1;
    assert.equal((await lookup(track)).found, true); assert.equal(calls, 2);
    for (const response of [Response.json({ lyrics: null }), new Response('bad JSON'), new Response('x'.repeat(1_000_001)), new Response('', { status: 502 })]) {
        const failed = createLyricsOvhLookup({ fetchImpl: async () => response });
        assert.equal((await failed(track)).available, false);
    }
    const blank = createLyricsOvhLookup({ fetchImpl: async () => Response.json({ lyrics: ' \n ' }) });
    assert.equal((await blank(track)).found, false);
    const missing = createLyricsOvhLookup({ fetchImpl: () => assert.fail('No metadata, no request') });
    assert.equal((await missing({ title: 'Titre' })).found, false);
});

test('lyrics.ovh respects Retry-After and bounds concurrent work without rejecting normal queued requests', async () => {
    let now = 1000, calls = 0;
    const lookup = createLyricsOvhLookup({ now: () => now, wait: async () => {}, fetchImpl: async () => {
        calls++;
        return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '120' } }) : Response.json({ lyrics: 'Texte' });
    } });
    assert.equal((await lookup(track)).available, false);
    now += 61_000;
    assert.equal((await lookup({ ...track, title: 'Autre' })).available, false); assert.equal(calls, 1);
    now += 200_000;
    assert.equal((await lookup(track)).found, true); assert.equal(calls, 2);
    let requests = 0;
    const bounded = createLyricsOvhLookup({ wait: async () => {}, fetchImpl: async () => { requests++; return Response.json({ lyrics: 'Texte' }); } });
    const songs = Array.from({ length: 17 }, (_, index) => ({ ...track, title: `Titre ${index}` }));
    const results = await Promise.all(songs.map(song => bounded(song)));
    assert.equal(requests, 16); assert.equal(results.filter(result => result.found).length, 16);
});

test('lyrics pipeline keeps provider priority and uses lyrics.ovh for missing or failed upstream sources', async () => {
    for (const scenario of ['lrclib', 'youtube', 'plain', 'caption-error', 'legacy-cache']) {
        const calls = [];
        let handler;
        registerLyricsRoutes({ get: (_path, _auth, route) => { handler = route; } }, {
            requireAuth() {}, validateSessionTrack: () => track,
            lookup: async song => { calls.push('lrclib'); assert.equal(song, track); return scenario === 'lrclib'
                ? { available: true, found: true, source: 'LRCLIB' } : { available: false }; },
            youtubeSource: async () => { calls.push('source'); return scenario === 'legacy-cache' ? null : 'https://www.youtube.com/watch?v=aaaaaaaaaaa'; },
            captions: async () => {
                calls.push('youtube'); if (scenario === 'caption-error') throw Error('Synthetic provider failure');
                return scenario === 'youtube' ? { available: true, found: true, source: 'YouTube' } : null;
            },
            plainLookup: async song => { calls.push('plain'); assert.equal(song, track); return { available: true, found: true, source: 'lyrics.ovh', plainLyrics: 'Texte' }; },
            sendJsonError: (_res, error) => { throw error; }
        });
        const response = { set(_name, value) { assert.equal(value, 'private, no-store'); }, json(data) { this.data = data; } };
        const req = { query: { trackId: '0', key: 'local:test.mp3', artist: 'Injected', title: 'Injected' } };
        await handler(req, response);
        assert.equal(response.data.key, 'local:test.mp3');
        if (scenario === 'lrclib') { assert.deepEqual(calls, ['lrclib']); assert.equal(response.data.source, 'LRCLIB'); }
        else if (scenario === 'youtube') { assert.deepEqual(calls, ['lrclib', 'source', 'youtube']); assert.equal(response.data.source, 'YouTube'); }
        else { assert.equal(response.data.source, 'lyrics.ovh'); assert.equal(calls.at(-1), 'plain'); }
        const before = calls.length;
        await assert.rejects(handler({ query: { ...req.query, key: 'wrong' } }, response), /morceau a changé/);
        assert.equal(calls.length, before);
    }
});

test('the six raw YouTube titles normalize to the metadata accepted by the plain provider', async () => {
    const cases = [
        ["Jul - J'oublie tout [Son Officiel]", 'Liga One Industry', 'Jul', "J'oublie tout"],
        ['PNL - Au DD [Clip Officiel]', 'PNL', 'PNL', 'Au DD'],
        ['GIMS - Sapés comme jamais (Clip officiel) ft. Niska', 'GIMS', 'GIMS', 'Sapés comme jamais'],
        ['OrelSan - La Quête [CLIP OFFICIEL]', 'orelsan', 'OrelSan', 'La Quête'],
        ['Damso - Θ. Macarena (Clip Officiel)', 'le rappeur damso', 'Damso', 'Θ. Macarena'],
        ['Numb (Official Music Video) [4K UPGRADE] – Linkin Park', 'Linkin Park', 'Linkin Park', 'Numb']
    ];
    const requests = [];
    const lookup = createLyricsOvhLookup({ wait: async () => {}, fetchImpl: async url => {
        requests.push(new URL(url)); return Response.json({ lyrics: 'Texte de test' });
    } });
    for (const [title, channelTitle, expectedArtist, expectedTitle] of cases) {
        assert.equal((await lookup({ type: 'youtube', title, channelTitle })).found, true);
        const parts = requests.at(-1).pathname.split('/').slice(-2).map(decodeURIComponent);
        assert.deepEqual(parts, [expectedArtist, expectedTitle]);
    }
    assert.equal(lyricsIdentity({ type: 'spotify', title: 'Titre (Live)', artist: 'Artiste' }).title, 'Titre (Live)');
    assert.equal(lyricsIdentity({ type: 'spotify', title: 'Titre (Remix)', artist: 'Artiste' }).title, 'Titre (Remix)');
});
