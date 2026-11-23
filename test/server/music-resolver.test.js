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

test('double-slash video titles and explicit featuring keep the main artist identity', () => {
	const track = { title: 'Titre test', artist: 'Jul, Invité', duration_ms: 180000 };
	for (const title of ['JUL // Titre test (Clip Officiel)', 'JUL feat. Invité - Titre test']) {
		const video = { videoId: 'correct0001', title, seconds: 180 };
		assert.equal(selectMusicMatch(track, [video]), video);
		assert.equal(selectMusicMatch(track, [{ ...video, seconds: 300 }]), null);
	}
	assert.equal(selectMusicMatch(track, [{ videoId: 'correct0001', title: 'Invité // Titre test', seconds: 180 }]), null);
});

test('excluded catalog candidates allow another verified video without reusing the failed source', async () => {
	const options = {
		excludeIds: ['correct0001'],
		getMusicClient: async () => ({ searchSongs: async () => [candidate()] }),
		searchVideos: async () => ({ videos: [candidate(), candidate({ videoId: 'other000001' })] })
	};
	assert.equal((await searchMusicTrack(song, options)).videoId, 'other000001');
	assert.equal(await searchMusicTrack(song, { ...options, excludeIds: ['correct0001', 'other000001'] }), null);
});

test('retry resolution bypasses a cached failed source and validates exclusions', async () => {
	const track = { ...song, title: 'Excluded cache test' };
	const searchTrack = async (_, { excludeIds }) => candidate({
		name: track.title, videoId: excludeIds.length ? 'other000001' : 'correct0001'
	});
	assert.equal((await resolveMusicTrack(track, { searchTrack })).id, 'correct0001');
	assert.equal((await resolveMusicTrack(track, { searchTrack, excludeIds: ['correct0001'] })).id, 'other000001');
	await assert.rejects(resolveMusicTrack(track, {
		excludeIds: ['correct0001'], searchTrack: async () => candidate({ name: track.title })
	}), /Aucune correspondance/);
});

test('Spotify retries another source for the same track and destination before skipping', async () => {
	const attempts = [];
	const result = await download_spotify(['spotify-url', 'destination'], 'session', song, {
		resolveTrack: async (track, { excludeIds }) => {
			assert.equal(track, song);
			return { ...track, id: excludeIds.length ? 'other000001' : 'correct0001' };
		},
		downloadYoutube: async (args, session) => {
			attempts.push({ args, session });
			if (args[0] === 'correct0001') throw new Error('Video unavailable');
			return 'downloaded';
		}
	});
	assert.equal(result, 'downloaded');
	assert.deepEqual(attempts, [
		{ args: ['correct0001', 'destination'], session: 'session' },
		{ args: ['other000001', 'destination'], session: 'session' }
	]);
});

