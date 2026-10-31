import { normalizeMusicText, trackLikeKey, spotifyArtists } from '../client-utils.js';
import { RequestValidationError } from './validation.js';
import { decodeHtmlEntities } from './media-utils.js';
import { createYoutubeCaptions } from './youtube-captions.js';

export function lyricsIdentity(track) {
    const clean = value => decodeHtmlEntities(String(value || '')).trim().slice(0, 300);
    const split = value => value.split(/\s+(?:feat\.?|ft\.?|featuring|with|avec|&|x)\s+|,\s*|;\s*/i).map(part => part.trim()).filter(Boolean);
    const identities = spotifyArtists(track.spotifyArtists);
    let artist = identities.map(item => item.name).join(', ') || clean(track.artist || track.channelTitle).replace(/\s+-\s+Topic$/i, '');
    let title = clean(track.title || track.name);
    title = title.replace(/\s*[([](?:official\s+(?:(?:music\s+)?video|audio)|lyrics?|paroles|(?:clip|son) officiel|visuali[sz]er|[248]k(?:\s+upgrade)?)[^\])]*[)\]]/gi, '').trim();
    const parsed = /^(.+?)\s+(?:[-–—]|\/\/)\s+(.+)$/.exec(title);
    if (parsed && normalizeMusicText(parsed[2]) === normalizeMusicText(artist)) {
        title = parsed[1].trim();
    } else if (parsed && (track.type === 'youtube' || !track.type && track.id || !artist || normalizeMusicText(parsed[1]) === normalizeMusicText(artist))) {
        artist = parsed[1].trim(); title = parsed[2].trim();
    }
    const featured = [];
    title = title.replace(/\s*[([](?:feat\.?|ft\.?|featuring)\s+([^\])]+)[)\]]/gi, (_match, guests) => { featured.push(...split(guests)); return ''; }).trim();
    title = title.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i, (_match, guests) => { featured.push(...split(guests)); return ''; }).trim();
    const names = [...new Set([...(identities.length ? identities.map(item => item.name) : split(artist)), ...featured])];
    return { title, artist, names, primary: names[0] || artist, album: clean(track.album) };
}

export function createLyricsLookup({ fetchImpl = (...args) => fetch(...args), now = Date.now,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const cache = new Map();
    const unavailable = { available: false };
    let queue = Promise.resolve(), nextRequestAt = 0, blockedUntil = 0, queued = 0;

    async function request(endpoint, params) {
        if (now() < blockedUntil) throw new Error('Lyrics provider cooling down');
        const delay = nextRequestAt - now();
        if (delay > 0) await wait(delay);
        const url = new URL(`https://lrclib.net/api/${endpoint}`);
        url.search = new URLSearchParams(params).toString();
        try {
            const response = await fetchImpl(url, {
                headers: { 'User-Agent': 'YouPlayer-Server/1.0 (https://github.com/RaliteJ/YouPlayer_Server)' },
                signal: AbortSignal.timeout(6000), redirect: 'error'
            });
            if (response.status === 404) return null;
            if (!response.ok) {
                if (response.status === 429 || response.status === 503) {
                    const retry = response.headers.get('retry-after');
                    const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - now();
                    blockedUntil = now() + Math.max(1000, Number.isFinite(delay) ? delay : 60_000) * (1 + Math.random() * 0.3);
                }
                throw new Error('Lyrics unavailable');
            }
            let bytes = 0;
            const chunks = [];
            for await (const chunk of response.body) {
                bytes += chunk.length;
                if (bytes > 1_000_000) throw new Error('Lyrics response too large');
                chunks.push(Buffer.from(chunk));
            }
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } finally { nextRequestAt = now() + 1000; }
    }

    return async (track, duration) => {
        const identity = lyricsIdentity(track);
        const { title, primary, names, album } = identity;
        if (!title || !primary) return { available: true, found: false };
        const key = JSON.stringify([title, names, album, duration]);
        const cached = cache.get(key);
        if (cached?.expires > now()) return cached.result;
        if (queued >= 16) return unavailable;
        queued++;
        const entry = { expires: Infinity };
        const work = queue.then(async () => {
            try {
                const expected = names.map(normalizeMusicText);
                const matches = item => {
                    if (!item || !(item.instrumental === true || item.plainLyrics || item.syncedLyrics)) return false;
                    const candidate = lyricsIdentity({ type: 'spotify', title: item.trackName, artist: item.artistName });
                    const artists = candidate.names.map(normalizeMusicText);
                    return normalizeMusicText(candidate.title) === normalizeMusicText(title)
                        && artists.includes(expected[0]) && artists.every(name => expected.includes(name));
                };
                const params = { track_name: title, artist_name: primary };
                if (album) params.album_name = album;
                if (duration >= 1 && duration <= 3600) params.duration = String(duration);
                const direct = await request('get', params).catch(() => null);
                let candidates = matches(direct) ? [direct] : [];
                if (!candidates.length || !(duration > 0)) {
                    const data = await request('search', { track_name: title, artist_name: primary });
                    if (!Array.isArray(data) && data !== null) throw new Error('Invalid lyrics response');
                    candidates.push(...(data || []).slice(0, 100).filter(matches));
                }
                const albumMatch = item => !album || normalizeMusicText(item.albumName) === normalizeMusicText(album);
                const text = value => typeof value === 'string' ? value.slice(0, 100_000) : '';
                const timedText = item => text(item.syncedLyrics).replace(/\[[^\]]*\]/g, '').trim();
                const textLength = item => Math.max(text(item.plainLyrics).length, timedText(item).length);
                candidates.sort((a, b) => Number(albumMatch(b)) - Number(albumMatch(a)) ||
                    (duration > 0 ? Math.abs(Number(a.duration) - duration) - Math.abs(Number(b.duration) - duration) : 0)
                    || textLength(b) - textLength(a));
                const record = candidates[0];
                const result = record ? {
                    available: true, found: true, source: 'LRCLIB',
                    sourceUrl: Number.isSafeInteger(record.id) && record.id > 0 ? `https://lrclib.net/api/get/${record.id}` : 'https://lrclib.net',
                    duration: Number.isFinite(record.duration) && record.duration > 0 ? record.duration : null,
                    instrumental: record.instrumental === true,
                    plainLyrics: text(record.plainLyrics).length >= timedText(record).length ? text(record.plainLyrics) : timedText(record),
                    syncedLyrics: albumMatch(record) ? text(record.syncedLyrics) : ''
                } : { available: true, found: false };
                entry.expires = now() + (record ? 6 * 60 * 60 * 1000 : 5 * 60_000);
                return result;
            } catch { entry.expires = now() + 60_000; return unavailable; }
            finally { queued--; }
        });
        queue = work.catch(() => {});
        entry.result = work;
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
        return work;
    };
}

