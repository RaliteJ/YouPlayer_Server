import { createHash } from 'node:crypto';
import { trackLikeKey } from '../client-utils.js';
import { RequestValidationError } from './validation.js';

export function createSponsorBlock({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    const cache = new Map();
    let pending = 0;
    const unavailable = { available: false, segments: [] };
    return async videoId => {
        if (!/^[\w-]{11}$/.test(videoId)) return unavailable;
        const cached = cache.get(videoId);
        if (cached && cached.expires > now()) return cached.result;
        if (pending >= 8) return unavailable;
        const entry = { expires: now() + 60_000 };
        pending++;
        entry.result = (async () => {
            try {
                const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
                const url = new URL(`https://sponsor.ajay.app/api/skipSegments/${prefix}`);
                url.searchParams.set('categories', '["music_offtopic"]');
                url.searchParams.set('actionTypes', '["skip"]');
                const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
                let segments = [];
                if (response.status !== 404) {
                    if (!response.ok) throw new Error('Unavailable');
                    let body = '';
                    for await (const chunk of response.body) {
                        body += Buffer.from(chunk).toString('utf8');
                        if (body.length > 1_000_000) throw new Error('Response too large');
                    }
                    const data = JSON.parse(body);
                    if (!Array.isArray(data)) throw new Error('Invalid response');
                    const video = data.find(item => item?.videoID === videoId);
                    if (video && !Array.isArray(video.segments)) throw new Error('Invalid segments');
                    segments = (video?.segments || []).slice(0, 500).filter(item =>
                        item?.category === 'music_offtopic' && item.actionType === 'skip' && !(item.votes < 0)
                        && Array.isArray(item.segment) && item.segment.length === 2
                        && item.segment.every(Number.isFinite) && Number.isFinite(item.videoDuration)
                        && item.videoDuration > 0 && item.videoDuration <= 86400
                        && item.segment[0] >= 0 && item.segment[0] < item.segment[1]
                        && item.segment[0] < item.videoDuration && item.segment[1] <= item.videoDuration + 1
                    ).map(item => ({ start: item.segment[0], end: Math.min(item.segment[1], item.videoDuration), duration: item.videoDuration }))
                        .sort((a, b) => a.start - b.start);
                }
                entry.expires = now() + 6 * 60 * 60 * 1000;
                return { available: true, segments };
            } catch {
                return unavailable;
            } finally { pending--; }
        })();
        cache.delete(videoId);
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(videoId, entry);
        return entry.result;
    };
}

export function registerSponsorBlockRoutes(app, { requireAuth, validateSessionTrack, sendJsonError, lookup = createSponsorBlock() }) {
    app.get('/sponsorblock', requireAuth, async (req, res) => {
        try {
            if (typeof req.query.trackId !== 'string' || !/^(0|[1-9]\d{0,8})$/.test(req.query.trackId)) {
                throw new RequestValidationError('Morceau invalide');
            }
            const track = validateSessionTrack(req, Number(req.query.trackId));
            const key = trackLikeKey(track);
            if (req.query.key !== key) throw new RequestValidationError('Le morceau a changé', 409);
            const videoId = track.type === 'youtube' && key.startsWith('youtube:') ? key.slice(8) : '';
            const result = /^[\w-]{11}$/.test(videoId) ? await lookup(videoId) : { available: true, segments: [] };
            res.set('Cache-Control', 'private, no-store');
            res.json({ ...result, key });
        } catch (error) { sendJsonError(res, error, 'Repères indisponibles', 400); }
    });
}