test('Spotify retries are bounded and never download the same failed source twice', async () => {
	let downloads = 0;
	await assert.rejects(download_spotify(['url', 'destination'], 'session', song, {
		resolveTrack: async (_, { excludeIds }) => ({ id: `video00000${excludeIds.length}` }),
		downloadYoutube: async () => { downloads++; throw new Error('Unavailable'); }
	}), /Unavailable/);
	assert.equal(downloads, 3);
	downloads = 0;
	await assert.rejects(download_spotify(['url', 'destination'], 'session', song, {
		resolveTrack: async () => ({ id: 'correct0001' }),
		downloadYoutube: async () => { downloads++; throw new Error('Unavailable'); }
	}), /Aucune autre correspondance/);
	assert.equal(downloads, 1);
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
	assert.ok(args.includes('--check-formats'), 'unavailable formats are skipped before downloading the resumed audio');
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

test('a forced manual source drives both pipelines without the automatic resolver', async () => {
	const spotifyTrack = {
		...song, type: 'spotify', id: 'wrong000001', url: 'https://open.spotify.com/track/' + 'B'.repeat(22)
	};
	const forced = { ...spotifyTrack, __sourceOverride: 'forced00001' };
	let autoCalls = 0;
	const autoResolver = async () => { autoCalls++; throw new Error('Ne doit pas être appelé'); };
	const canonical = 'https://www.youtube.com/watch?v=forced00001';

	assert.equal(await resolveYoutubeStreamSource(forced, { resolveTrack: autoResolver }), canonical);

	const downloads = [];
	assert.equal(await download_spotify([spotifyTrack.url, 'forced-track'], 'synthetic-session', forced, {
		resolveTrack: autoResolver,
		downloadYoutube: async ([source, destination], session) => {
			downloads.push({ source, destination, session });
			return 'downloaded';
		}
	}), 'downloaded');
	assert.deepEqual(downloads, [{
		source: canonical, destination: 'forced-track', session: 'synthetic-session'
	}], 'the forced download calls yt-dlp directly with the exact source');
	assert.equal(autoCalls, 0);
	assert.equal(forced.id, 'wrong000001', 'the Spotify identity of the track is preserved');
	assert.equal(spotifyTrack.__sourceOverride, undefined, 'session items never carry the override');

	await assert.rejects(download_spotify([spotifyTrack.url, 'failed-track'], 'synthetic-session', {
		...forced, __sourceOverride: 'banned00001'
	}, {
		resolveTrack: autoResolver,
		// No silent alternative: a failing forced source stays a failure.
		downloadYoutube: async () => { throw new Error('Source indisponible'); }
	}), /Source indisponible/);
	assert.equal(autoCalls, 0);
});

const julSong = { title: 'Alors la zone', artist: 'Jul', duration_ms: 206000 };
function youtubeMusicVideo(overrides = {}) {
	// Simplified real shape from ytmusic-api 5.3.1 VideoParser.parseSearchResult.
	return { type: 'VIDEO', videoId: '0jYCePaBl2A', name: 'Alors la zone', artist: { artistId: 'jul-topic', name: 'JuL' }, duration: 206, ...overrides };
}

test('YouTube Music videos are matched after song results, without yt-dlp', async () => {
	const calls = [];
	let inits = 0;
	let ytDlpCalls = 0;
	const match = await searchMusicTrack(julSong, {
		getMusicClient: async () => {
			inits += 1;
			return {
				searchSongs: async () => { calls.push('songs'); return [candidate()]; },
				searchVideos: async () => { calls.push('videos'); return [youtubeMusicVideo()]; }
			};
		},
		searchVideos: async () => { ytDlpCalls++; return { videos: [] }; }
	});
	assert.equal(match.videoId, '0jYCePaBl2A');
	assert.deepEqual(calls, ['songs', 'videos'], 'the video search runs right after the song search');
	assert.equal(inits, 1, 'the music client is acquired once per lookup');
	assert.equal(ytDlpCalls, 0, 'a YouTube Music video match avoids the yt-dlp fallback');
});

test('a failed music client initialization is never retried within the same lookup', async () => {
	let inits = 0;
	const match = await searchMusicTrack(julSong, {
		getMusicClient: async () => {
			inits += 1;
			throw new Error('initialization failed');
		},
		searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Jul - Alors la zone', seconds: 206 }] })
	});
	assert.equal(inits, 1, 'the dependency is initialized at most once');
	assert.equal(match.videoId, 'correct0001', 'the general YouTube fallback stays available');
});

const julAlbumSong = { title: 'La miss', artist: 'Jul', album: 'Indépendance', duration_ms: 241000 };
function albumEntry(overrides = {}) {
	// Simplified real shape from ytmusic-api 5.3.1 searchAlbums results.
	return { albumId: 'MPREb_tGpxSJ6rn2s', name: 'Indépendance', artist: { name: 'JuL' }, ...overrides };
}

test('an exact YouTube Music album track is matched after videos, without yt-dlp', async () => {
	const calls = [];
	let inits = 0;
	let ytDlpCalls = 0;
	const match = await searchMusicTrack(julAlbumSong, {
		getMusicClient: async () => {
			inits += 1;
			return {
				searchSongs: async () => { calls.push('songs'); return [candidate()]; },
				searchVideos: async () => { calls.push('videos'); return [youtubeMusicVideo({ name: 'La miss (Live)' })]; },
				searchAlbums: async query => {
					calls.push(`albums:${query}`);
					return [albumEntry({ albumId: 'wrong11111a', name: 'Indépendances' }), albumEntry()];
				},
				getAlbum: async albumId => {
					calls.push(`album:${albumId}`);
					return {
						name: 'Indépendance',
						artist: { name: 'JuL' },
						songs: [{ videoId: 'p3sDHWA51ag', name: 'La miss', artist: { name: 'JuL' }, duration: 242, album: { name: 'Indépendance' } }]
					};
				}
			};
		},
		searchVideos: async () => { ytDlpCalls++; return { videos: [] }; }
	});
	assert.equal(match.videoId, 'p3sDHWA51ag');
	assert.equal(match.duration, 242, 'the matched song keeps its album detail');
	assert.deepEqual(calls, ['songs', 'videos', 'albums:Jul Indépendance', 'album:MPREb_tGpxSJ6rn2s']);
	assert.equal(inits, 1, 'the music client is acquired once per lookup');
	assert.equal(ytDlpCalls, 0, 'a verified album match avoids the yt-dlp fallback');
});

test('the album branch only trusts exact ones and keeps the fallback for everything else', async () => {
	const rejected = await searchMusicTrack(julAlbumSong, {
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [
				albumEntry({ name: 'Indépendance', artist: { name: 'Autre artiste' } }),
				albumEntry({ name: 'Autre album' })
			],
			getAlbum: async () => { throw new Error('must not be called'); }
		}),
		searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Jul - La miss', seconds: 241 }] })
	});
	assert.equal(rejected.videoId, 'correct0001', 'a homonymous album never reaches the detail');

	const mismatchedDetail = await searchMusicTrack(julAlbumSong, {
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [albumEntry()],
			getAlbum: async () => ({ name: 'Autre nom', artist: { name: 'JuL' }, songs: [] })
		}),
		searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Jul - La miss', seconds: 241 }] })
	});
	assert.equal(mismatchedDetail.videoId, 'correct0001', 'an unverifiable detail never provides songs');

	const explicitCredit = await searchMusicTrack(julAlbumSong, {
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [albumEntry()],
			getAlbum: async () => ({
				name: 'Indépendance',
				artist: { name: 'JuL' },
				songs: [{ videoId: 'p3sDHWA51ag', name: 'La miss', artist: { name: 'Autre artiste' }, duration: 242 }]
			})
		}),
		searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Jul - La miss', seconds: 241 }] })
	});
	assert.equal(explicitCredit.videoId, 'correct0001', 'an explicit song credit is never overwritten');

	const inherited = await searchMusicTrack(julAlbumSong, {
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [albumEntry()],
			getAlbum: async () => ({
				name: 'Indépendance',
				artist: { name: 'JuL' },
				songs: [{ videoId: 'p3sDHWA51ag', name: 'La miss', duration: 242 }]
			})
		}),
		searchVideos: async () => { throw new Error('unavailable'); }
	});
	assert.equal(inherited.videoId, 'p3sDHWA51ag', 'a song without credit inherits from the verified album');

	const excluded = await searchMusicTrack(julAlbumSong, {
		excludeIds: ['p3sDHWA51ag'],
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [albumEntry()],
			getAlbum: async () => ({
				name: 'Indépendance',
				artist: { name: 'JuL' },
				songs: [{ videoId: 'p3sDHWA51ag', name: 'La miss', artist: { name: 'JuL' }, duration: 242 }]
			})
		}),
		searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Jul - La miss', seconds: 241 }] })
	});
	assert.equal(excluded.videoId, 'correct0001', 'an excluded album song is skipped');

	const noAlbum = await searchMusicTrack(julSong, {
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => { throw new Error('videos unavailable'); },
			searchAlbums: async () => { throw new Error('must not be called'); },
			getAlbum: async () => { throw new Error('must not be called'); }
		}),
		searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Jul - Alors la zone', seconds: 206 }] })
	});
	assert.equal(noAlbum.videoId, 'correct0001', 'a track without an album never queries albums');
});