export function createLyricsOvhLookup({ fetchImpl = (...args) => fetch(...args), now = Date.now,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const cache = new Map();
    const unavailable = { available: false };
    let queue = Promise.resolve(), queued = 0, nextRequestAt = 0, blockedUntil = 0;
    return async track => {
        const { title, primary } = lyricsIdentity(track);
        if (!normalizeMusicText(title) || !normalizeMusicText(primary)) return { available: true, found: false };
        const key = JSON.stringify([primary, title]);
        const cached = cache.get(key);
        if (cached?.expires > now()) return cached.result;
        if (queued >= 16) return unavailable;
        queued++;
        const entry = { expires: Infinity };
        const work = queue.then(async () => {
            try {
                if (now() < blockedUntil) throw new Error('Lyrics provider cooling down');
                const delay = nextRequestAt - now();
                if (delay > 0) await wait(delay);
                const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(primary)}/${encodeURIComponent(title)}`;
                const response = await fetchImpl(url, {
                    headers: { 'User-Agent': 'YouPlayer-Server/1.0 (https://github.com/RaliteJ/YouPlayer_Server)' },
                    signal: AbortSignal.timeout(8000), redirect: 'error'
                });
                if (response.status === 404) {
                    entry.expires = now() + 5 * 60_000;
                    return { available: true, found: false };
                }
                if (!response.ok) {
                    if (response.status === 429 || response.status === 503) {
                        const retry = response.headers.get('retry-after');
                        const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - now();
                        blockedUntil = now() + Math.max(1000, Number.isFinite(delay) ? delay : 60_000) * (1 + Math.random() * 0.3);
                    }
                    throw new Error('Lyrics unavailable');
                }
                let bytes = 0;
                const chunks = [];
                for await (const chunk of response.body) {
                    bytes += chunk.length;
                    if (bytes > 1_000_000) throw new Error('Lyrics response too large');
                    chunks.push(Buffer.from(chunk));
                }
                const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (typeof data?.lyrics !== 'string') throw new Error('Invalid lyrics response');
                const plainLyrics = data.lyrics.trim().slice(0, 100_000);
                entry.expires = now() + (plainLyrics ? 6 * 60 * 60_000 : 5 * 60_000);
                return plainLyrics ? { available: true, found: true, source: 'lyrics.ovh', sourceUrl: url,
                    plainLyrics, syncedLyrics: '', duration: null } : { available: true, found: false };
            } catch { entry.expires = now() + 60_000; return unavailable; }
            finally { queued--; nextRequestAt = now() + 1000; }
        });
        queue = work.catch(() => {});
        entry.result = work;
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
        return work;
    };
}

export function registerLyricsRoutes(app, { requireAuth, validateSessionTrack, sendJsonError, lookup = createLyricsLookup(),
    youtubeSource = async () => null, captions = createYoutubeCaptions(), plainLookup = createLyricsOvhLookup() }) {
    app.get('/lyrics', requireAuth, async (req, res) => {
        try {
            if (typeof req.query.trackId !== 'string' || !/^(0|[1-9]\d{0,8})$/.test(req.query.trackId)) throw new RequestValidationError('Morceau invalide');
            const track = validateSessionTrack(req, Number(req.query.trackId));
            const key = trackLikeKey(track);
            if (req.query.key !== key) throw new RequestValidationError('Le morceau a changé', 409);
            const duration = Number(req.query.duration || 0);
            if (!Number.isFinite(duration) || duration < 0 || duration > 86400) throw new RequestValidationError('Durée invalide');
            let result = await lookup(track, duration || Number(track.duration_ms) / 1000 || 0);
            if (!result.found) {
                const source = await youtubeSource(req, Number(req.query.trackId), track);
                if (source) {
                    try { result = await captions(source) || result; } catch { /* Continue to the plain-text provider. */ }
                }
            }
            if (!result.found) {
                const plain = await plainLookup(track);
                if (plain?.found) result = plain;
            }
            res.set('Cache-Control', 'private, no-store');
            res.json({ ...result, key });
        } catch (error) { sendJsonError(res, error, 'Paroles indisponibles', 400); }
    });
}
