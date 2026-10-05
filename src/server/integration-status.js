import { createSpotifyAnonymousTokenProvider } from './spotify-anonymous-token.js';
import { fetchSpotifyClientCredentialsToken, spotifyOAuthConfigured } from './spotify-oauth.js';

// No personal account or playlist is queried by these explicit admin probes.
export function createIntegrationStatus({
    config, fetchImpl = (...args) => fetch(...args), now = () => Date.now(),
    timeoutMs = 8_000, cooldownMs = 30_000
}) {
    const configured = {
        youtube: Boolean(config.youtubeApiKey),
        spotifyPublic: true,
        spotifyOAuth: spotifyOAuthConfigured(config)
    };
    let connections = Object.fromEntries(Object.entries(configured).map(([name, enabled]) => [name, {
        state: enabled ? 'not_checked' : 'not_configured', checkedAt: null
    }]));
    let checkedAt = null;
    let pending = null;
    const guest = createSpotifyAnonymousTokenProvider({ fetchImpl: async (url, options) => {
        const response = await fetchImpl(url, options);
        if (!response.ok) fail(response.status === 429 ? 'rate_limited'
            : [401, 403].includes(response.status) ? 'rejected' : 'unavailable');
        return response;
    }, now, timeoutMs });

    function snapshot() {
        return {
            youtube: { configured: configured.youtube },
            spotify: { publicCatalogAvailable: true, oauthConfigured: configured.spotifyOAuth },
            connections: Object.fromEntries(Object.entries(connections).map(([name, result]) => [name, {
                ...result, state: pending && configured[name] ? 'checking' : result.state
            }])),
            checkedAt
        };
    }

    function fail(state) {
        const error = new Error('Integration check failed');
        error.integrationState = state;
        throw error;
    }

    async function checkYoutube() {
        const url = new URL('https://www.googleapis.com/youtube/v3/videos');
        url.search = new URLSearchParams({ part: 'id', chart: 'mostPopular', maxResults: '1', key: config.youtubeApiKey });
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (!response.ok) {
            if (response.status === 429) fail('rate_limited');
            if (response.status === 403) {
                const data = await response.json().catch(() => null);
                const reasons = data?.error?.errors;
                if (Array.isArray(reasons) && reasons.some(item => ['quotaExceeded', 'dailyLimitExceeded'].includes(item?.reason))) {
                    fail('quota_exceeded');
                }
            }
            fail([400, 401, 403].includes(response.status) ? 'rejected' : 'unavailable');
        }
        const data = await response.json();
        if (!Array.isArray(data?.items)) fail('invalid_response');
    }

    async function checkSpotifyOAuth() {
        const token = await fetchSpotifyClientCredentialsToken(config, (url, options) => fetchImpl(url, {
            ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
        }));
        if (typeof token?.access_token !== 'string' || !token.access_token.trim()) fail('invalid_response');
    }

    async function probe(name, operation) {
        if (!configured[name]) return { state: 'not_configured', checkedAt: null };
        let state = 'connected';
        try { await operation(); }
        catch (error) {
            state = error.integrationState
                || (['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout'
                    : error.spotifyStatus === 429 ? 'rate_limited'
                        : [400, 401, 403].includes(error.spotifyStatus) ? 'rejected' : 'unavailable');
        }
        return { state, checkedAt: new Date(now()).toISOString() };
    }

    function check() {
        if (pending) return pending;
        if (checkedAt && now() - Date.parse(checkedAt) < cooldownMs) return Promise.resolve(snapshot());
        guest.clear();
        const operations = { youtube: checkYoutube, spotifyPublic: () => guest.getToken(), spotifyOAuth: checkSpotifyOAuth };
        pending = Promise.all(Object.entries(operations).map(async ([name, operation]) => [name, await probe(name, operation)]))
            .then(results => {
                connections = Object.fromEntries(results);
                checkedAt = new Date(now()).toISOString();
            }).finally(() => { pending = null; });
        pending = pending.then(snapshot);
        return pending;
    }

    return { snapshot, check };
}
