import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectMusicMatch, resolveMusicTrack, searchMusicTrack, searchYoutubeVideos } from '../../src/server/music-resolver.js';
import {
	deleteDownloadedTrack,
	download_spotify,
	resolveYoutubeStreamSource,
	youtubeDownloadArgs
} from '../../src/server/download.js';
import { resolvePlaylistYoutubeIds } from '../../src/server/spotify.js';
import { sanitizeTrackInput } from '../../src/server/validation.js';

const song = { title: 'La lumière', artist: 'Étoile', album: 'Nuit', duration_ms: 180000 };
function candidate(overrides = {}) {
	return { videoId: 'correct0001', name: 'La lumière', artist: { name: 'Étoile' }, album: { name: 'Nuit' }, duration: 180, ...overrides };
}

test('the right artist wins over the first homonymous YouTube Music result', () => {
	const wrong = candidate({ videoId: 'wrong000001', artist: { name: 'Autre artiste' } });
	assert.equal(selectMusicMatch(song, [wrong, candidate()]).videoId, 'correct0001');
	assert.equal(selectMusicMatch(song, [wrong]), null);
});

test('nearby titles and partial artist names are rejected', () => {
	assert.equal(selectMusicMatch({ title: 'Stay', artist: 'Ann' }, [candidate({ name: 'Stay With Me', artist: { name: 'Ann' } })]), null);
	assert.equal(selectMusicMatch({ title: 'Stay', artist: 'Ann' }, [candidate({ name: 'Stay', artist: { name: 'Joann' } })]), null);
	assert.equal(selectMusicMatch(song, [candidate({ name: 'La nuit' })]), null);
	assert.equal(selectMusicMatch({ ...song, artist: 'The Northern Orchestra A' }, [candidate({ artist: { name: 'The Northern Orchestra B' } })]), null);
	assert.equal(selectMusicMatch({ ...song, title: 'La lumière 1' }, [candidate({ name: 'La lumière 2' })]), null);
});

test('unrequested alternative versions are rejected, even when first', () => {
	for (const version of ['Live', 'Cover', 'Remix', 'Slowed', 'Karaoke', 'Instrumental', 'Remastered']) {
		const alternative = candidate({ name: `La lumière (${version})` });
		assert.equal(selectMusicMatch(song, [alternative]), null, version);
		assert.equal(selectMusicMatch({ ...song, title: `La lumière (${version})` }, [alternative]), alternative);
		assert.equal(selectMusicMatch({ ...song, title: `La lumière (${version})` }, [candidate()]), null);
	}
});

test('duration rejects a different recording and unknown duration remains usable', () => {
	assert.equal(selectMusicMatch(song, [candidate({ duration: 300 })]), null);
	assert.equal(selectMusicMatch(song, [candidate({ duration: 185 })]).videoId, 'correct0001');
	assert.equal(selectMusicMatch(song, [candidate({ duration: null })]).videoId, 'correct0001');
	assert.equal(selectMusicMatch({ ...song, duration_ms: undefined }, [candidate()]).videoId, 'correct0001');
});

test('album resolves equally named recordings, accents and official suffixes are tolerated', () => {
	assert.equal(selectMusicMatch(song, [candidate({ videoId: 'other000001', album: { name: 'Jour' } }), candidate()]).videoId, 'correct0001');
	assert.equal(selectMusicMatch(song, [candidate({ name: 'La lumiere (Official Audio)', artist: { name: 'Etoile - Topic' } })]).videoId, 'correct0001');
});

test('video fallback needs matching performer and title, not an arbitrary uploader', () => {
	const video = { videoId: 'correct0001', title: 'Étoile - La lumière (Official Video)', author: { name: 'Label officiel' }, seconds: 180 };
	assert.equal(selectMusicMatch(song, [video]), video);
	assert.equal(selectMusicMatch(song, [{ ...video, title: 'La lumière' }]), null);
});

test('French official clip annotations do not hide a verified title or loosen identity checks', () => {
	const track = { title: 'L.A TRICKS', artist: 'Artiste test', duration_ms: 229000 };
	for (const suffix of ['(Clip Officiel)', '[clip officiel]', 'Clip Officiel']) {
		const video = { videoId: 'correct0001', title: `Artiste test - L.A. TRICKS ${suffix}`, author: { name: 'Label test' }, seconds: 229 };
		assert.equal(selectMusicMatch(track, [video]), video, suffix);
		assert.equal(selectMusicMatch(track, [{ ...video, title: `Autre artiste - L.A. TRICKS ${suffix}` }]), null);
		assert.equal(selectMusicMatch(track, [{ ...video, title: `Artiste test - Autre titre ${suffix}` }]), null);
		assert.equal(selectMusicMatch(track, [{ ...video, title: `Artiste test - L.A. TRICKS (Live) ${suffix}` }]), null);
		assert.equal(selectMusicMatch(track, [{ ...video, seconds: 300 }]), null);
	}
});

