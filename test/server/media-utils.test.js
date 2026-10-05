import test from 'node:test';
import assert from 'node:assert/strict';
import {
	clampSpotifyLimit,
	cleanYoutubeTitle,
	decodeHtmlEntities,
	enrichYoutubeTrack,
	getSpotifyResourceId,
	getYoutubeId,
	imageSourcesFrom,
	normalizePathfinderAlbumDetail,
	normalizePathfinderArtistDetail,
	normalizePathfinderPlaylist,
	normalizePathfinderSearch,
	parseArtistAndTitle,
	pathfinderData,
	safePlaylistFileName,
	spotifyExternalUrl,
	spotifyIdFromUri
} from '../../src/server/media-utils.js';
import { sanitizeTrackInput } from '../../src/server/validation.js';

test('decodeHtmlEntities decodes named, decimal and hexadecimal entities', () => {
	assert.equal(
		decodeHtmlEntities('A &amp; B &#39;ok&#39; &#x21; &lt;tag&gt;'),
		"A & B 'ok' ! <tag>"
	);
});

test('safePlaylistFileName removes unsafe filesystem characters and keeps a fallback', () => {
	assert.equal(safePlaylistFileName('  Mix &amp; Test:/2026*  '), 'Mix & Test 2026');
	assert.equal(safePlaylistFileName('////'), 'youtube-playlist');
	assert.equal(safePlaylistFileName('a'.repeat(140)).length, 120);
});

test('getYoutubeId supports classic and short YouTube URLs', () => {
	assert.equal(getYoutubeId('https://www.youtube.com/watch?v=abc123XYZ00&list=demo'), 'abc123XYZ00');
	assert.equal(getYoutubeId('https://youtu.be/shortId123?t=12'), 'shortId123');
	assert.equal(getYoutubeId('not a url'), '');
});

test('cleanYoutubeTitle and parseArtistAndTitle normalize common video titles', () => {
	assert.equal(cleanYoutubeTitle('Artist - Track (Official Video) [HD]'), 'Artist - Track');
	assert.deepEqual(parseArtistAndTitle('Artist - Track (Official Audio)'), {
		artist: 'Artist',
		title: 'Track'
	});
	assert.deepEqual(parseArtistAndTitle('Single title only'), {
		artist: '',
		title: 'Single title only'
	});
});

test('clampSpotifyLimit keeps valid values inside expected bounds', () => {
	assert.equal(clampSpotifyLimit('12', 24, 50), 12);
	assert.equal(clampSpotifyLimit('0', 24, 50), 24);
	assert.equal(clampSpotifyLimit('200', 24, 50), 50);
	assert.equal(clampSpotifyLimit('abc', 10, 50), 10);
});

