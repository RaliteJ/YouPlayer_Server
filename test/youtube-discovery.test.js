import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryView } from '../src/discovery-view.js';

const CHANNEL_ID = 'UC' + 'a'.repeat(22);
let elements = {};
let originalDocument;

before(() => {
	originalDocument = globalThis.document;
	globalThis.document = { getElementById: id => elements[id] || null };
});

after(() => {
	if (originalDocument === undefined) delete globalThis.document;
	else globalThis.document = originalDocument;
});

const escapeHtmlSimple = value => String(value ?? '')
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function viewFor(items) {
	const captured = [];
	const view = createDiscoveryView({ apiUrl: '/' });
	view.ytResults = { innerHTML: '', querySelectorAll: () => [] };
	view.escapeHtml = escapeHtmlSimple;
	view.apiFetch = async (path, method, body) => {
		captured.push({ path, method, body });
		return { items };
	};
	return { view, captured };
}

test('the search payload always carries an explicit filter type', async () => {
	elements = { 'query_yt': { value: '  Jul Alors la zone  ' } };
	const fallback = viewFor([]);
	await fallback.view.searchYoutube();
	assert.deepEqual(fallback.captured, [{
		path: '/send_search_youtube',
		method: 'POST',
		body: { arg: 'Jul Alors la zone', type: 'all' }
	}], 'a missing filter select falls back to an explicit Tout');

	elements = {
		'query_yt': { value: 'Jul Alors la zone' },
		'youtube-search-filter': { value: 'playlist' }
	};
	const explicit = viewFor([]);
	await explicit.view.searchYoutube();
	assert.deepEqual(explicit.captured.map(request => request.body.type), ['playlist']);
});

test('channel cards open a validated external link and expose no play action', async () => {
	elements = { 'query_yt': { value: 'Jul' } };
	const channel = {
		id: { kind: 'youtube#channel', channelId: CHANNEL_ID },
		snippet: {
			title: 'JuL', channelTitle: 'JuL',
			thumbnails: { medium: { url: 'https://example.test/portrait.jpg' } }
		}
	};
	const { view } = viewFor([channel]);
	await view.searchYoutube();
	assert.match(view.ytResults.innerHTML, /channel-result-card/);
	assert.match(view.ytResults.innerHTML, new RegExp(`href="https://www\\.youtube\\.com/channel/${CHANNEL_ID}"`));
	assert.match(view.ytResults.innerHTML, /rel="noopener noreferrer"/);
	assert.match(view.ytResults.innerHTML, /Ouvrir la chaîne/);
	assert.doesNotMatch(view.ytResults.innerHTML, /youtube-add|youtube-like|youtube-options|import-youtube-playlist/);
});

test('mixed results keep video and playlist behaviour and malformed entries are skipped', async () => {
	elements = { 'query_yt': { value: 'Jul' } };
	const snippet = (title, channel = 'Une chaîne') => ({
		title, channelTitle: channel,
		thumbnails: { medium: { url: 'https://example.test/thumb.jpg' } }
	});
	const items = [
		null,
		{ id: { kind: 'youtube#video', videoId: 'abcdefghijk' }, snippet: snippet('Titre un') },
		{ id: { kind: 'youtube#playlist', playlistId: 'PLsynthetic123' } , snippet: snippet('Playlist dédiée') },
		{ id: { kind: 'youtube#channel', channelId: 'UCshort' }, snippet: snippet('Chaîne invalide') },
		{ snippet: snippet('Sans identifiant') },
		{ id: { kind: 'youtube#video', videoId: 'nosnippet01' } },
		{ id: { videoId: 'legacy12345' }, snippet: snippet('Vidéo sans kind') }
	];
	const { view } = viewFor(items);
	await view.searchYoutube();
	const html = view.ytResults.innerHTML;
	assert.match(html, /data-kind="video"/);
	assert.match(html, /youtube-add/);
	assert.match(html, /import-youtube-playlist/);
	assert.match(html, /legacy12345/, 'a kind-less videoId still renders a playable video card');
	assert.doesNotMatch(html, /UCshort/, 'an invalid channel id never renders');
	assert.doesNotMatch(html, /Sans identifiant/, 'an item without id is skipped instead of an undefined card');
	assert.doesNotMatch(html, /nosnippet01/, 'an item without snippet is ignored upfront');
	assert.equal((html.match(/channel-result-card/g) || []).length, 0, 'no channel card is emitted from malformed ids');
});