test('French official clips can resolve Spotify streams and downloads through video fallback', async () => {
	const track = { ...song, type: 'spotify', url: 'https://open.spotify.com/track/abcdef123456' };
	const resolveTrack = input => resolveMusicTrack(input, {
		useCache: false,
		searchTrack: value => searchMusicTrack(value, {
			getMusicClient: async () => ({ searchSongs: async () => [] }),
			searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Étoile - La lumière (Clip Officiel)', seconds: 180 }] })
		})
	});
	assert.equal(await resolveYoutubeStreamSource(track, { resolveTrack }), 'https://www.youtube.com/watch?v=correct0001');
	let downloaded;
	await download_spotify([track.url, 'synthetic'], 'synthetic-session', track, {
		resolveTrack,
		downloadYoutube: async args => { downloaded = args; }
	});
	assert.deepEqual(downloaded, ['correct0001', 'synthetic']);
});

test('the main performer is required when several artists are listed', () => {
	const duet = { ...song, artist: 'Étoile, Invité' };
	assert.equal(selectMusicMatch(duet, [candidate({ artist: { name: 'Invité' } })]), null);
	assert.equal(selectMusicMatch(duet, [candidate()]).videoId, 'correct0001');
});

test('unsafe identifiers and tracks without identity are never accepted', () => {
	assert.equal(selectMusicMatch(song, [candidate({ videoId: 'https://example.test' })]), null);
	assert.equal(selectMusicMatch({ title: song.title }, [candidate()]), null);
});

test('a verified catalog match avoids extra video requests', async () => {
	let videos = 0;
	const match = await searchMusicTrack(song, {
		getMusicClient: async () => ({ searchSongs: async () => [candidate()] }),
		searchVideos: async () => { videos++; return { videos: [] }; }
	});
	assert.equal(match.videoId, 'correct0001');
	assert.equal(videos, 0);
});

test('an unavailable catalog or a bad match uses validated video fallback', async () => {
	for (const unavailable of [true, false]) {
		const match = await searchMusicTrack(song, {
			getMusicClient: async () => {
				if (unavailable) throw new Error('private response must not be shown');
				return { searchSongs: async () => [candidate({ artist: { name: 'Wrong artist' } })] };
			},
			searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Étoile - La lumière', seconds: 180 }] })
		});
		assert.equal(match.videoId, 'correct0001');
	}
});

test('the video fallback delegates a bounded search to yt-dlp without a shell', async () => {
	let invocation;
	const result = await searchYoutubeVideos('Étoile - La lumière', {
		execFileImpl: async (binary, args, options) => {
			invocation = { binary, args, options };
			return { stdout: JSON.stringify({ entries: [{
				id: 'correct0001',
				title: 'Étoile - La lumière',
				uploader: 'Étoile - Topic',
				duration: 180
			}] }) };
		}
	});
	assert.equal(invocation.binary, 'yt-dlp');
	assert.equal(invocation.args.at(-1), 'ytsearch10:Étoile - La lumière');
	assert.equal(invocation.options.timeout, 12000);
	assert.deepEqual(result.videos[0], {
		videoId: 'correct0001',
		title: 'Étoile - La lumière',
		author: { name: 'Étoile - Topic' },
		seconds: 180
	});
});

test('no matching candidate produces a local error instead of an arbitrary first link', async () => {
	await assert.rejects(resolveMusicTrack(song, { useCache: false, searchTrack: async () => candidate({ artist: { name: 'Wrong' } }) }), /Aucune correspondance/);
	await assert.rejects(searchMusicTrack(song, { getMusicClient: async () => { throw Error('secret'); }, searchVideos: async () => { throw Error('secret'); } }), /^Error: Recherche musicale indisponible$/);
});

test('simultaneous stream and cache download share resolution and retain source metadata', async () => {
	let calls = 0;
	const cached = { ...song, title: 'Cache unique', type: 'spotify', url: 'https://open.spotify.com/track/abcdef123456' };
	const searchTrack = async () => { calls++; return candidate({ name: cached.title }); };
	const [first, second] = await Promise.all([resolveMusicTrack(cached, { searchTrack }), resolveMusicTrack(cached, { searchTrack })]);
	assert.equal(calls, 1);
	assert.equal(first.id, second.id);
	assert.equal(first.title, cached.title);
	assert.equal(first.url, cached.url);
	assert.equal(first.type, 'spotify');
	await resolveMusicTrack(cached, { searchTrack });
	assert.equal(calls, 1);
});