test('getSpotifyResourceId accepts URLs, URIs and direct ids', () => {
	assert.equal(
		getSpotifyResourceId('https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd?si=abc', 'playlist'),
		'37i9dQZF1DX0XUsuxWHRQd'
	);
	assert.equal(getSpotifyResourceId('spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'track'), '4uLU6hMCjMI75M1A2tKUQC');
	assert.equal(getSpotifyResourceId('4uLU6hMCjMI75M1A2tKUQC', 'track'), '4uLU6hMCjMI75M1A2tKUQC');
	assert.throws(() => getSpotifyResourceId('', 'track'), /manquant/);
	assert.throws(() => getSpotifyResourceId('bad', 'track'), /invalide/);
});

test('spotify id and external URL helpers keep Spotify metadata stable', () => {
	assert.equal(spotifyIdFromUri('spotify:album:abc123'), 'abc123');
	assert.equal(spotifyIdFromUri(null), '');
	assert.deepEqual(spotifyExternalUrl('track', 'abc123'), {
		spotify: 'https://open.spotify.com/track/abc123'
	});
	assert.deepEqual(spotifyExternalUrl('track', ''), {});
});

test('pathfinderData and imageSourcesFrom read the supported Spotify shapes', () => {
	assert.deepEqual(pathfinderData({ itemV2: { data: { name: 'Nested' } } }), { name: 'Nested' });
	assert.deepEqual(
		imageSourcesFrom({ sources: [{ url: 'cover.jpg', height: 300, width: 300 }] }),
		[{ url: 'cover.jpg', height: 300, width: 300 }]
	);
	assert.deepEqual(
		imageSourcesFrom([{ data: { sources: [{ url: 'nested.jpg' }] } }]),
		[{ url: 'nested.jpg', height: null, width: null }]
	);
	assert.deepEqual(imageSourcesFrom(null, []), []);
});

test('Spotify album detail normalizes discs and gives every track the album metadata', () => {
	const album = normalizePathfinderAlbumDetail({
		uri: 'spotify:album:album123456', name: 'Album test',
		coverArt: { sources: [{ url: 'album.jpg' }] },
		artists: { items: [{ uri: 'spotify:artist:artist12345', profile: { name: 'Artiste test' } }] },
		discs: { items: [{ tracks: { items: [{ track: {
			uri: 'spotify:track:track123456', name: 'Titre test', trackNumber: 2,
			artists: { items: [{ uri: 'spotify:artist:artist12345', profile: { name: 'Artiste test' } }] }
		} }] } }] }
	});
	assert.equal(album.name, 'Album test');
	assert.equal(album.tracks.items.length, 1);
	assert.equal(album.tracks.items[0].album.name, 'Album test');
	assert.equal(album.tracks.items[0].album.images[0].url, 'album.jpg');
	assert.equal(album.tracks.items[0].track_number, 2);
});

test('Spotify album detail normalizes the queryAlbumTracks response shape', () => {
	const album = normalizePathfinderAlbumDetail({
		uri: 'spotify:album:album123456',
		tracks: { totalCount: 1, items: [{ track: {
			uri: 'spotify:track:track123456', name: 'Titre reel',
			artists: { items: [{ uri: 'spotify:artist:artist12345', profile: { name: 'Artiste test' } }] }
		} }] }
	});

	assert.equal(album.tracks.items.length, 1);
	assert.equal(album.tracks.items[0].name, 'Titre reel');
	assert.equal(album.tracks.items[0].artists[0].name, 'Artiste test');
});

test('Spotify album detail normalizes the real albumUnion tracksV2 shape', () => {
	const album = normalizePathfinderAlbumDetail({
		uri: 'spotify:album:album123456',
		name: 'Album reel',
		tracksV2: { totalCount: 1, items: [{ track: {
			uri: 'spotify:track:track123456', name: 'Titre tracksV2', trackNumber: 3,
			artists: { items: [{ uri: 'spotify:artist:artist12345', profile: { name: 'Artiste test' } }] }
		} }] }
	});

	assert.equal(album.total_tracks, 1);
	assert.equal(album.tracks.items.length, 1);
	assert.equal(album.tracks.items[0].name, 'Titre tracksV2');
	assert.equal(album.tracks.items[0].track_number, 3);
});

test('Spotify artist detail exposes albums, popular tracks and related artists', () => {
	const data = normalizePathfinderArtistDetail({
		uri: 'spotify:artist:artist12345', profile: { name: 'Artiste test' },
		discography: {
			topTracks: { items: [{ track: { uri: 'spotify:track:track123456', name: 'Populaire' } }] },
			albums: { items: [{ releases: { items: [{ uri: 'spotify:album:album123456', name: 'Album test' }] } }] },
			singles: { items: [{ releases: { items: [{ uri: 'spotify:album:album123456', name: 'Doublon' }, { uri: 'spotify:album:single123456', name: 'Single test' }] } }] }
		},
		relatedContent: { relatedArtists: { items: [{ uri: 'spotify:artist:related12345', profile: { name: 'Artiste proche' } }] } }
	});
	assert.equal(data.artist.name, 'Artiste test');
	assert.deepEqual(data.albums.map((album) => album.name), ['Album test', 'Single test']);
	assert.equal(data.top_tracks[0].name, 'Populaire');
	assert.equal(data.related_artists[0].name, 'Artiste proche');
});

test('normalizePathfinderPlaylist converts nested playlist data into API-compatible objects', () => {
	const playlist = normalizePathfinderPlaylist({
		data: {
			uri: 'spotify:playlist:playlist123',
			name: 'Road Mix',
			descriptionText: 'Demo description',
			ownerV2: { data: { name: 'Owner' } },
			followersCount: 42,
			images: { items: [{ sources: [{ url: 'playlist.jpg' }] }] },
			content: {
				totalCount: 1,
				items: [{
					itemV2: {
						data: {
							uri: 'spotify:track:track12345',
							name: 'Track Name',
							artists: { items: [{ data: { uri: 'spotify:artist:artist123', profile: { name: 'Artist Name' } } }] },
							albumOfTrack: {
								uri: 'spotify:album:album1234',
								name: 'Album Name',
								coverArt: { sources: [{ url: 'album.jpg', height: 640, width: 640 }] }
							},
							duration: { totalMilliseconds: 123000 },
							contentRating: { label: 'EXPLICIT' }
						}
					}
				}]
			}
		}
	});

	assert.equal(playlist.id, 'playlist123');
	assert.equal(playlist.name, 'Road Mix');
	assert.equal(playlist.owner.display_name, 'Owner');
	assert.equal(playlist.tracks.total, 1);
	assert.equal(playlist.tracks.items[0].track.name, 'Track Name');
	assert.equal(playlist.tracks.items[0].track.artists[0].name, 'Artist Name');
	assert.equal(playlist.tracks.items[0].track.album.images[0].url, 'album.jpg');
	assert.equal(playlist.tracks.items[0].track.explicit, true);
	assert.equal(playlist.tracks.items[0].track.track_number, 0);
	assert.equal(playlist.tracks.next, null);
});

test('normalizePathfinderSearch returns empty sections when Spotify omits data', () => {
	assert.deepEqual(normalizePathfinderSearch({}), {
		tracks: { items: [], total: 0 },
		playlists: { items: [], total: 0 },
		albums: { items: [], total: 0 },
		artists: { items: [], total: 0 }
	});
});

test('enrichYoutubeTrack uses Deezer data first and keeps the YouTube id', async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		return {
			ok: true,
			json: async () => ({
				data: [{
					title: 'Matched Title',
					artist: { name: 'Matched Artist' },
					album: { title: 'Matched Album', cover_big: 'cover-big.jpg' },
					track_position: 7
				}]
			})
		};
	};

	const result = await enrichYoutubeTrack({
		type: 'youtube',
		title: 'MATCHED ARTIST - Matched Title (Official Video)',
		url: 'https://www.youtube.com/watch?v=youtube123',
		thumbnail: 'fallback.jpg'
	}, fetchImpl);

	assert.equal(calls.length, 1);
	assert.deepEqual(result, {
		title: 'Matched Title',
		artist: 'Matched Artist',
		album: 'Matched Album',
		id: 'youtube123',
		albumCoverURL: 'cover-big.jpg',
		trackNumber: 7
	});
});

