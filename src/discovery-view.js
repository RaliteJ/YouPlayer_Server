import { LIKED_PLAYLIST, publicErrorMessage, trackLikeKey, spotifyTrackIdForSource, youtubeVideoIdForSource } from './client-utils.js';
import { artistLinksMarkup } from './artist-view.js';

export function createDiscoveryView({ apiUrl: API_URL, fetchImpl = (...args) => fetch(...args) }) {
    return {
    closeSongActionMenu() {
        if (this.songActionMenu) {
            const anchor = this.songActionMenu.anchor;
            const hadFocus = this.songActionMenu.contains(document.activeElement);
            this.songActionMenu.remove();
            if (hadFocus) anchor?.focus();
            this.songActionMenu = null;
        }
    },

    openSongActionMenu(button, songData, { previewPlaylist = null, discovered = false, onPlay = null } = {}) {
        this.closeSongActionMenu();

        const manualSourceId = this.currentUser?.role === 'user' ? spotifyTrackIdForSource(songData) : null;
        const menu = document.createElement('div');
        menu.className = 'song-action-menu';
        menu.innerHTML = `
            <button type="button" data-action="play">Lire maintenant</button>
            <button type="button" data-action="next">Lire ensuite</button>
            <button type="button" data-action="add">Ajouter à une playlist</button>
            ${discovered && songData.type === 'spotify' ? '<button type="button" data-action="open">Ouvrir dans Spotify</button>' : ''}
            ${manualSourceId ? '<button type="button" data-action="source">Changer la source</button>' : ''}
            ${!discovered && (previewPlaylist || !songData.__queueId) ? '<button type="button" data-action="delete" class="danger">Supprimer</button>' : ''}
        `;

        const request = previewPlaylist
            ? { previewPlaylist: previewPlaylist.name, previewIndex: songData.__playlistIndex, key: trackLikeKey(songData) }
            : discovered ? songData : songData.__sessionIndex;
        menu.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = e.target.dataset.action;
            if (action === 'play' || action === 'next') {
                this.closeSongActionMenu();
                if (action === 'play' && onPlay) await onPlay();
                else await this.enqueueNextSong(request, { playNow: action === 'play' });
            }
            if (action === 'open') {
                this.closeSongActionMenu();
                window.open(songData.url, '_blank', 'noopener,noreferrer');
            }
            if (action === 'add') {
                this.closeSongActionMenu();
                this.openAddModal(songData);
            }
            if (action === 'source') {
                this.closeSongActionMenu();
                this.openSourceDialog(songData, manualSourceId);
            }
            if (action === 'delete') {
                this.closeSongActionMenu();
                if (previewPlaylist) await this.deletePreviewSong(previewPlaylist, songData);
                else await this.deleteSong(songData);
            }
        });

        document.body.appendChild(menu);
        const rect = button.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const top = Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 8);
        const left = Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8);
        menu.style.top = `${Math.max(8, top)}px`;
        menu.style.left = `${Math.max(8, left)}px`;
        menu.anchor = button;
        this.songActionMenu = menu;
        menu.querySelector('button')?.focus();
    },

    closeSourceDialog() {
        const dialog = this.sourceDialog;
        if (!dialog) return;
        // Any in-flight callback becomes inert; the native close is never blocked.
        this.sourceDialogState = null;
        if (dialog.open) dialog.close();
    },

    setSourceDialogStatus(message = '') {
        const status = this.sourceDialog?.querySelector('[data-source-status]');
        if (status) status.textContent = message;
    },

    sourceOperationValid(state) {
        const dialog = this.sourceDialog;
        return Boolean(dialog?.open
            && state
            && this.sourceDialogState === state
            && state.userId != null
            && this.currentUser?.id === state.userId);
    },

    async openSourceDialog(songData, trackId) {
        this.closeSourceDialog();
        const dialog = document.getElementById('source-dialog');
        if (!dialog) return;
        this.sourceDialog = dialog;
        const state = { trackId, userId: this.currentUser?.id ?? null };
        this.sourceDialogState = state;
        const name = dialog.querySelector('[data-source-track-name]');
        if (name) name.textContent = songData?.title || songData?.name || 'Morceau Spotify';
        const input = dialog.querySelector('#source-url-input');
        if (input) input.value = '';
        dialog.querySelector('[data-source-reset]').hidden = true;
        const test = dialog.querySelector('[data-source-test]');
        if (test) test.setAttribute('href', '#');
        this.setSourceDialogStatus('Chargement de la source actuelle…');
        this.bindSourceDialog(dialog);
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        state.pending = 'load';
        const stored = await this.apiFetch(`/playback/source/${encodeURIComponent(trackId)}`);
        state.pending = null;
        if (!this.sourceOperationValid(state)) return;
        if (stored === null) {
            this.setSourceDialogStatus('Source actuelle indisponible. Réessaie dans un instant.');
            return;
        }
        if (stored.url) {
            if (input) input.value = stored.url;
            dialog.querySelector('[data-source-reset]').hidden = false;
            this.setSourceDialogStatus('Une source manuelle est enregistrée pour ce morceau.');
        } else {
            this.setSourceDialogStatus('Recherche automatique active pour ce morceau.');
        }
    },

    bindSourceDialog(dialog) {
        if (dialog.dataset.sourceBound === '1') return;
        dialog.dataset.sourceBound = '1';
        const input = dialog.querySelector('#source-url-input');
        const resetButton = dialog.querySelector('[data-source-reset]');

        dialog.querySelector('[data-source-test]').addEventListener('click', event => {
            const videoId = youtubeVideoIdForSource(input?.value);
            if (!videoId) {
                event.preventDefault();
                this.setSourceDialogStatus('Colle un lien YouTube ou YouTube Music exact (watch?v=… ou youtu.be/…).');
                return;
            }
            // Only the canonical YouTube page opens in a new tab: nothing is
            // saved and no YouPlayer playback is touched.
            event.currentTarget.setAttribute('href', `https://www.youtube.com/watch?v=${videoId}`);
        });

        dialog.querySelector('[data-source-save]').addEventListener('click', async () => {
            const state = this.sourceDialogState;
            if (!this.sourceOperationValid(state) || state.pending) return;
            const videoId = youtubeVideoIdForSource(input?.value);
            if (!videoId) {
                this.setSourceDialogStatus('Lien invalide : utilise un lien YouTube ou YouTube Music exact.');
                return;
            }
            this.setSourceDialogStatus('Enregistrement…');
            state.pending = 'save';
            const response = await this.apiFetch(`/playback/source/${encodeURIComponent(state.trackId)}`, 'PUT', {
                url: input.value.trim()
            });
            state.pending = null;
            if (!this.sourceOperationValid(state)) return;
            if (!response) {
                this.setSourceDialogStatus('Enregistrement impossible. Réessaie dans un instant.');
                return;
            }
            input.value = response.url;
            resetButton.hidden = false;
            this.setSourceDialogStatus('Source manuelle enregistrée pour ce morceau.');
            this.clearNextTrackPrefetch();
            void this.refreshPlaybackState();
        });

        resetButton.addEventListener('click', async () => {
            const state = this.sourceDialogState;
            if (!this.sourceOperationValid(state) || state.pending) return;
            this.setSourceDialogStatus('Rétablissement…');
            state.pending = 'reset';
            const response = await this.apiFetch(`/playback/source/${encodeURIComponent(state.trackId)}`, 'DELETE', {});
            state.pending = null;
            if (!this.sourceOperationValid(state)) return;
            if (!response) {
                this.setSourceDialogStatus('Rétablissement impossible. Réessaie dans un instant.');
                return;
            }
            input.value = '';
            resetButton.hidden = true;
            this.setSourceDialogStatus('Recherche automatique rétablie pour ce morceau.');
            this.clearNextTrackPrefetch();
            void this.refreshPlaybackState();
        });

        dialog.addEventListener('close', () => {
            // In-flight callbacks become inert, but a dialog already reopened
            // keeps its fresh state: only a really closed one lets it go.
            if (!dialog.open) this.sourceDialogState = null;
        });
    },

    closeSpotifyActionMenu() {
        if (this.spotifyActionMenu) {
            this.spotifyActionMenu.remove();
            this.spotifyActionMenu = null;
        }
    },

    getSpotifyPlaylistUrl() {
        const url = (document.getElementById("query_spotify")?.value || "").trim();
        if (!url.includes("open.spotify.com/playlist/")) {
            this.showNotice("Colle d'abord un lien de playlist Spotify.");
            return "";
        }
        return url;
    },

    positionMenu(menu, anchor) {
        document.body.appendChild(menu);
        const rect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const top = Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 8);
        const left = Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8);
        menu.style.top = `${Math.max(8, top)}px`;
        menu.style.left = `${Math.max(8, left)}px`;
    },

    async openSpotifyActionMenu(anchor) {
        this.closeSpotifyActionMenu();

        const menu = document.createElement('div');
        menu.className = 'song-action-menu spotify-action-menu';
        menu.innerHTML = `
            <button type="button" data-action="create">Créer une playlist</button>
            <button type="button" data-action="append">Intégrer à une playlist</button>
        `;

        menu.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = e.target.dataset.action;
            if (action === 'create') {
                this.closeSpotifyActionMenu();
                await this.importSpotifyPlaylist();
            }
            if (action === 'append') {
                await this.openSpotifyPlaylistPicker(menu);
            }
        });

        this.positionMenu(menu, anchor);
        this.spotifyActionMenu = menu;
    },

    async openSpotifyPlaylistPicker(menu) {
        const playlists = await this.apiFetch('/playlist_summaries');
        if (!playlists) {
            this.showNotice(this.apiErrorMessage("Impossible de charger les playlists."));
            return;
        }

        const playlistEntries = this.playlistEntries(playlists).filter(item => item.name !== LIKED_PLAYLIST);
        menu.innerHTML = `
            <button type="button" data-action="back">Retour</button>
            ${playlistEntries.map((playlist) => this.playlistPickerButtonMarkup(playlist)).join('')}
        `;

        menu.onclick = async (e) => {
            e.stopPropagation();
            if (e.target.dataset.action === 'back') {
                this.closeSpotifyActionMenu();
                const button = document.getElementById('btn-spotify-playlist-actions');
                if (button) this.openSpotifyActionMenu(button);
                return;
            }
            if (e.target.dataset.playlist) {
                const playlist = e.target.dataset.playlist;
                this.closeSpotifyActionMenu();
                await this.importSpotifyPlaylist(playlist);
            }
        };
    },

    async importSpotifyPlaylist(playlist = null) {
        const url = this.getSpotifyPlaylistUrl();
        if (!url) return;

        const response = await this.apiFetch('/spotify_import_playlist', 'POST', { url, playlist });
        if (!response) {
            this.showNotice(this.apiErrorMessage("Erreur pendant l'import de la playlist Spotify."));
            return;
        }

        this.showNotice(`Playlist importée: ${response.playlist} (${response.count} titres)`);
        document.getElementById("query_spotify").value = "";
        this.fetchAvailablePlaylists();
    },

    async openYoutubePlaylistActionMenu(anchor, playlistData) {
        this.closeSongActionMenu();

        const menu = document.createElement('div');
        menu.className = 'song-action-menu';
        menu.innerHTML = `
            <button type="button" data-action="create">Créer une playlist</button>
            <button type="button" data-action="append">Intégrer à une playlist</button>
        `;

        menu.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = e.target.dataset.action;
            if (action === 'create') {
                this.closeSongActionMenu();
                await this.importYoutubePlaylist(playlistData);
            }
            if (action === 'append') {
                await this.openYoutubePlaylistPicker(menu, playlistData);
            }
        });

        this.positionMenu(menu, anchor);
        this.songActionMenu = menu;
    },

    async openYoutubePlaylistPicker(menu, playlistData) {
        const playlists = await this.apiFetch('/playlist_summaries');
        if (!playlists) {
            this.showNotice(this.apiErrorMessage("Impossible de charger les playlists."));
            return;
        }

        const playlistEntries = this.playlistEntries(playlists).filter(item => item.name !== LIKED_PLAYLIST);
        menu.innerHTML = `
            <button type="button" data-action="back">Retour</button>
            ${playlistEntries.map((playlist) => this.playlistPickerButtonMarkup(playlist)).join('')}
        `;

        menu.onclick = async (e) => {
            e.stopPropagation();
            if (e.target.dataset.action === 'back') {
                this.closeSongActionMenu();
                this.openYoutubePlaylistActionMenu(document.getElementById('btn-search-yt'), playlistData);
                return;
            }
            if (e.target.dataset.playlist) {
                this.closeSongActionMenu();
                await this.importYoutubePlaylist(playlistData, e.target.dataset.playlist);
            }
        };
    },

    async importYoutubePlaylist(playlistData, playlist = null) {
        const response = await this.apiFetch('/youtube_import_playlist', 'POST', {
            playlistId: playlistData.playlistId,
            title: playlistData.title,
            playlist
        });

        if (!response) {
            this.showNotice(this.apiErrorMessage("Erreur pendant l'import de la playlist YouTube."));
            return;
        }

        this.showNotice(`Playlist importée: ${response.playlist} (${response.count} titres)`);
        await this.fetchAvailablePlaylists();
    },

    // --- LOGIQUE DE LA POPUP ---
    async openAddModal(songData) {
        this.songPendingAdd = songData;
        this.modal.style.display = 'flex';
        this.modalInputNew.value = ""; // On vide le champ au cas où
        const isLocalUpload = songData?.type === 'local' && Boolean(songData.file);
        this.modalLocalMetadata.hidden = !isLocalUpload;
        this.modalLocalTitle.value = isLocalUpload ? songData.title || '' : '';
        this.modalLocalArtist.value = isLocalUpload ? songData.artist || '' : '';
        this.modalLocalArtwork.value = '';

        // Récupération des playlists existantes pour la liste déroulante
        const playlists = await this.apiFetch('/playlist_summaries');

        if (playlists) {
            this.modalSelect.innerHTML = this.playlistEntries(playlists).filter(item => item.name !== LIKED_PLAYLIST)
                .map((playlist) => this.playlistOptionMarkup(playlist))
                .join('');
        } else {
            this.modalSelect.innerHTML = '<option value="">Aucune playlist trouvée</option>';
        }
    },

