import { LIKED_PLAYLIST, publicErrorMessage } from './client-utils.js';

export function createDiscoveryView({ apiUrl: API_URL, fetchImpl = (...args) => fetch(...args) }) {
    return {
    closeSongActionMenu() {
        if (this.songActionMenu) {
            this.songActionMenu.remove();
            this.songActionMenu = null;
        }
    },

    openSongActionMenu(button, songData, { previewPlaylist = null } = {}) {
        this.closeSongActionMenu();

        const menu = document.createElement('div');
        menu.className = 'song-action-menu';
        menu.innerHTML = `
            ${previewPlaylist ? '' : '<button type="button" data-action="next">Lire ensuite</button>'}
            <button type="button" data-action="add">Ajouter à une playlist</button>
            ${previewPlaylist || !songData.__queueId ? '<button type="button" data-action="delete" class="danger">Supprimer</button>' : ''}
        `;

        menu.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = e.target.dataset.action;
            if (action === 'next') {
                this.closeSongActionMenu();
                await this.enqueueNextSong(songData.__sessionIndex);
            }
            if (action === 'add') {
                this.closeSongActionMenu();
                this.openAddModal(songData);
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
        this.songActionMenu = menu;
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
        const playlists = await this.apiFetch('/different_playlist');
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
        const playlists = await this.apiFetch('/different_playlist');
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
        const playlists = await this.apiFetch('/different_playlist');

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
	            album: track.album?.name || "",
	            albumCoverURL: track.album?.images?.[0]?.url || "",
	            trackNumber: track.track_number || 0,
	            ...(Number(track.duration_ms) > 0 ? { duration_ms: track.duration_ms } : {}),
	            url: track.external_urls?.spotify || query,
	            type: "spotify"
	        });
	    },

    async searchYoutube() {
        const query = document.getElementById('query_yt').value;
        if (!query) return;

        this.ytResults.innerHTML = "Recherche...";
        const data = await this.apiFetch('/send_search_youtube', 'POST', { arg: query });
        if (!data) {
            this.ytResults.innerHTML = "";
            return;
        }

        const items = Array.isArray(data?.items) ? data.items : [];
        const hasPlaylist = items.some(item => item.id.kind === 'youtube#playlist');
        this.ytResults.innerHTML = items.map(item => {
            const isPlaylist = item.id.kind === 'youtube#playlist';
            const id = isPlaylist ? item.id.playlistId : item.id.videoId;
            const thumbnail = item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '';
            const title = this.escapeHtml(item.snippet.title);

            return `
                <div class="video-card ${isPlaylist ? 'playlist-result-card' : ''}" data-id="${this.escapeHtml(id)}" data-kind="${isPlaylist ? 'playlist' : 'video'}">
                    <img src="${this.escapeHtml(thumbnail)}" alt="">
                    ${isPlaylist ? '<span class="result-badge">Playlist</span>' : ''}
                    <p>${title}</p>
                    ${isPlaylist ? '<button type="button" class="btn-small import-youtube-playlist">Importer playlist</button>' : `<div class="youtube-card-actions"><button type="button" class="song-like youtube-like" aria-label="Aimer ce morceau" title="Aimer ce morceau">♡</button><button type="button" class="youtube-options" aria-label="Ajouter à une playlist" title="Ajouter à une playlist" aria-haspopup="dialog">+</button></div>`}
                </div>
            `;
        }).join('') || "Aucun résultat.";

        if (!hasPlaylist) {
            this.ytResults.insertAdjacentHTML('afterbegin', '<p class="results-message">Aucune playlist trouvée pour cette recherche.</p>');
        }

        this.ytResults.querySelectorAll('.video-card').forEach(card => {
            if (card.dataset.kind === 'playlist') return;
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
            card.querySelector('.youtube-options').onclick = event => {
                event.stopPropagation();
                void this.openAddModal(song);
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