test('failed resolution is retryable and never enters the cache', async () => {
	const track = { ...song, title: 'Retry unique' };
	await assert.rejects(resolveMusicTrack(track, { searchTrack: async () => null }), /Aucune correspondance/);
	const retried = await resolveMusicTrack(track, { searchTrack: async () => candidate({ name: track.title }) });
	assert.equal(retried.id, 'correct0001');
});

test('Spotify streams recheck old IDs while explicitly selected YouTube videos keep their source', async () => {
	let calls = 0;
	const options = { resolveTrack: async () => { calls++; return { id: 'correct0001' }; } };
	assert.equal(await resolveYoutubeStreamSource({ ...song, type: 'spotify', id: 'wrong000001' }, options), 'https://www.youtube.com/watch?v=correct0001');
	assert.equal(calls, 1);
	assert.equal(await resolveYoutubeStreamSource({ type: 'youtube', id: 'chosen00001' }, options), 'https://www.youtube.com/watch?v=chosen00001');
	assert.equal(calls, 1);
});

test('Spotify downloads use the corrected ID and preserve their destination', async () => {
	const source = { ...song, type: 'spotify', id: 'wrong000001', url: 'https://open.spotify.com/track/abcdef123456' };
	let downloaded;
	await download_spotify([source.url, 'synthetic'], 'synthetic-session', source, {
		resolveTrack: async track => { assert.equal(track, source); return { ...track, id: 'correct0001' }; },
		downloadYoutube: async (args, session) => { downloaded = { args, session }; }
	});
	assert.deepEqual(downloaded, { args: ['correct0001', 'synthetic'], session: 'synthetic-session' });
});

test('playlist imports retain Spotify identity and duration even when resolution fails', async () => {
	const tracks = await resolvePlaylistYoutubeIds([
		{ ...song, url: 'https://open.spotify.com/track/abcdef123456', id: 'wrong000001' },
		{ ...song, url: 'https://open.spotify.com/track/abcdef654321', id: 'wrong000002' }
	], { resolveTrack: async track => {
		if (track.url.endsWith('654321')) throw Error('not found');
		return { ...track, id: 'correct0001' };
	} });
	assert.equal(tracks[0].id, 'correct0001');
	assert.equal(tracks[0].type, 'spotify');
	assert.equal(tracks[0].duration_ms, 180000);
	assert.equal(tracks[1].id, '');
	assert.equal(tracks[1].type, 'spotify');
});

test('Spotify duration crosses input validation only when finite and bounded', () => {
	const payload = { ...song, type: 'spotify', url: 'https://open.spotify.com/track/abcdef123456' };
	assert.equal(sanitizeTrackInput(payload).duration_ms, 180000);
	for (const duration_ms of [-1, Infinity, 'NaN', 86400001]) {
		assert.equal(sanitizeTrackInput({ ...payload, duration_ms }).duration_ms, undefined);
	}
});

test('yt-dlp download arguments preserve the existing audio contract without a shell wrapper', () => {
	const args = youtubeDownloadArgs('https://www.youtube.com/watch?v=correct0001', 'session-test', 'track-test', {
		nodeBinary: '/usr/bin/node'
	});
	assert.deepEqual(args.slice(0, 6), [
		'--js-runtimes', 'node:/usr/bin/node', '--remote-components', 'ejs:github', '--extract-audio', '--audio-format'
	]);
	assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=correct0001');
	assert.match(args[args.indexOf('--output') + 1], /session-test\/track-test\.%\(ext\)s$/);
});

test('audio cache deletion refuses paths outside the private media root', async () => {
	await assert.rejects(() => deleteDownloadedTrack('../track', '../session'), /Chemin de cache/);
});

test('audio cache deletion removes only the requested file in its own session', async () => {
	const musiqDir = await mkdtemp(path.join(tmpdir(), 'youplayer-cache-delete-'));
	try {
		await mkdir(path.join(musiqDir, 'other'));
		await mkdir(path.join(musiqDir, 'current'));
		await writeFile(path.join(musiqDir, 'other', 'track.mp3'), 'synthetic');
		await writeFile(path.join(musiqDir, 'current', 'track.mp3'), 'synthetic');
		await assert.rejects(deleteDownloadedTrack('../other/track', 'current', { musiqDir }), /Chemin de cache/);
		await assert.rejects(deleteDownloadedTrack('track', 'current/../other', { musiqDir }), /Chemin de cache/);
		await deleteDownloadedTrack('track', 'current', { musiqDir });
		await deleteDownloadedTrack('track', 'current', { musiqDir });
		await assert.rejects(readFile(path.join(musiqDir, 'current', 'track.mp3')), { code: 'ENOENT' });
		assert.equal(await readFile(path.join(musiqDir, 'other', 'track.mp3'), 'utf8'), 'synthetic');
	} finally {
		await rm(musiqDir, { recursive: true, force: true });
	}
});