async confirmAddSong(playlistName) {
        if (!this.songPendingAdd) return;

        // On s'assure que le nom finit bien par .json
        const finalPlaylistName = playlistName.endsWith('.json') ? playlistName : `${playlistName}.json`;

        // ----------------------------------------------------
        // CAS 1 : C'EST UN FICHIER LOCAL A UPLOADER
        // ----------------------------------------------------
        if (this.songPendingAdd.type === "local" && this.songPendingAdd.file) {
            const formData = new FormData();
            formData.append('file', this.songPendingAdd.file); // Le fichier audio
            formData.append('playlist', finalPlaylistName);    // Le nom de la playlist
            const title = this.modalLocalTitle.value.trim();
            if (!title) {
                this.showNotice('Indique un titre pour cette musique.', true);
                return;
            }
            formData.append('title', title);
            formData.append('artist', this.modalLocalArtist.value.trim());

            try {
                const artwork = this.modalLocalArtwork.files?.[0];
                if (artwork) formData.append('albumCoverURL', await this.localArtworkDataUrl(artwork));
                const response = await fetchImpl(`${API_URL}/upload_to_playlist`, {
                    method: 'POST',
                    credentials: 'include',
                    body: formData // Le navigateur gère le Content-Type tout seul
                });

                if (response.ok) {
                    this.showNotice(`Fichier envoyé et ajouté à ${playlistName}.`);
                    this.modal.style.display = 'none';
                    this.fileInput.value = ""; // On vide l'input
                } else {
                    this.showNotice(await this.responseErrorMessage(response, "Erreur lors de l'envoi du fichier."));
                }
            } catch (error) {
                this.showNotice(error?.localMessage || publicErrorMessage(0), true);
            }
        }
        // ----------------------------------------------------
        // CAS 2 : C'EST YOUTUBE OU SPOTIFY (Texte/JSON)
        // ----------------------------------------------------
        else {
            const payload = {
                playlist: finalPlaylistName,
                song: this.songPendingAdd
            };

            try {
                const response = await fetchImpl(`${API_URL}/update_playlist`, {
                    method: 'POST',
                    credentials: 'include',

                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({arg:payload})
                });

                if (response.ok) {
                    this.showNotice('Ajouté avec succès.');
                    this.modal.style.display = 'none';
                } else {
                    this.showNotice(await this.responseErrorMessage(response, "Erreur lors de l'ajout."));
                }
            } catch (e) {
                console.error("Erreur ajout web:", e);
                this.showNotice(publicErrorMessage(0), true);
            }
        }
    },

    async localArtworkDataUrl(file) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
            throw Object.assign(new Error('Image non prise en charge'), { localMessage: 'Choisis une image PNG, JPEG ou WebP de moins de 8 Mo.' });
        }
        const objectUrl = URL.createObjectURL(file);
        try {
            const image = new Image();
            image.src = objectUrl;
            await image.decode();
            const ratio = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/webp', 0.78);
            if (dataUrl.length > 175000) throw Object.assign(new Error('Image trop volumineuse'), { localMessage: 'Cette image reste trop volumineuse. Choisis-en une autre.' });
            return dataUrl;
        } catch (error) {
            if (error?.localMessage) throw error;
            throw Object.assign(new Error('Image illisible'), { localMessage: 'Cette image est illisible. Choisis-en une autre.' });
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    },

    // --- LOGIQUE DE VUE ---

	    async searchSpotify() {
	        const query = document.getElementById("query_spotify").value;
	        if (!query) return this.showNotice("Colle un lien Spotify.");

        if (query.includes("open.spotify.com/playlist/")) {
            const button = document.getElementById('btn-spotify-playlist-actions');
            if (button) {
                this.openSpotifyActionMenu(button);
            } else {
                await this.importSpotifyPlaylist();
            }
	            return;
	        }

	        if (!query.includes("open.spotify.com/track/")) {
	            this.showNotice("Colle un lien de piste ou de playlist Spotify.");
	            return;
	        }

	        const response = await this.apiFetch("/spotify_test", "POST", {
	            action: "track",
	            url: query
	        });
	        const track = response?.data;
	        if (!track) {
	            this.showNotice("Impossible de lire cette piste Spotify.");
	            return;
	        }

	        this.openAddModal({
	            title: track.name || "Titre inconnu",
	            artist: (track.artists || []).map((artist) => artist.name).filter(Boolean).join(", "),
            spotifyArtists: track.artists || [],
	            album: track.album?.name || "",
	            albumCoverURL: track.album?.images?.[0]?.url || "",
	            trackNumber: track.track_number || 0,
	            ...(Number(track.duration_ms) > 0 ? { duration_ms: track.duration_ms } : {}),
	            url: track.external_urls?.spotify || query,
	            type: "spotify"
	        });
	    },

    async searchYoutube() {
        const query = document.getElementById('query_yt').value.trim();
        if (!query) return;
        const filter = document.getElementById('youtube-search-filter')?.value || 'all';

        this.ytResults.innerHTML = '<p class="youtube-empty">Recherche en cours…</p>';
        const data = await this.apiFetch('/send_search_youtube', 'POST', { arg: query, type: filter });
        if (!data) {
            this.ytResults.innerHTML = '<p class="youtube-empty">La recherche a échoué. Réessaie dans un instant.</p>';
            return;
        }

        const channelIdPattern = /^UC[\w-]{22}$/;
        // Ignore null or incomplete entries once: both the rendering and the
        // card bindings below work on the verified source list only.
        const items = (Array.isArray(data?.items) ? data.items : [])
            .filter(item => item?.id && item?.snippet);
        this.ytResults.innerHTML = items.map(item => {
            const kind = item.id?.kind;
            const isPlaylist = kind === 'youtube#playlist';
            const isChannel = kind === 'youtube#channel';
            // Only a validated channel id produces a link; anything malformed
            // is skipped rather than rendering an undefined card.
            const channelId = isChannel ? (item.id.channelId || '') : '';
            const id = isPlaylist ? item.id.playlistId : isChannel ? channelId : item.id?.videoId;
            if (!id || (isChannel && !channelIdPattern.test(channelId))) return '';
            const thumbnail = item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '';
            const title = this.escapeHtml(item.snippet.title);

            if (isChannel) {
                return `
                    <div class="video-card channel-result-card" data-id="${this.escapeHtml(channelId)}" data-kind="channel">
                        <img src="${this.escapeHtml(thumbnail)}" alt="" loading="lazy">
                        <span class="result-badge">Chaîne</span>
                        <div class="youtube-card-copy"><p>${title}</p><span class="youtube-channel">${this.escapeHtml(item.snippet.channelTitle || 'YouTube')}</span></div>
                        <a class="btn-small youtube-channel-link" href="https://www.youtube.com/channel/${channelId}" target="_blank" rel="noopener noreferrer">Ouvrir la chaîne</a>
                    </div>
                `;
            }

            return `
                <div class="video-card ${isPlaylist ? 'playlist-result-card' : ''}" data-id="${this.escapeHtml(id)}" data-kind="${isPlaylist ? 'playlist' : 'video'}">
                    <img src="${this.escapeHtml(thumbnail)}" alt="" loading="lazy">
                    ${isPlaylist ? '<span class="result-badge">Playlist</span>' : ''}
                    <div class="youtube-card-copy"><p>${title}</p><span class="youtube-channel">${isPlaylist ? this.escapeHtml(item.snippet.channelTitle || 'YouTube') : artistLinksMarkup({ type: 'youtube', title: item.snippet.title, channelTitle: item.snippet.channelTitle })}</span></div>
                    ${isPlaylist ? '<button type="button" class="btn-small import-youtube-playlist">Importer playlist</button>' : `<div class="youtube-card-actions"><button type="button" class="btn-small youtube-add" aria-label="Ajouter à une playlist">+ Ajouter</button><button type="button" class="song-like youtube-like" aria-label="Aimer ce morceau" title="Aimer ce morceau">♡</button><button type="button" class="youtube-options" aria-label="Options du morceau" title="Options du morceau" aria-haspopup="true">⋯</button></div>`}
                </div>
            `;
        }).join('') || '<div class="youtube-empty"><h2>Aucun résultat</h2><p>Essaie un autre titre ou le nom de l’artiste.</p></div>';

        this.ytResults.querySelectorAll('.video-card').forEach(card => {
            if (card.dataset.kind !== 'video') return;
            const result = items.find(item => item.id.videoId === card.dataset.id);
            const song = {
                title: result?.snippet?.title || card.querySelector('p').innerText,
                url: `https://www.youtube.com/watch?v=${card.dataset.id}`,
                type: 'youtube',
                thumbnail: result?.snippet?.thumbnails?.high?.url || result?.snippet?.thumbnails?.default?.url || '',
                channelTitle: result?.snippet?.channelTitle || ''
            };
            card.querySelector('.youtube-like').outerHTML = this.likeButtonMarkup(song).replace('class="song-like"', 'class="song-like youtube-like"');
            card.tabIndex = 0;
            card.setAttribute('aria-label', `Lire ${song.title}`);
            card.onclick = () => void this.enqueueNextSong(song, { playNow: true });
            card.onkeydown = event => {
                if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                card.click();
            };
            card.querySelector('.youtube-add').onclick = event => {
                event.stopPropagation();
                void this.openAddModal(song);
            };
            card.querySelector('.youtube-options').onclick = event => {
                event.stopPropagation();
                this.openSongActionMenu(event.currentTarget, song, { discovered: true });
            };
            card.querySelector('.youtube-like').onclick = event => {
                event.stopPropagation();
                void this.toggleDiscoveredTrackLike(song);
            };
            this.bindQueueSwipe(card, song);
        });

        this.ytResults.querySelectorAll('.import-youtube-playlist').forEach(button => {
            button.onclick = (e) => {
                e.stopPropagation();
                const card = e.currentTarget.closest('.video-card');
                const result = items.find(item => item.id.playlistId === card.dataset.id);
                this.openYoutubePlaylistActionMenu(e.currentTarget, {
                    playlistId: card.dataset.id,
                    title: result?.snippet?.title || card.querySelector('p').innerText
                });
            };
        });

    },


    async uploadLocalFile(file) {
        const formData = new FormData();
        formData.append('playlist', "playlist.json");
        formData.append('file', file);

        try {

            const response = await fetchImpl(`${API_URL}/upload_to_playlist`, {
                method: 'POST',
                credentials: 'include',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Erreur serveur: ${response.status}`);
            }


            this.fileInput.value = "";

        } catch (error) {
            console.error("Erreur lors de l'upload :", error);
            this.showNotice("L'upload a échoué.");
        }
    },

    // --- MEDIA SESSION ---

    };
}