test('enrichYoutubeTrack falls back to iTunes when Deezer has no match', async () => {
	const fetchImpl = async (url) => {
		if (url.includes('deezer.com')) {
			return { ok: true, json: async () => ({ data: [] }) };
		}
		return {
			ok: true,
			json: async () => ({
				results: [{
					trackName: 'iTunes Title',
					artistName: 'iTunes Artist',
					collectionName: 'iTunes Album',
					artworkUrl100: 'https://img/100x100bb.jpg',
					trackNumber: 3
				}]
			})
		};
	};

	const result = await enrichYoutubeTrack({
		type: 'youtube',
		title: 'iTunes Title',
		channelTitle: 'iTunes Artist - Topic',
		url: 'https://youtu.be/youtubeABC',
		thumbnail: 'fallback.jpg'
	}, fetchImpl);

	assert.equal(result.title, 'iTunes Title');
	assert.equal(result.artist, 'iTunes Artist');
	assert.equal(result.albumCoverURL, 'https://img/600x600bb.jpg');
	assert.equal(result.id, 'youtubeABC');
});

test('enrichYoutubeTrack returns non-YouTube songs unchanged', async () => {
	const song = { type: 'spotify', title: 'Track' };
	assert.equal(await enrichYoutubeTrack(song, async () => assert.fail('fetch should not be called')), song);
});

test('YouTube import keeps the selected title and channel when both catalogs return another artist', async () => {
	const calls = [];
	const song = sanitizeTrackInput({
		type: 'youtube',
		title: 'COEUR DE PIRATE',
		channelTitle: 'linlinradio',
		url: 'https://youtu.be/youtubeABC',
		thumbnail: 'youtube-cover.jpg'
	});
	const result = await enrichYoutubeTrack(song, async (url) => {
		calls.push(url);
		return { ok: true, json: async () => ({
			data: [{ title: 'Cœur de pirate', artist: { name: 'Cœur de pirate' }, album: { title: 'Wrong album', cover_big: 'wrong.jpg' } }],
			results: [{ trackName: 'Cœur de pirate', artistName: 'Cœur de pirate', artworkUrl100: 'wrong.jpg' }]
		}) };
	});
	assert.equal(calls.length, 2);
	assert.match(new URL(calls[0]).searchParams.get('q'), /linlinradio/);
	assert.deepEqual(result, {
		title: 'COEUR DE PIRATE', artist: 'linlinradio', album: '',
		id: 'youtubeABC', albumCoverURL: 'youtube-cover.jpg', trackNumber: 0
	});
});

test('YouTube enrichment tries iTunes after rejecting a Deezer result from another artist', async () => {
	const result = await enrichYoutubeTrack({
		type: 'youtube', title: 'COEUR DE PIRATE', artist: 'linlinradio',
		url: 'https://youtu.be/youtubeABC'
	}, async (url) => ({ ok: true, json: async () => url.includes('deezer.com')
		? { data: [{ title: 'Cœur de pirate', artist: { name: 'Cœur de pirate' } }] }
		: { results: [{ trackName: 'Cœur de pirate', artistName: 'Linlinradio', collectionName: 'Correct album' }] }
	}));
	assert.equal(result.title, 'Cœur de pirate');
	assert.equal(result.artist, 'Linlinradio');
	assert.equal(result.album, 'Correct album');
});

test('YouTube enrichment rejects a different title even for the same artist', async () => {
	const result = await enrichYoutubeTrack({
		type: 'youtube', title: 'Artist - Original', url: 'https://youtu.be/youtubeABC'
	}, async () => ({ ok: true, json: async () => ({
		data: [{ title: 'Different title', artist: { name: 'Artist' } }],
		results: [{ trackName: 'Original (Live)', artistName: 'Artist' }]
	}) }));
	assert.equal(result.title, 'Original');
	assert.equal(result.artist, 'Artist');
});

test('YouTube enrichment cannot identify an artist from a title alone', async () => {
	const result = await enrichYoutubeTrack({
		type: 'youtube', title: 'Original', url: 'https://youtu.be/youtubeABC'
	}, async () => ({ ok: true, json: async () => ({
		data: [{ title: 'Original', artist: { name: 'Guessed artist' } }],
		results: [{ trackName: 'Original', artistName: 'Guessed artist' }]
	}) }));
	assert.equal(result.title, 'Original');
	assert.equal(result.artist, '');
});
