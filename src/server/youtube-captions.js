import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function youtubeCaptionLines(data) {
    const lines = [];
    let characters = 0;
    for (const event of (Array.isArray(data?.events) ? data.events : []).slice(0, 5000)) {
        if (!Number.isFinite(event.tStartMs) || event.tStartMs < 0 || event.tStartMs > 86400_000 || !Array.isArray(event.segs)) continue;
        const text = event.segs.map(segment => typeof segment.utf8 === 'string' ? segment.utf8 : '').join('').replace(/\s+/g, ' ').trim().slice(0, 2000);
        if (!text || lines.at(-1)?.text === text) continue;
        characters += text.length;
        if (characters > 100_000) break;
        lines.push({ time: event.tStartMs / 1000, text });
    }
    return lines.sort((a, b) => a.time - b.time).slice(0, 2000);
}

export function createYoutubeCaptions({ execFileImpl = execute, fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    const cache = new Map();
    let pending = 0;
    return async source => {
        let videoId;
        try {
            const url = new URL(source);
            if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'youtu.be'].includes(url.hostname)) return null;
            videoId = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
        } catch { return null; }
        if (!/^[\w-]{11}$/.test(videoId || '')) return null;
        const cached = cache.get(videoId);
        if (cached?.expires > now()) return cached.result;
        if (pending >= 2) return null;
        pending++;
        const entry = { expires: now() + 60_000 };
        entry.result = (async () => {
            try {
                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                const { stdout } = await execFileImpl('yt-dlp', [
                    '--ignore-config', '--dump-single-json', '--skip-download', '--no-playlist',
                    '--no-warnings', '--no-cookies', '--no-cache-dir', '--ignore-no-formats-error',
                    '--socket-timeout', '5', '--retries', '0', '--extractor-retries', '0',
                    '--extractor-args', 'youtube:skip=translated_subs', '--', videoUrl
                ], { timeout: 14000, maxBuffer: 4 * 1024 * 1024 });
                const metadata = JSON.parse(stdout);
                if (metadata.id !== videoId) return null;
                const original = String(metadata.language || '').split('-')[0];
                let selected;
                for (const [tracks, automatic] of [[metadata.subtitles, false], [metadata.automatic_captions, true]]) {
                    const score = language => language.endsWith('-orig') || language === original ? 0 : language === 'fr' ? 1 : language === 'en' ? 2 : 3;
                    for (const language of Object.keys(tracks || {}).sort((a, b) => score(a) - score(b))) {
                        if (language === 'live_chat') continue;
                        const format = (Array.isArray(tracks[language]) ? tracks[language] : []).find(item => {
                            try {
                                const url = new URL(item.url);
                                return item.ext === 'json3' && url.protocol === 'https:' && url.hostname === 'www.youtube.com'
                                    && url.pathname === '/api/timedtext' && !url.searchParams.has('tlang');
                            } catch { return false; }
                        });
                        if (format) { selected = { url: format.url, language, automatic }; break; }
                    }
                    if (selected) break;
                }
                if (!selected) { entry.expires = now() + 60 * 60_000; return null; }
                const response = await fetchImpl(selected.url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
                if (!response.ok) return null;
                const chunks = [];
                let bytes = 0;
                for await (const chunk of response.body) {
                    bytes += chunk.length;
                    if (bytes > 1_000_000) return null;
                    chunks.push(Buffer.from(chunk));
                }
                const timedLines = youtubeCaptionLines(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                if (!timedLines.length) return null;
                entry.expires = now() + 6 * 60 * 60_000;
                return { available: true, found: true, source: 'YouTube', sourceUrl: videoUrl,
                    sameSource: true, automatic: selected.automatic, language: selected.language,
                    duration: Number.isFinite(metadata.duration) ? metadata.duration : null,
                    timedLines, plainLyrics: timedLines.map(line => line.text).join('\n') };
            } catch { return null; }
            finally { pending--; }
        })();
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(videoId, entry);
        return entry.result;
    };
}
