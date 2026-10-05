import { LIKED_PLAYLIST } from './client-utils.js';
import { spotifyBrowserBridge } from "./spotify-browser-bridge.js";

export function createSpotifyExplorer({
	root,
	apiFetch,
	apiErrorMessage,
	escapeHtml,
	playlistEntries,
	openAddModal,
	playTrack = () => {},
	playCollection = () => {},
	isControlledPlayback = () => false,
	queueTrack = () => {},
	bindQueueSwipe = () => {},
	toggleLike = () => {},
	likeButtonMarkup = () => '',
	renderLikeButtons = () => {},
	showNotice,
	getCurrentUser = () => null,
	browserBridge = spotifyBrowserBridge
}) {
	const pageRoot = root.ownerDocument || root;
	const state = {
		currentPlaylist: null,
		currentCollectionType: null,
		currentPlaylistTracks: [],
		currentPlaylistTotal: 0,
		playlistVisibleCount: 50,
		playlistNextOffset: null,
		loadingPlaylistPage: false,
		busy: false,
		browserPlaylistIds: new Set(),
		browserBridgeStatus: null,
		entities: new Map(),
		initialized: false
	};

	const els = {
		searchForm: root.querySelector('[data-spotify-search-form]'),
		searchInput: root.querySelector('[data-spotify-search-input]'),
		playlistOpenForm: root.querySelector('[data-spotify-playlist-open-form]'),
		playlistUrl: root.querySelector('[data-spotify-playlist-url]'),
		targetPlaylist: root.querySelector('[data-spotify-target-playlist]'),
		importCurrent: root.querySelector('[data-spotify-import-current]'),
		meButton: root.querySelector('[data-spotify-me]'),
		libraryButton: root.querySelector('[data-spotify-library]'),
		status: root.querySelector('[data-spotify-status]'),
		results: root.querySelector('[data-spotify-results]'),
		detailPanel: root.querySelector('[data-spotify-detail]'),
		browserPanel: pageRoot.querySelector('[data-spotify-browser-panel]'),
		browserTitle: pageRoot.querySelector('[data-spotify-browser-title]'),
		browserCopy: pageRoot.querySelector('[data-spotify-browser-copy]'),
		browserStatus: pageRoot.querySelector('[data-spotify-browser-status]'),
		browserOpen: pageRoot.querySelector('[data-spotify-browser-open]')
	};

	function setStatus(message, isError = false) {
		if (!els.status) return;
		els.status.textContent = message || "";
		els.status.classList.toggle("error", isError);
	}

	function setBusy(isBusy) {
		state.busy = isBusy;
		root.classList.toggle("is-busy", isBusy);
		root.querySelectorAll("button, input, select").forEach((element) => {
			if (element.dataset.spotifyBusyIgnore !== undefined) return;
			element.disabled = isBusy;
		});
		if (!isBusy) {
			updateImportState();
			updateAccountState();
		}
	}

	async function spotifyRequest(action, payload = {}) {
		setBusy(true);
		try {
			const response = await apiFetch("/spotify_test", "POST", { action, ...payload });
			if (!response) {
				throw new Error(apiErrorMessage("Erreur Spotify"));
			}
			return response.data;
		} finally {
			setBusy(false);
		}
	}

	async function browserSpotifyRequest(action, payload = {}) {
		setBusy(true);
		try {
			if (action === "search") return await browserBridge.search(payload.query, payload);
			if (action === "album") return await browserBridge.getAlbum(payload.id);
			if (action === "artist") return await browserBridge.getArtist(payload.id);
			if (action === "me_playlists") return await browserBridge.getPlaylists();
			if (action === "playlist") return await browserBridge.getPlaylist(payload.id);
			throw new Error("Action extension Spotify inconnue");
		} finally {
			setBusy(false);
		}
	}

	function spotifyUrl(type, id) {
		return id ? `https://open.spotify.com/${type}/${id}` : "";
	}

	function imageUrl(images = []) {
		return images?.[0]?.url || "";
	}

	async function completeArtistImages(data, action, payload) {
		const artists = value => action === "search"
			? value.artists?.items || []
			: [value.artist, ...(value.related_artists || [])].filter(Boolean);
		if (!artists(data).some(artist => artist.id && !imageUrl(artist.images))) return data;
		try {
			// Older bridge versions omit portraits. Supplement only public artwork,
			// leaving the bridge's results and personal collections authoritative.
			const publicData = await spotifyRequest(action, payload);
			const byId = new Map(artists(publicData).filter(artist => artist.id).map(artist => [artist.id, artist]));
			const complete = artist => {
				const images = byId.get(artist?.id)?.images;
				return artist && !imageUrl(artist.images) && imageUrl(images) ? { ...artist, images } : artist;
			};
			return action === "search"
				? { ...data, artists: { ...data.artists, items: (data.artists?.items || []).map(complete) } }
				: { ...data, artist: complete(data.artist), related_artists: (data.related_artists || []).map(complete) };
		} catch {
			return data;
		}
	}

	function artistNames(artists = []) {
		return artists.map((artist) => artist?.name).filter(Boolean).join(", ");
	}

	function artistLinks(artists = []) {
		return artists.filter((artist) => artist?.name).map((artist) => {
			rememberEntity("artist", artist);
			return artist.id
				? `<button class="spotify-inline-link" type="button" data-entity-type="artist" data-entity-id="${escapeHtml(artist.id)}">${escapeHtml(artist.name)}</button>`
				: escapeHtml(artist.name);
		}).join(", ");
	}

	function formatDuration(ms = 0) {
		const totalSeconds = Math.floor(Number(ms) / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = String(totalSeconds % 60).padStart(2, "0");
		return `${minutes}:${seconds}`;
	}

	function formatNumber(value = 0) {
		return new Intl.NumberFormat("fr-FR").format(Number(value) || 0);
	}

	function rememberEntity(type, entity) {
		if (entity?.id) {
			state.entities.set(`${type}:${entity.id}`, entity);
		}
		return entity;
	}

	function coverMarkup(url, className = "", alt = "") {
		if (url) {
			return `<img class="spotify-entity-cover ${className}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`;
		}
		return `<div class="spotify-entity-cover ${className}" aria-hidden="true"></div>`;
	}

	function trackCover(track) {
		const url = imageUrl(track?.album?.images || []);
		if (url) {
			return `<img class="spotify-track-cover" src="${escapeHtml(url)}" alt="">`;
		}
		return `<div class="spotify-track-cover" aria-hidden="true"></div>`;
	}

	function trackPayload(track) {
		return {
			title: track.name || "Titre inconnu",
			artist: artistNames(track.artists || []),
			album: track.album?.name || "",
			albumCoverURL: imageUrl(track.album?.images || []),
			trackNumber: track.track_number || 0,
			...(Number(track.duration_ms) > 0 ? { duration_ms: track.duration_ms } : {}),
			url: track.external_urls?.spotify || spotifyUrl("track", track.id),
			type: "spotify"
		};
	}

	function renderEntityCard(type, entity) {
		rememberEntity(type, entity);
		const url = imageUrl(entity.images || []);
		const subtitle = {
			artist: "Artiste",
			album: artistNames(entity.artists || []),
			playlist: entity.owner?.display_name || "Playlist",
			track: artistNames(entity.artists || [])
		}[type] || "";

		return `
			<button class="spotify-entity-card" type="button" data-entity-type="${type}" data-entity-id="${escapeHtml(entity.id)}">
				${coverMarkup(url, type === "artist" ? "artist" : "", entity.name)}
				<span class="spotify-card-title">${escapeHtml(entity.name || "Sans titre")}</span>
				<span class="spotify-card-meta">${escapeHtml(subtitle)}</span>
			</button>
		`;
	}

	function renderTrackRows(tracks = []) {
		if (!tracks.length) {
			return `<p class="muted">Aucun titre.</p>`;
		}

		return `
			<div class="spotify-track-list">
				${tracks.map((track, index) => {
					rememberEntity("track", track);
					const album = track.album?.name || "";
					const url = track.external_urls?.spotify || spotifyUrl("track", track.id);
					return `
						<div class="spotify-track-row" role="button" tabindex="0" data-entity-type="track" data-entity-id="${escapeHtml(track.id)}" data-collection-index="${index}">
							${trackCover(track)}
							<div class="spotify-track-main">
								<span class="spotify-track-title">${escapeHtml(track.name || "Sans titre")}</span>
								<span class="spotify-track-artist">${artistLinks(track.artists || [])}</span>
							</div>
							<span class="spotify-track-album">${escapeHtml(album)}</span>
							<span class="spotify-track-time">${formatDuration(track.duration_ms)}</span>
							<div class="spotify-track-actions">
								<button class="btn-small" type="button" title="Ajouter à la file" aria-label="Ajouter à la file" data-queue-track="${escapeHtml(track.id)}">＋</button>
								${likeButtonMarkup(trackPayload(track)).replace('class="song-like"', 'class="song-like spotify-like"')}
								<button class="btn-small" type="button" title="Ajouter à une playlist" aria-label="Ajouter à une playlist" data-add-track="${escapeHtml(track.id)}">⚙</button>
								<button class="btn-small spotify-open-track" type="button" title="Ouvrir Spotify" data-open-url="${escapeHtml(url)}">↗</button>
							</div>
						</div>
					`;
				}).join("")}
			</div>
		`;
	}

	function bindTrackRows() {
		els.results.querySelectorAll?.('.spotify-track-row').forEach(row => {
			const track = state.entities.get(`track:${row.dataset.entityId}`);
			if (track) bindQueueSwipe(row, trackPayload(track));
		});
		renderLikeButtons();
	}

	function renderSection(title, body, count = "") {
		return `
			<section class="spotify-section">
				<div class="spotify-section-head">
					<h2>${escapeHtml(title)}</h2>
					${count ? `<span class="muted">${escapeHtml(count)}</span>` : ""}
				</div>
				${body}
			</section>
		`;
	}

	function heroMarkup(entity, type, meta, actions = "") {
		const url = imageUrl(entity.images || entity.album?.images || []);
		const coverClass = `spotify-hero-cover${type === "Artiste" ? " artist" : ""}`;
		return `
			<section class="spotify-hero">
				${url ? `<img class="${coverClass}" src="${escapeHtml(url)}" alt="${escapeHtml(entity.name || "")}">` : `<div class="${coverClass}" aria-hidden="true"></div>`}
				<div class="spotify-hero-copy">
					<span class="muted">${escapeHtml(type)}</span>
					<h2>${escapeHtml(entity.name || "Sans titre")}</h2>
					<div class="spotify-hero-meta">${meta}</div>
					<div class="spotify-hero-actions">${actions}</div>
				</div>
			</section>
		`;
	}

	function renderSearch(data) {
		state.currentPlaylist = null;
		state.currentCollectionType = null;
		state.currentPlaylistTracks = [];
		updateImportState();

		const tracks = (data.tracks?.items || []).filter(Boolean);
		const playlists = (data.playlists?.items || []).filter(Boolean);
		const albums = (data.albums?.items || []).filter(Boolean);
		const artists = (data.artists?.items || []).filter(Boolean);
		const topCards = [
			...tracks.slice(0, 2).map((item) => ["track", item]),
			...playlists.slice(0, 2).map((item) => ["playlist", item])
		];

		els.results.innerHTML = [
			renderSection("Meilleurs résultats", `<div class="spotify-entity-grid">${topCards.map(([type, item]) => renderEntityCard(type, item)).join("")}</div>`),
			renderSection("Titres", renderTrackRows(tracks.slice(0, 10)), `${formatNumber(data.tracks?.total || tracks.length)} résultats`),
			renderSection("Playlists", `<div class="spotify-entity-grid">${playlists.map((item) => renderEntityCard("playlist", item)).join("")}</div>`),
			renderSection("Albums", `<div class="spotify-entity-grid">${albums.map((item) => renderEntityCard("album", item)).join("")}</div>`),
			renderSection("Artistes", `<div class="spotify-entity-grid">${artists.map((item) => renderEntityCard("artist", item)).join("")}</div>`)
		].join("");
		bindTrackRows();
	}

	function renderPlaylist(playlist, reset = true) {
		state.currentPlaylist = playlist;
		state.currentCollectionType = "playlist";
		const playlistItems = playlist.tracks?.items || playlist.items || [];
		state.currentPlaylistTracks = playlistItems
			.map((item) => item && ("track" in item ? item.track : item))
			.filter(Boolean);
		state.currentPlaylistTotal = playlist.tracks?.total || playlist.total || state.currentPlaylistTracks.length;
		if (reset) {
			state.playlistVisibleCount = 50;
			const page = playlist.tracks || playlist;
			state.playlistNextOffset = Number.isInteger(page.next)
				? page.next
				: page.next ? (page.offset || 0) + playlistItems.length : null;
		}
		const visibleTracks = state.currentPlaylistTracks.slice(0, state.playlistVisibleCount);
		updateImportState();

		const meta = [
			playlist.owner?.display_name,
			`${formatNumber(playlist.followers?.total || 0)} abonnes`,
			`${formatNumber(state.currentPlaylistTotal)} titres`
		].filter(Boolean).map(escapeHtml).join(" • ");

		const actions = `
			<button class="btn-primary" type="button" data-play-current ${!state.currentPlaylistTracks.length ? 'disabled' : ''}>Lire la playlist</button>
			<button class="btn-primary" type="button" data-import-current>Importer</button>
			<a class="btn-small" href="${escapeHtml(playlist.external_urls?.spotify || spotifyUrl("playlist", playlist.id))}" target="_blank" rel="noreferrer">Ouvrir Spotify</a>
		`;

		const canLoadMore = visibleTracks.length < state.currentPlaylistTracks.length || state.playlistNextOffset !== null;
		els.results.innerHTML = [
			heroMarkup(playlist, "Playlist", meta, actions),
			renderSection("Titres", renderTrackRows(visibleTracks), `${formatNumber(visibleTracks.length)} / ${formatNumber(state.currentPlaylistTotal)}`),
			canLoadMore ? `<p class="muted" data-playlist-scroll-hint>Défile pour afficher les titres suivants.</p>` : ""
		].join("");
		bindTrackRows();
	}

	function rerenderCurrentPlaylist() {
		if (!state.currentPlaylist) return;
		const scrollTop = els.results.scrollTop;
		const playlist = {
			...state.currentPlaylist,
			tracks: {
				...state.currentPlaylist.tracks,
				total: state.currentPlaylistTotal,
				items: state.currentPlaylistTracks.map((track) => ({ track }))
			}
		};
		renderPlaylist(playlist, false);
		els.results.scrollTop = scrollTop;
	}

	function playlistScrollContainer() {
		for (let element = els.results; element; element = element.parentElement) {
			if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1 &&
				/auto|scroll/.test(pageRoot.defaultView?.getComputedStyle(element).overflowY || 'auto')) return element;
		}
		return els.results;
	}

	async function loadPlaylistOnScroll(container) {
		if (state.currentCollectionType !== 'playlist' || state.busy || state.loadingPlaylistPage) return;
		if (state.playlistVisibleCount >= state.currentPlaylistTracks.length && state.playlistNextOffset === null) return;
		if (!container?.clientHeight || container.scrollHeight - container.clientHeight - container.scrollTop > 80) return;
		await loadMorePlaylistTracks();
	}

	function renderAlbum(album) {
		state.currentPlaylist = album;
		state.currentCollectionType = "album";
		updateImportState();

		const tracks = (album.tracks?.items || []).map((track) => ({
			...track,
			album: { name: album.name, images: album.images }
		}));
		state.currentPlaylistTracks = tracks;
		state.playlistNextOffset = null;
		const meta = [
			album.release_date?.slice(0, 4),
			`${formatNumber(album.total_tracks || tracks.length)} titres`
		].filter(Boolean).map(escapeHtml).join(" • ");
		const artists = artistLinks(album.artists || []);
		const actions = `
			<button class="btn-primary" type="button" data-play-current ${!tracks.length ? 'disabled' : ''}>Lire l'album</button>
			<button class="btn-primary" type="button" data-import-current>Importer l'album</button>
			<a class="btn-small" href="${escapeHtml(album.external_urls?.spotify || spotifyUrl("album", album.id))}" target="_blank" rel="noreferrer">Ouvrir Spotify</a>
		`;

		els.results.innerHTML = [
			heroMarkup(album, "Album", [artists, meta].filter(Boolean).join(" • "), actions),
			renderSection("Titres", renderTrackRows(tracks))
		].join("");
		bindTrackRows();
	}

	function renderArtist(data) {
		state.currentPlaylist = null;
		state.currentCollectionType = null;
		state.currentPlaylistTracks = [];
		updateImportState();

		const artist = data.artist;
		const meta = [
			`${formatNumber(artist.followers?.total || 0)} abonnes`,
			artist.genres?.slice(0, 3).join(", ")
		].filter(Boolean).map(escapeHtml).join(" • ");
		const actions = `<a class="btn-small" href="${escapeHtml(artist.external_urls?.spotify || spotifyUrl("artist", artist.id))}" target="_blank" rel="noreferrer">Ouvrir Spotify</a>`;

		els.results.innerHTML = [
			heroMarkup(artist, "Artiste", meta, actions),
			renderSection("Titres populaires", renderTrackRows(data.top_tracks || [])),
			renderSection("Albums et singles", `<div class="spotify-entity-grid">${(data.albums || []).map((album) => renderEntityCard("album", album)).join("")}</div>`),
			(data.related_artists || []).length
				? renderSection("Artistes similaires", `<div class="spotify-entity-grid">${data.related_artists.map((related) => renderEntityCard("artist", related)).join("")}</div>`)
				: ""
		].join("");
		bindTrackRows();
	}

	function renderLocalLibrary(playlists) {
		state.currentPlaylist = null;
		state.currentCollectionType = null;
		updateImportState();
		const values = playlistEntries(playlists).filter(item => item.name !== LIKED_PLAYLIST);
		els.results.innerHTML = renderSection(
			"Bibliothèque locale",
			`<div class="spotify-entity-grid">${values.map((playlist) => {
				const label = Number.isInteger(playlist.count)
					? `${formatNumber(playlist.count)} titre${playlist.count > 1 ? "s" : ""}`
					: "Playlist locale";
				return `
					<div class="spotify-entity-card is-static">
						${coverMarkup(playlist.image, "", playlist.title)}
						<span class="spotify-card-title">${escapeHtml(playlist.title)}</span>
						<span class="spotify-card-meta">${escapeHtml(label)}</span>
					</div>
				`;
			}).join("")}</div>`,
			`${formatNumber(values.length)} playlists`
		);
		setStatus("");
	}

	function renderSpotifyUserPlaylists(data = {}) {
		state.currentPlaylist = null;
		state.currentCollectionType = null;
		state.currentPlaylistTracks = [];
		updateImportState();
		const playlists = (data.items || []).filter(Boolean);
		state.browserPlaylistIds = new Set(playlists.map((playlist) => playlist.id).filter(Boolean));
		els.results.innerHTML = renderSection(
			"Mes playlists Spotify",
			`<div class="spotify-entity-grid">${playlists.map((playlist) => renderEntityCard("playlist", playlist)).join("")}</div>`,
			`${formatNumber(data.total || playlists.length)} playlists`
		);
		setStatus("");
	}

	function showDetail(type, entity) {
		if (!entity) return;
		const url = imageUrl(entity.images || entity.album?.images || []);
		const external = entity.external_urls?.spotify || spotifyUrl(type, entity.id);
		const subtitle = type === "track"
			? [artistNames(entity.artists || []), entity.album?.name].filter(Boolean).join(" • ")
			: type;
		const addAction = type === "track"
			? `<button class="btn-primary" type="button" data-detail-add-track="${escapeHtml(entity.id)}">Ajouter</button>`
			: "";

		els.detailPanel.innerHTML = `
			<div class="spotify-detail-card">
				${url ? `<img src="${escapeHtml(url)}" alt="">` : `<div class="spotify-hero-cover" aria-hidden="true"></div>`}
				<div class="spotify-detail-meta">
					<h2>${escapeHtml(entity.name || "Sans titre")}</h2>
					<p>${escapeHtml(subtitle)}</p>
					${type === "track" ? `<p>${formatDuration(entity.duration_ms)}</p>` : ""}
					<div class="spotify-hero-actions">
						${addAction}
						<a class="btn-small" href="${escapeHtml(external)}" target="_blank" rel="noreferrer">Ouvrir Spotify</a>
					</div>
				</div>
			</div>
		`;
	}

	function updateImportState() {
		if (!els.importCurrent) return;
		els.importCurrent.disabled = !state.currentPlaylist?.external_urls?.spotify;
	}

	function updateAccountState() {
		if (!els.meButton) return;
		els.meButton.hidden = false;
		els.meButton.title = state.browserBridgeStatus?.installed
			? "Utilise la session ouverte dans open.spotify.com"
			: "Necessite l'extension YouPlayer Spotify Bridge";
	}

	function renderBrowserBridgeStatus(status = state.browserBridgeStatus) {
		if (!els.browserPanel) return;
		const ready = status?.installed && status?.tokenCaptured && status?.authenticated;
		els.browserPanel.classList.toggle("is-connected", Boolean(ready));
		els.browserPanel.classList.toggle("is-disabled", !status?.installed);
		if (els.browserTitle) {
			els.browserTitle.textContent = ready
				? "WebPlayer Spotify connecte"
				: status?.installed
					? "Connecte-toi dans Spotify"
					: "Installe l'extension YouPlayer";
		}
		if (els.browserCopy) {
			els.browserCopy.textContent = ready
				? "Recherches, albums et playlists utilisent ton compte Spotify dans ce navigateur. Le bearer ne quitte jamais l'extension."
				: status?.anonymous
					? "Spotify a fourni un jeton anonyme. Verifie que ton compte est connecte dans le WebPlayer, puis recharge Spotify."
					: status?.spotifyContentReady
						? "L'extension est injectee dans Spotify, mais elle attend encore le jeton WebPlayer. Recharge l'onglet Spotify."
						: status?.installed
							? "Ouvre Spotify dans ce navigateur, connecte-toi puis recharge la page Spotify."
							: "Installe une extension compatible avec le pont YouPlayer, puis recharge cette page.";
		}
		if (els.browserStatus) {
			els.browserStatus.textContent = ready
				? "Pret"
				: status?.anonymous
					? "Anonyme"
					: status?.installed
						? "En attente"
						: "Extension absente";
		}
		if (els.browserOpen) {
			els.browserOpen.textContent = status?.installed ? "Ouvrir Spotify" : "Instructions";
		}
	}

	async function refreshBrowserBridgeStatus() {
		try {
			state.browserBridgeStatus = await browserBridge.status();
		} catch {
			state.browserBridgeStatus = { installed: false };
		}
		renderBrowserBridgeStatus();
		updateAccountState();
		return state.browserBridgeStatus;
	}

	async function loadExistingPlaylists() {
		const playlists = await apiFetch("/playlist_summaries") || await apiFetch("/different_playlist");
		const entries = playlistEntries(playlists || {}).filter(item => item.name !== LIKED_PLAYLIST);
		const options = [`<option value="">Nouvelle playlist</option>`]
			.concat(entries.map((playlist) =>
				`<option value="${escapeHtml(playlist.name)}">${escapeHtml(playlist.title)}</option>`
			));
		els.targetPlaylist.innerHTML = options.join("");
		return playlists || {};
	}

	async function runSearch(query) {
		setStatus("Recherche...");
		let data;
		if (state.browserBridgeStatus?.authenticated && state.browserBridgeStatus?.tokenCaptured) {
			try {
				data = await browserSpotifyRequest("search", { query, limit: 16 });
				data = await completeArtistImages(data, "search", { query, limit: 16 });
			} catch {
				data = await spotifyRequest("search", { query, limit: 16 });
			}
		} else {
			data = await spotifyRequest("search", { query, limit: 16 });
		}
		renderSearch(data);
		setStatus("");
	}

	async function openPlaylist(idOrUrl) {
		setStatus("Chargement de la playlist...");
		const playlistId = String(idOrUrl || "").match(/[A-Za-z0-9]{10,64}/)?.[0] || "";
		let data;
		if (playlistId && state.browserPlaylistIds.has(playlistId)) {
			try {
				data = await browserSpotifyRequest("playlist", { id: playlistId });
			} catch {
				data = await spotifyRequest("playlist", { id: idOrUrl });
			}
		} else {
			data = await spotifyRequest("playlist", { id: idOrUrl });
		}
		renderPlaylist(data);
		setStatus("");
	}

	async function openAlbum(id) {
		setStatus("Chargement de l'album...");
		const summary = state.entities.get(`album:${id}`) || {};
		let album;
		if (state.browserBridgeStatus?.authenticated && state.browserBridgeStatus?.tokenCaptured) {
			try {
				album = await browserSpotifyRequest("album", { id });
			} catch {
				album = await spotifyRequest("album", { id });
			}
		} else {
			album = await spotifyRequest("album", { id });
		}
		renderAlbum({
			...summary,
			...album,
			artists: album.artists?.length ? album.artists : summary.artists,
			images: album.images?.length ? album.images : summary.images,
			external_urls: Object.keys(album.external_urls || {}).length ? album.external_urls : summary.external_urls
		});
		setStatus("");
	}

	async function openArtist(id) {
		setStatus("Chargement de l'artiste...");
		let data;
		if (state.browserBridgeStatus?.authenticated && state.browserBridgeStatus?.tokenCaptured) {
			try {
				data = await browserSpotifyRequest("artist", { id });
				data = await completeArtistImages(data, "artist", { id });
			} catch {
				data = await spotifyRequest("artist", { id });
			}
		} else {
			data = await spotifyRequest("artist", { id });
		}
		renderArtist(data);
		setStatus("");
	}

	async function loadMorePlaylistTracks({ forPlayback = false } = {}) {
		if (!state.currentPlaylist || state.loadingPlaylistPage) return false;
		state.loadingPlaylistPage = true;
		const playlist = state.currentPlaylist;
		const nextVisibleCount = state.playlistVisibleCount + 50;
		try {
			if ((forPlayback || state.currentPlaylistTracks.length < nextVisibleCount) && state.playlistNextOffset !== null) {
				setStatus("Chargement des titres...");
				const offset = state.playlistNextOffset;
				const data = await spotifyRequest("playlist_tracks", { id: playlist.id, offset, limit: 50 });
				if (state.currentPlaylist !== playlist) return false;
				const items = data.items || [];
				const moreTracks = items.map((item) => item && ("track" in item ? item.track : item)).filter(Boolean);
				const next = Number.isInteger(data.next) ? data.next : data.next ? offset + items.length : null;
				if (next !== null && next <= offset) throw new Error('Pagination Spotify invalide');
				state.currentPlaylistTracks.push(...moreTracks);
				state.currentPlaylistTotal = data.total ?? state.currentPlaylistTotal;
				state.playlistNextOffset = next > offset ? next : null;
			}
			state.playlistVisibleCount = nextVisibleCount;
			rerenderCurrentPlaylist();
			setStatus("");
			return true;
		} catch (err) {
			if (forPlayback) throw err;
			setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
		} finally {
			state.loadingPlaylistPage = false;
		}
	}

	async function completePlaybackTracks() {
		const id = state.currentPlaylist?.id;
		const type = state.currentCollectionType;
		if (!id || !state.currentPlaylistTracks.length) return [];
		while (state.playlistNextOffset !== null) {
			if (!await loadMorePlaylistTracks({ forPlayback: true })) throw new Error('Chargement en cours');
			if (state.currentPlaylist?.id !== id || state.currentCollectionType !== type) throw new Error('La playlist a changé');
		}
		return state.currentPlaylistTracks.map(trackPayload);
	}

	async function importCurrentPlaylist() {
		const url = state.currentPlaylist?.external_urls?.spotify;
		if (!url) return;

		setStatus("Import en cours...");
		let response;
		if (state.currentCollectionType === "album" || state.browserPlaylistIds.has(state.currentPlaylist?.id)) {
			const tracks = state.currentPlaylistTracks.map((track) => trackPayload(track));
			let targetPlaylist = els.targetPlaylist.value || state.currentPlaylist.name || "spotify-playlist";
			let imported = 0;
			for (let offset = 0; offset < tracks.length; offset += 50) {
				response = await apiFetch("/spotify_import_browser_playlist", "POST", {
					playlist: targetPlaylist,
					items: tracks.slice(offset, offset + 50)
				});
				if (!response) break;
				targetPlaylist = response.playlist;
				imported += response.count;
			}
			if (!response || imported !== tracks.length) {
				setStatus(apiErrorMessage("Import Spotify incomplet"), true);
				return;
			}
			response = { playlist: targetPlaylist, count: imported };
		} else {
			response = await apiFetch("/spotify_import_playlist", "POST", {
				url,
				playlist: els.targetPlaylist.value || null
			});
			if (!response) {
				setStatus(apiErrorMessage("Import Spotify impossible"), true);
				return;
			}
		}
		setStatus(`Import termine: ${response.playlist} (${response.count} titres)`);
		showNotice(`${state.currentCollectionType === "album" ? "Album" : "Playlist"} importe: ${response.playlist} (${response.count} titres)`);
		await loadExistingPlaylists();
	}

	async function loadMySpotifyPlaylists() {
		setStatus("Chargement des playlists Spotify...");
		const status = await refreshBrowserBridgeStatus();
		if (!status.installed) {
			setStatus("Installe le pont Spotify depuis les Paramètres pour retrouver tes playlists.", true);
			return;
		}
		if (!status.authenticated || !status.tokenCaptured) {
			await browserBridge.openSpotify();
			setStatus("Connecte-toi dans l’onglet Spotify ouvert, puis réessaie.", true);
			return;
		}
		const data = await browserSpotifyRequest("me_playlists");
		renderSpotifyUserPlaylists(data);
	}

	function addTrackById(trackId) {
		const track = state.entities.get(`track:${trackId}`);
		if (!track) return;
		openAddModal(trackPayload(track));
	}

	function bindEvents() {
		const scrollPositions = new WeakMap();
		pageRoot.addEventListener?.('scroll', async (event) => {
			const container = event.target === pageRoot ? pageRoot.scrollingElement : event.target;
			if (container !== els.results && !container?.contains?.(els.results)) return;
			const previous = scrollPositions.get(container) || 0;
			scrollPositions.set(container, container.scrollTop);
			if (container.scrollTop > previous) await loadPlaylistOnScroll(container);
		}, { capture: true, passive: true });
		// Une nouvelle tentative reste possible lorsque le defilement est deja en butee.
		root.addEventListener?.('wheel', async (event) => {
			if (event.deltaY > 0) await loadPlaylistOnScroll(playlistScrollContainer());
		}, { passive: true });
		let touchY = null;
		root.addEventListener?.('touchstart', (event) => {
			touchY = event.touches[0]?.clientY ?? null;
		}, { passive: true });
		root.addEventListener?.('touchmove', async (event) => {
			const nextY = event.touches[0]?.clientY ?? null;
			const downward = touchY !== null && nextY !== null && nextY < touchY;
			touchY = nextY;
			if (downward) await loadPlaylistOnScroll(playlistScrollContainer());
		}, { passive: true });
		els.searchForm?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const query = els.searchInput.value.trim();
			if (!query) return;
			try {
				await runSearch(query);
			} catch (err) {
				setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
			}
		});

		els.playlistOpenForm?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const value = els.playlistUrl.value.trim();
			if (!value) return;
			try {
				await openPlaylist(value);
			} catch (err) {
				setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
			}
		});

		els.importCurrent?.addEventListener("click", async () => {
			try {
				await importCurrentPlaylist();
			} catch (err) {
				setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
			}
		});

		els.libraryButton?.addEventListener("click", async () => {
			try {
				const playlists = await loadExistingPlaylists();
				renderLocalLibrary(playlists);
			} catch (err) {
				setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
			}
		});

		els.meButton?.addEventListener("click", async () => {
			try {
				await loadMySpotifyPlaylists();
			} catch (err) {
				setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
			}
		});

		els.browserOpen?.addEventListener("click", async () => {
			try {
				if (!state.browserBridgeStatus?.installed) {
					setStatus("Installe une extension compatible avec le pont YouPlayer", true);
					return;
				}
				await browserBridge.openSpotify();
			} catch (err) {
				setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
			}
		});

		els.results?.addEventListener("click", async (event) => {
			try {
				if (event.target.closest('[data-play-current]')) {
					const collection = await completePlaybackTracks();
					if (collection.length) await playCollection(collection, 0);
					return;
				}
				const importButton = event.target.closest("[data-import-current]");
				if (importButton) {
					await importCurrentPlaylist();
					return;
				}

				const addButton = event.target.closest("[data-add-track]");
				if (addButton) {
					event.stopPropagation();
					addTrackById(addButton.dataset.addTrack);
					return;
				}
				const queueButton = event.target.closest('[data-queue-track]');
				if (queueButton) {
					event.stopPropagation();
					const track = state.entities.get(`track:${queueButton.dataset.queueTrack}`);
					if (track) await queueTrack(trackPayload(track));
					return;
				}
				const likeButton = event.target.closest('.spotify-like');
				if (likeButton) {
					event.stopPropagation();
					const row = likeButton.closest('.spotify-track-row');
					const track = state.entities.get(`track:${row?.dataset.entityId}`);
					if (track) await toggleLike(trackPayload(track));
					return;
				}

				const openButton = event.target.closest("[data-open-url]");
				if (openButton) {
					event.stopPropagation();
					window.open(openButton.dataset.openUrl, "_blank", "noreferrer");
					return;
				}

				const entityEl = event.target.closest("[data-entity-type][data-entity-id]");
				if (!entityEl) return;

				const type = entityEl.dataset.entityType;
				const id = entityEl.dataset.entityId;
				const entity = state.entities.get(`${type}:${id}`);
				if (type === 'track' && entityEl.classList.contains('spotify-track-row')) {
					const index = Number(entityEl.dataset.collectionIndex);
					if (entity && isControlledPlayback() && state.currentPlaylist && state.currentPlaylistTracks[index]?.id === id) {
						const collection = await completePlaybackTracks();
						await playTrack(collection[index], { collection, collectionIndex: index });
					} else if (entity) await playTrack(trackPayload(entity));
					return;
				}
				showDetail(type, entity);

				if (type === "playlist") {
					await openPlaylist(id);
				} else if (type === "album") {
					await openAlbum(id);
				} else if (type === "artist") {
					await openArtist(id);
				}
			} catch {
				setStatus("Spotify est momentanément indisponible. Réessaie dans un instant.", true);
			}
		});

		els.results?.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			const entityEl = event.target.closest("[data-entity-type][data-entity-id]");
			if (entityEl && event.target === entityEl && entityEl.tagName !== 'BUTTON') {
				event.preventDefault();
				entityEl.click();
			}
		});

		els.detailPanel?.addEventListener("click", (event) => {
			const addButton = event.target.closest("[data-detail-add-track]");
			if (addButton) {
				addTrackById(addButton.dataset.detailAddTrack);
			}
		});
	}

	return {
		init() {
			if (state.initialized) return;
			state.initialized = true;
			bindEvents();
			updateImportState();
			updateAccountState();
			renderBrowserBridgeStatus({ installed: false });
		},
		async activate() {
			this.init();
			updateAccountState();
			await loadExistingPlaylists();
			await refreshBrowserBridgeStatus();
		},
		async refreshConnection() {
			this.init();
			await refreshBrowserBridgeStatus();
		},
		refreshAccountState() {
			updateAccountState();
		}
	};
}