function rawAlbumShelf(rows) {
	return {
		contents: {
			twoColumnBrowseResultsRenderer: {
				secondaryContents: {
					sectionListRenderer: {
						contents: [
							{
								musicShelfRenderer: {
									contents: rows.map(row => ({
										musicResponsiveListItemRenderer: {
											playlistItemData: { videoId: row.videoId },
											flexColumns: [{
												musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: row.title }] } }
											}]
										}
									}))
								}
							}
						]
					}
				}
			}
		}
	};
}

test('album songs with empty names are refilled from the verified shelf rows once', async () => {
	const calls = [];
	let ytDlpCalls = 0;
	const match = await searchMusicTrack(julAlbumSong, {
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [albumEntry()],
			getAlbum: async () => ({
				name: 'Indépendance',
				artist: { name: 'JuL' },
				songs: [
					// 5.3.1 parseAlbumSong keeps the name empty without musicVideoType.
					{ videoId: 'p3sDHWA51ag', name: '', artist: { name: 'JuL' }, duration: 242 },
					{ videoId: 'other000001', name: 'La mi', artist: { name: 'JuL' }, duration: 242, album: { name: 'Indépendance' } }
				]
			}),
			constructRequest: async (endpoint, payload) => {
				calls.push([endpoint, payload]);
				return rawAlbumShelf([
					{ videoId: 'p3sDHWA51ag', title: 'La miss' },
					{ videoId: 'other000001', title: 'La miss' }
				]);
			}
		}),
		searchVideos: async () => { ytDlpCalls++; return { videos: [] }; }
	});
	assert.equal(match.videoId, 'p3sDHWA51ag', 'only the unnamed song takes the shelf title');
	assert.equal(calls.length, 1, 'at most one raw browse happens');
	assert.deepEqual(calls[0], ['browse', { browseId: 'MPREb_tGpxSJ6rn2s' }]);
	assert.equal(ytDlpCalls, 0);
});

