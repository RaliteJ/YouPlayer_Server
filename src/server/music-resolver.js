import YTMusic from 'ytmusic-api';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeHtmlEntities } from './media-utils.js';

const execFileAsync = promisify(execFile);
const cache = new Map();
const pending = new Map();
let musicClientPromise;
const VARIANTS = /\b(remix|cover|karaoke|instrumental|acoustic|live|remaster(?:ed)?|slowed|sped up|reverb|nightcore|8d)\b/g;

function normalize(value) {
	return decodeHtmlEntities(String(value || '')).normalize('NFKD')
		.replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function cleanTitle(value) {
	return String(value || '')
		.replace(/\s*[([]\s*(?:feat\.?|ft\.?)\s+[^)\]]*[)\]]/gi, '')
		.replace(/[([]\s*(?:(?:official\s+)?(?:music\s+video|audio|video|lyrics?|visualizer|hd|4k)|clip\s+officiel)\s*[)\]]/gi, '')
		.replace(/\s+(?:official\s+(?:music\s+)?(?:video|audio)|lyric(?:s| video)|visualizer|clip\s+officiel)\s*$/i, '').trim();
}

function cleanArtist(value) {
	return normalize(String(value || '').replace(/(?:\s*-\s*topic|\s*vevo|\s+official)\s*$/i, ''));
}

function similarity(a, b) {
	if (!a || !b) return 0;
	if (a === b) return 1;
	// Require both near-identical spelling and comparable words; homonyms with
	// extra words must not win on substring matching alone.
	let row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) next[j] = Math.min(
			row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
		);
		row = next;
	}
	return 1 - row[b.length] / Math.max(a.length, b.length);
}

function variants(value) {
	return [...new Set(normalize(value).match(VARIANTS) || [])].sort().join('|');
}

export function selectMusicMatch(song, results = []) {
	const title = normalize(cleanTitle(song.title || song.name));
	const fullArtist = cleanArtist(song.artist);
	const artists = [fullArtist, cleanArtist(String(song.artist || '').split(/,\s*/)[0])].filter(Boolean);
	if (!title || !artists.length) return null;
	let best = null;
	let bestScore = 0;
	for (const result of results) {
		if (!/^[\w-]{11}$/.test(result?.videoId || '')) continue;
		let candidateTitle = cleanTitle(result.name || result.title);
		const candidateArtists = [result.artist?.name, result.author?.name].filter(Boolean);
		// YouTube videos often put the performer in the title, rather than in
		// the channel name. Only a separated performer/title pair is accepted.
		const parts = candidateTitle.split(/\s+[-–—|]\s+/);
		if (parts.length > 1) {
			for (const index of [0, parts.length - 1]) {
				if (artists.includes(cleanArtist(parts[index]))) {
					candidateArtists.push(parts[index]);
					candidateTitle = parts.filter((_, i) => i !== index).join(' - ');
					break;
				}
			}
		}
		if (variants(song.title || song.name) !== variants(candidateTitle)) continue;
		const normalizedTitle = normalize(candidateTitle);
		if ((title.match(/\d+/g) || []).join('|') !== (normalizedTitle.match(/\d+/g) || []).join('|')) continue;
		const titleScore = similarity(title, normalizedTitle);
		const artistScore = Math.max(0, ...candidateArtists.flatMap(candidate =>
			artists.map(artist => similarity(artist, cleanArtist(candidate)))));
		if (titleScore < 0.88 || artistScore !== 1) continue;
		const duration = Number(song.duration_ms) / 1000;
		const candidateDuration = Number(result.duration ?? result.seconds);
		if (duration > 0 && candidateDuration > 0
			&& Math.abs(duration - candidateDuration) > Math.max(10, duration * 0.05)) continue;
		const albumScore = similarity(normalize(song.album), normalize(result.album?.name));
		const score = titleScore * 60 + artistScore * 35 + albumScore * 5;
		if (score > bestScore) { best = result; bestScore = score; }
	}
	return best;
}

async function musicClient() {
	if (!musicClientPromise) {
		const client = new YTMusic();
		// Bound requests made by the existing library, including initialization.
		client.client.defaults.timeout = 8000;
		musicClientPromise = client.initialize().then(() => client).catch(err => {
			musicClientPromise = undefined;
			throw err;
		});
	}
	return musicClientPromise;
}

export async function searchYoutubeVideos(query, { execFileImpl = execFileAsync } = {}) {
	const { stdout } = await execFileImpl('yt-dlp', [
		'--dump-single-json',
		'--flat-playlist',
		'--no-warnings',
		'--playlist-end', '10',
		`ytsearch10:${query}`
	], { timeout: 12_000, maxBuffer: 2 * 1024 * 1024 });
	const data = JSON.parse(stdout);
	return {
		videos: (data.entries || []).map((entry) => ({
			videoId: entry.id,
			title: entry.title,
			author: { name: entry.uploader || entry.channel || '' },
			seconds: entry.duration
		}))
	};
}

export async function searchMusicTrack(song, { getMusicClient = musicClient, searchVideos = searchYoutubeVideos } = {}) {
	const query = [song.artist, song.title || song.name].filter(Boolean).join(' - ');
	try {
		const client = await getMusicClient();
		const match = selectMusicMatch(song, await client.searchSongs(query));
		if (match) return match;
	} catch {
		// The fallback is subject to the same identity checks.
	}
	try {
		return selectMusicMatch(song, (await searchVideos(query)).videos || []);
	} catch {
		throw new Error('Recherche musicale indisponible');
	}
}

export async function resolveMusicTrack(song = {}, { searchTrack = searchMusicTrack, useCache = true } = {}) {
	if (!String(song.title || song.name || '').trim() || !String(song.artist || '').trim()) {
		throw new Error('Titre et artiste requis pour la correspondance musicale');
	}
	const key = JSON.stringify([song.title || song.name, song.artist, song.album || '', song.duration_ms || 0]);
	if (useCache && cache.get(key)?.expiresAt > Date.now()) return { ...song, id: cache.get(key).id };
	if (useCache && pending.has(key)) return { ...song, id: await pending.get(key) };
	const task = (async () => {
		const match = await searchTrack(song);
		if (!match || !selectMusicMatch(song, [match])) throw new Error('Aucune correspondance musicale fiable');
		const id = match.videoId;
		if (useCache) {
			cache.delete(key);
			cache.set(key, { id, expiresAt: Date.now() + 10 * 60_000 });
			if (cache.size > 256) cache.delete(cache.keys().next().value);
		}
		return id;
	})();
	if (useCache) pending.set(key, task);
	try { return { ...song, id: await task }; }
	finally { if (useCache) pending.delete(key); }
}
