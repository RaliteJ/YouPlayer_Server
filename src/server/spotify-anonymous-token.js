// Spotify's public Embed supplies a guest session without executing page scripts.
const SPOTIFY_ORIGIN = 'https://open.spotify.com';
const DEFAULT_EMBED_PATH = '/embed/playlist/3cEYpjA9oz9GiPac4AsH4n';
const REFRESH_MARGIN_MS = 30_000;
const CAPTURE_CACHE_TTL_MS = 45 * 60 * 1000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function embedUrl(source) {
	const value = String(source || '').trim();
	let pathname = value.replace(/^\/+/, '');
	if (/^https?:\/\//i.test(value)) {
		let url;
		try { url = new URL(value); } catch { throw new Error('Source Spotify invalide'); }
		if (url.origin !== SPOTIFY_ORIGIN || url.username || url.password) {
			throw new Error('Source Spotify invalide');
		}
		pathname = url.pathname.replace(/^\/+/, '');
	}
	const resource = /^(?:embed\/)?(playlist|album|artist|track)\/([a-zA-Z0-9]{22})\/?$/.exec(pathname);
	return SPOTIFY_ORIGIN + (resource ? `/embed/${resource[1]}/${resource[2]}` : DEFAULT_EMBED_PATH);
}

function guestSession(html, now) {
	if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('Page Spotify trop volumineuse');
	const script = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
	if (!script) throw new Error('Session anonyme Spotify absente');
	let state;
	try { state = JSON.parse(script); } catch { throw new Error('Session anonyme Spotify illisible'); }
	const session = state?.props?.pageProps?.state?.settings?.session;
	const expiresAt = Number(session?.accessTokenExpirationTimestampMs);
	const token = typeof session?.accessToken === 'string' ? session.accessToken.trim() : '';
	if (session?.isAnonymous !== true || !token || /\s/.test(token)
		|| !Number.isFinite(expiresAt) || expiresAt <= now + REFRESH_MARGIN_MS) {
		throw new Error('Session anonyme Spotify invalide ou expiree');
	}
	return { value: token, expiresAt: expiresAt - REFRESH_MARGIN_MS };
}

export function createSpotifyAnonymousTokenProvider({
	fetchImpl = (...args) => fetch(...args), now = () => Date.now(), timeoutMs = 8_000
} = {}) {
	let cache = { value: '', expiresAt: 0 };
	let pending = null;
	let revision = 0;

	function cachedToken() {
		return cache.value && now() < cache.expiresAt ? cache.value : '';
	}

	function rememberToken(rawToken = '') {
		const value = String(rawToken).replace(/^Bearer\s+/i, '').trim();
		if (!value || value === cache.value) return;
		cache = { value, expiresAt: now() + CAPTURE_CACHE_TTL_MS };
	}

	function clear() {
		revision++;
		cache = { value: '', expiresAt: 0 };
		pending = null;
	}

	async function getToken(source = 'search') {
		const existing = cachedToken();
		if (existing) return existing;
		if (pending) return pending;
		const url = embedUrl(source);
		const startedRevision = revision;
		const request = (async () => {
			const response = await fetchImpl(url, {
				headers: { Accept: 'text/html' }, redirect: 'error',
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (!response.ok) throw new Error(`Session anonyme Spotify indisponible (${response.status})`);
			if (Number(response.headers?.get('content-length')) > MAX_HTML_BYTES) {
				throw new Error('Page Spotify trop volumineuse');
			}
			const session = guestSession(await response.text(), now());
			if (revision === startedRevision) cache = session;
			return session.value;
		})();
		pending = request;
		try { return await request; }
		finally { if (pending === request) pending = null; }
	}

	return { getToken, cachedToken, rememberToken, clear };
}

const provider = createSpotifyAnonymousTokenProvider();
export const getSpotifyAnonymousToken = provider.getToken;
export const clearSpotifyAnonymousToken = provider.clear;
export const cachedSpotifyAnonymousToken = provider.cachedToken;
export const rememberSpotifyAnonymousToken = provider.rememberToken;