test('the refill stays bounded and never bypasses identity, duration or exclusions', async () => {
	const ytDlpCandidate = { videoId: 'correct0001', title: 'Jul - La miss', seconds: 241 };
	const ytDlp = async () => ({ videos: [ytDlpCandidate] });
	const makeClient = (albumSongs, raw, counter) => ({
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [albumEntry()],
			getAlbum: async () => ({ name: 'Indépendance', artist: { name: 'JuL' }, songs: albumSongs }),
			constructRequest: async (endpoint, payload) => {
				counter.count += 1;
				if (raw === 'throw') throw new Error('raw browse unavailable');
				return raw;
			}
		}),
		searchVideos: ytDlp
	});

	// Named songs never trigger the raw browse.
	let namedCounter = { count: 0 };
	const named = await searchMusicTrack(julAlbumSong, makeClient(
		[{ videoId: 'p3sDHWA51ag', name: 'La miss', artist: { name: 'JuL' }, duration: 242 }],
		rawAlbumShelf([]), namedCounter
	));
	assert.equal(named.videoId, 'p3sDHWA51ag');
	assert.equal(namedCounter.count, 0);

	// A missing runtime shim falls back without errors.
	const absent = await searchMusicTrack(julAlbumSong, {
		getMusicClient: async () => ({
			searchSongs: async () => [],
			searchVideos: async () => [],
			searchAlbums: async () => [albumEntry()],
			getAlbum: async () => ({ name: 'Indépendance', artist: { name: 'JuL' }, songs: [{ videoId: 'p3sDHWA51ag', name: '', artist: { name: 'JuL' }, duration: 242 }] })
		}),
		searchVideos: ytDlp
	});
	assert.equal(absent.videoId, 'correct0001');

	// A failing or empty raw browse keeps the general fallback.
	let failingCounter = { count: 0 };
	const failing = await searchMusicTrack(julAlbumSong, makeClient(
		[{ videoId: 'p3sDHWA51ag', name: '', artist: { name: 'JuL' }, duration: 242 }],
		'throw', failingCounter
	));
	assert.equal(failing.videoId, 'correct0001');
	assert.equal(failingCounter.count, 1);

	let bareCounter = { count: 0 };
	const bare = await searchMusicTrack(julAlbumSong, makeClient(
		[{ videoId: 'p3sDHWA51ag', name: '', artist: { name: 'JuL' }, duration: 242 }],
		{ contents: {} }, bareCounter
	));
	assert.equal(bare.videoId, 'correct0001');
	assert.equal(bareCounter.count, 1);

	// Refilled titles keep passing variant, duration and exclusion checks.
	let variantCounter = { count: 0 };
	const variant = await searchMusicTrack(julAlbumSong, makeClient(
		[{ videoId: 'p3sDHWA51ag', name: '', artist: { name: 'JuL' }, duration: 242 }],
		rawAlbumShelf([{ videoId: 'p3sDHWA51ag', title: 'La miss (Live)' }]), variantCounter
	));
	assert.equal(variant.videoId, 'correct0001', 'an alternative version is still rejected');

	let durationCounter = { count: 0 };
	const wrongDuration = await searchMusicTrack(julAlbumSong, makeClient(
		[{ videoId: 'p3sDHWA51ag', name: '', artist: { name: 'JuL' }, duration: 300 }],
		rawAlbumShelf([{ videoId: 'p3sDHWA51ag', title: 'La miss' }]), durationCounter
	));
	assert.equal(wrongDuration.videoId, 'correct0001', 'a different recording is still rejected');

	let excludedCounter = { count: 0 };
	const excluded = await searchMusicTrack(julAlbumSong, {
		...makeClient([{ videoId: 'p3sDHWA51ag', name: '', artist: { name: 'JuL' }, duration: 242 }],
			rawAlbumShelf([{ videoId: 'p3sDHWA51ag', title: 'La miss' }]), excludedCounter),
		excludeIds: ['p3sDHWA51ag']
	});
	assert.equal(excluded.videoId, 'correct0001', 'an excluded id never comes back through the refill');
	assert.equal(excludedCounter.count, 0, 'excluded songs never trigger the raw browse');
});

test('independent search failures keep the remaining fallbacks available', async () => {
	let videoSearchInits = 0;
	const videoMatch = await searchMusicTrack(julSong, {
		getMusicClient: async () => {
			videoSearchInits += 1;
			return {
				searchSongs: async () => { throw new Error('songs unavailable'); },
				searchVideos: async () => [youtubeMusicVideo()]
			};
		},
		searchVideos: async () => { throw new Error('must not be called'); }
	});
	assert.equal(videoMatch.videoId, '0jYCePaBl2A');
	assert.equal(videoSearchInits, 1, 'a mid-search failure still reuses the acquired client');

	let ytDlpInits = 0;
	const ytDlpMatch = await searchMusicTrack(julSong, {
		getMusicClient: async () => {
			ytDlpInits += 1;
			return {
				searchSongs: async () => [],
				searchVideos: async () => { throw new Error('videos unavailable'); }
			};
		},
		searchVideos: async () => ({ videos: [{ videoId: 'correct0001', title: 'Jul - Alors la zone', seconds: 206 }] })
	});
	assert.equal(ytDlpMatch.videoId, 'correct0001');
	assert.equal(ytDlpInits, 1);
});

test('YouTube Music video results follow the same identity, duration and exclusion checks', async () => {
	let ytDlpCalls = 0;
	const options = {
		searchVideos: async () => {
			ytDlpCalls++;
			return { videos: [{ videoId: 'correct0001', title: 'Jul - Alors la zone', seconds: 206 }] };
		}
	};
	const badArtist = await searchMusicTrack(julSong, {
		...options,
		getMusicClient: async () => ({ searchSongs: async () => [], searchVideos: async () => [youtubeMusicVideo({ artist: { name: 'Autre artiste' } })] })
	});
	assert.equal(badArtist.videoId, 'correct0001', 'a wrong artist video is rejected');
	const badDuration = await searchMusicTrack(julSong, {
		...options,
		getMusicClient: async () => ({ searchSongs: async () => [], searchVideos: async () => [youtubeMusicVideo({ duration: 300 })] })
	});
	assert.equal(badDuration.videoId, 'correct0001', 'a different recording is rejected by the duration check');
	const excluded = await searchMusicTrack(julSong, {
		...options,
		excludeIds: ['0jYCePaBl2A'],
		getMusicClient: async () => ({ searchSongs: async () => [], searchVideos: async () => [youtubeMusicVideo()] })
	});
	assert.equal(excluded.videoId, 'correct0001', 'an excluded video id is skipped');
	assert.equal(ytDlpCalls, 3);
});
