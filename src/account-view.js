import { publicErrorMessage } from './client-utils.js';

// Preserve the app origin and the shared App receiver for account and logout actions.
export function createAccountView({ apiUrl: API_URL, fetchImpl = (...args) => fetch(...args) }) {
    return {
        selectAdminTab(tab, focus = false) {
            const tabs = Array.from(document.querySelectorAll('#view-admin [role="tab"]'));
            if (!tabs.includes(tab)) return;
            for (const item of tabs) {
                const selected = item === tab;
                item.setAttribute('aria-selected', String(selected));
                item.tabIndex = selected ? 0 : -1;
                const panel = document.getElementById(item.getAttribute('aria-controls'));
                if (panel) panel.hidden = !selected;
            }
            if (focus) tab.focus();
        },

        bindAdminTabs() {
            const tabs = Array.from(document.querySelectorAll('#view-admin [role="tab"]'));
            tabs.forEach((tab, index) => {
                tab.onclick = () => this.selectAdminTab(tab);
                tab.onkeydown = event => {
                    let next;
                    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
                    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
                    else if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = tabs.length - 1;
                    else return;
                    event.preventDefault();
                    this.selectAdminTab(tabs[next], true);
                };
            });
        },

        renderAuthState() {
            const managementOnly = this.currentUser?.role === 'admin';
            document.body.classList.toggle('management-only', managementOnly);
            const preferenceUser = this.currentUser?.id ?? 'local';
            if (this.controlledPlaybackUser !== preferenceUser) {
                this.controlledPlaybackUser = preferenceUser;
                this.controlledPlayback = false;
                try {
                    this.controlledPlayback = window.localStorage.getItem(`controlledPlayback:${preferenceUser}`) === 'true';
                } catch { /* Storage may be unavailable. */ }
            }
            if (this.controlledPlaybackToggle) this.controlledPlaybackToggle.checked = this.controlledPlayback;
            const spotifyConnected = this.currentUser?.spotify?.connected === true;
            const authLabels = {
                spotify: 'Spotify',
                local: 'local'
            };
            if (this.sessionUser) {
                const displayName = this.currentUser?.displayName || this.currentUser?.pseudo;
                const authLevel = authLabels[this.currentUser?.authLevel] || this.currentUser?.role;
                this.sessionUser.innerText = this.currentUser
                    ? `${displayName} · ${authLevel}`
                    : 'Session locale';
            }
            if (this.adminNav) {
                this.adminNav.hidden = this.currentUser?.role !== 'admin';
            }
            if (this.spotifyLoginButton) {
                this.spotifyLoginButton.hidden = managementOnly || !this.spotifyOAuthEnabled;
            }
            if (this.spotifySettingsConnect) {
                this.spotifySettingsConnect.hidden = managementOnly || !this.spotifyOAuthEnabled || spotifyConnected;
            }
            if (this.spotifySettingsDisconnect) {
                this.spotifySettingsDisconnect.hidden = managementOnly || !spotifyConnected;
            }
            if (this.spotifySettingsStatus) {
                if (!this.spotifyOAuthEnabled) {
                    this.spotifySettingsStatus.innerText = 'Connexion Spotify non configuree.';
                } else if (spotifyConnected) {
                    const spotifyName = this.currentUser?.spotify?.displayName;
                    this.spotifySettingsStatus.innerText = spotifyName
                        ? `Compte Spotify connecte : ${spotifyName}.`
                        : 'Compte Spotify connecte.';
                } else {
                    this.spotifySettingsStatus.innerText = 'Non connecte.';
                }
            }
            this.renderSpotifyConnectPanel(spotifyConnected);
            if (!managementOnly) this.spotifyExplorer?.refreshAccountState();
            if (this.currentUser?.role !== 'admin' && document.getElementById('view-admin')?.classList.contains('active')) {
                this.loadView('accueil');
            }
        },

        renderSpotifyConnectPanel(spotifyConnected) {
            if (!this.spotifyConnectPanel) return;

            this.spotifyConnectPanel.classList.toggle('is-connected', spotifyConnected);
            this.spotifyConnectPanel.classList.toggle('is-disabled', !this.spotifyOAuthEnabled);

            if (this.spotifyConnectTitle) {
                this.spotifyConnectTitle.innerText = spotifyConnected
                    ? 'Spotify est connecte'
                    : 'Autoriser YouPlayer';
            }
            if (this.spotifyConnectCopy) {
                if (!this.spotifyOAuthEnabled) {
                    this.spotifyConnectCopy.innerText = 'La connexion OAuth Spotify n est pas configuree sur ce serveur.';
                } else if (spotifyConnected) {
                    this.spotifyConnectCopy.innerText = 'Les recherches et les albums utilisent en priorité ce compte. Le mode WebPlayer reste disponible en secours.';
                } else {
                    this.spotifyConnectCopy.innerText = 'Autorise YouPlayer pour que les recherches et les albums passent par ton compte Spotify personnel.';
                }
            }
            if (this.spotifyConnectStatus) {
                this.spotifyConnectStatus.innerText = !this.spotifyOAuthEnabled
                    ? 'Non configure'
                    : spotifyConnected
                        ? 'Connecte'
                        : 'Non connecte';
            }
            if (this.spotifyConnectButton) {
                this.spotifyConnectButton.hidden = !this.spotifyOAuthEnabled || spotifyConnected;
            }
            if (this.spotifyDisconnectButton) {
                this.spotifyDisconnectButton.hidden = !spotifyConnected;
            }
        },

        showAuth(message = '') {
            this.playlistLoadRevision++;
            this.playlistTracks = [];
            this.clearTrackPageScrolling(this.playlistContainer);
            this.playlistContainer?.replaceChildren();
            this.likedKeys = new Set();
            this.likesRevision++;
            if (!this.authEnabled) return;
            this.sleepTimer?.cancel();
            this.libraryPreferences = { pinned: [], recent: [] };
            this.availablePlaylists = [];
            this.draftPlaylists = null;
            this.renderLibrary();
            document.body.classList.add('auth-required');
            if (this.authScreen) this.authScreen.hidden = false;
            this.renderAuthState();
            if (this.loginError) {
                this.loginError.innerText = message;
                this.loginError.style.display = message ? 'block' : 'none';
            }
        },

        showApp() {
            document.body.classList.remove('auth-required');
            if (this.authScreen) this.authScreen.hidden = true;
            this.renderAuthState();
            if (this.currentUser?.role !== 'admin') void this.refreshLikes();
        },

        async refreshAuthProviders() {
            try {
                const response = await fetchImpl(`${API_URL}/auth/providers`, { credentials: 'include' });
                if (!response.ok) return;
                const data = await response.json();
                this.spotifyOAuthEnabled = data.spotify?.enabled === true;
                this.renderAuthState();
            } catch (err) {
                console.error('Erreur providers auth:', err);
            }
        },

        async refreshAuth() {
            try {
                const response = await fetchImpl(`${API_URL}/auth/me`, { credentials: 'include' });
                if (!response.ok) {
                    this.currentUser = null;
                    this.showAuth();
                    return false;
                }
                const data = await response.json();
                this.authEnabled = data.authEnabled !== false;
                this.currentUser = data.user || null;
                this.showApp();
                return true;
            } catch (err) {
                console.error('Erreur session:', err);
                this.showAuth('Session impossible a charger.');
                return false;
            }
        },

        async handleLogin(e) {
            e.preventDefault();
            if (this.loginError) this.loginError.style.display = 'none';

            try {
                const response = await fetchImpl(`${API_URL}/auth/login`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pseudo: this.loginPseudo?.value || '',
                        password: this.loginPassword.value
                    })
                });

                if (!response.ok) {
                    this.showAuth(response.status === 401 ? 'Identifiants invalides.' : publicErrorMessage(response.status));
                    return;
                }

                const data = await response.json();
                this.currentUser = data.user;
                this.loginPassword.value = '';
                this.showApp();
                this.loadView(this.currentUser?.role === 'admin' ? 'admin' : 'accueil');
            } catch {
                this.showAuth('Connexion indisponible. Vérifie ta connexion puis réessaie.');
            }
        },

        connectSpotify() {
            if (this.currentUser?.role === 'admin') return;
            window.location.href = `${API_URL}/auth/spotify/start`;
        },

        async disconnectSpotify() {
            const result = await this.apiFetch('/auth/spotify/disconnect', 'POST', {});
            if (!result) return;
            this.currentUser = result.user;
            this.renderAuthState();
            this.showNotice('Compte Spotify deconnecte.');
        },

        handleSpotifyRedirectNotice() {
            const params = new URLSearchParams(window.location.search);
            const connected = params.get('spotify_connected');
            const error = params.get('spotify_error');
            const view = params.get('view');
            if (!connected && !error) return view;
            if (connected) {
                this.showNotice('OAuth Spotify connecte, mais les playlists personnelles utilisent l extension Firefox.');
            } else if (error === 'reauth_required') {
                this.showNotice('Reconnecte-toi a YouPlayer avant de remplacer le compte Spotify.', true);
            } else {
                this.showNotice('OAuth Spotify indisponible. Utilise la connexion WebPlayer affichee dans l onglet Spotify.', true);
            }
            params.delete('spotify_connected');
            params.delete('spotify_error');
            params.delete('view');
            const query = params.toString();
            const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
            window.history.replaceState({}, document.title, nextUrl);
            return view === 'add_spotify' ? 'add_spotify' : null;
        },

        async logout() {
            this.playlistLoadRevision++;
            this.playlistTracks = [];
            this.playlistContainer?.replaceChildren();
            this.sleepTimer?.cancel();
            this.libraryPreferences = { pinned: [], recent: [] };
            this.availablePlaylists = [];
            this.draftPlaylists = null;
            this.renderLibrary();
            await this.stopSpecialPlayback('logout');
            await fetchImpl(`${API_URL}/auth/logout`, {
                method: 'POST',
                credentials: 'include'
            }).catch(() => {});
            this.currentUser = null;
            this.selectedPlaylists = [];
            this.pendingPrefetchedTransitions = [];
            this.clearNextTrackPrefetch();
            this.renderUpcomingQueue([]);
            this.pauseAudioWithDiagnostics(this.lecteur, 'logout');
            this.lecteur?.removeAttribute('src');
            if (this.playerBar) this.playerBar.classList.remove('visible');
            this.closeNowPlaying();
            this.showAuth();
        },

        async createAdminUser(e) {
            e.preventDefault();
            const form = e.currentTarget;
            const formData = new FormData(form);
            const result = await this.apiFetch('/admin/users', 'POST', {
                pseudo: formData.get('pseudo'),
                password: formData.get('password'),
                role: formData.get('role')
            });
            if (!result) {
                this.showNotice(this.apiErrorMessage("Creation impossible."));
                return;
            }
            form.reset();
            await this.fetchAdminData();
        },

        showPasswordChangeMessage(message, isError = false) {
            if (!this.passwordChangeMessage) return;
            this.passwordChangeMessage.innerText = message;
            this.passwordChangeMessage.classList.toggle('error-msg', isError);
            this.passwordChangeMessage.classList.toggle('success-msg', !isError);
            this.passwordChangeMessage.hidden = false;
        },

        async changeOwnPassword(e) {
            e.preventDefault();
            const form = e.currentTarget;
            const formData = new FormData(form);
            const currentPassword = String(formData.get('currentPassword') || '');
            const newPassword = String(formData.get('newPassword') || '');
            const confirmPassword = String(formData.get('confirmPassword') || '');

            if (newPassword !== confirmPassword) {
                this.showPasswordChangeMessage('Les nouveaux mots de passe ne correspondent pas.', true);
                return;
            }

            const result = await this.apiFetch('/auth/password', 'POST', {
                currentPassword,
                newPassword
            });

            if (!result) {
                this.showPasswordChangeMessage('Mot de passe impossible a modifier.', true);
                return;
            }

            form.reset();
            this.showPasswordChangeMessage('Mot de passe modifie.');
        },

            renderAdminList(container, items, formatter) {
                if (!container) return;
                const safeItems = Array.isArray(items) ? items : [];
            if (safeItems.length === 0) {
                container.innerHTML = '<p class="muted">Aucune donnee.</p>';
                return;
            }
            container.innerHTML = `
                <ul class="admin-list">
                    ${safeItems.map((item) => `<li>${formatter(item)}</li>`).join('')}
                </ul>
                `;
            },

            renderAdminUsers(users) {
                if (!this.adminUsers) return;
                const safeUsers = Array.isArray(users) ? users : [];
                if (safeUsers.length === 0) {
                    this.adminUsers.innerHTML = '<p class="muted">Aucune donnee.</p>';
                    return;
                }

                this.adminUsers.innerHTML = `
                    <ul class="admin-list admin-users-list">
                        ${safeUsers.map((user) => `
                            <li class="admin-user-row">
                                <div class="admin-user-main">
                                    <span>${this.escapeHtml(user.pseudo)}</span>
                                    <strong>${this.escapeHtml(user.role)}</strong>
                                </div>
                                <form class="admin-password-reset" data-user-id="${this.escapeHtml(user.id)}">
                                    <input type="password" name="newPassword" minlength="8" placeholder="nouveau mot de passe" autocomplete="new-password" required>
                                    <button type="submit" class="btn-small">Modifier</button>
                                </form>
                            </li>
                        `).join('')}
                    </ul>
                `;

                this.adminUsers.querySelectorAll('.admin-password-reset').forEach((form) => {
                    form.addEventListener('submit', (event) => this.resetAdminUserPassword(event));
                });
            },

            async resetAdminUserPassword(e) {
                e.preventDefault();
                const form = e.currentTarget;
                const userId = form.dataset.userId;
                const formData = new FormData(form);
                const newPassword = String(formData.get('newPassword') || '');
                const result = await this.apiFetch(`/admin/users/${encodeURIComponent(userId)}/password`, 'POST', {
                    newPassword
                });
                if (!result) {
                    this.showNotice(this.apiErrorMessage("Mot de passe impossible a modifier."));
                    return;
                }
                form.reset();
            },

            async fetchAdminData() {
                if (this.currentUser?.role !== 'admin') return;
            if (this.adminUpdateStatus) await this.fetchUpdateStatus();

            const [users, events, logs, integrations] = await Promise.all([
                this.apiFetch('/admin/users'),
                this.apiFetch('/admin/login_events'),
                this.apiFetch('/admin/audit_logs'),
                this.apiFetch('/admin/integrations')
            ]);

            this.renderIntegrationStatus(integrations);

                this.renderAdminUsers(users);
            this.renderAdminList(this.adminLoginEvents, events, (event) => `
                <span>${this.escapeHtml(event.pseudo)}</span>
                <strong>${event.success ? 'OK' : 'KO'}</strong>
            `);
            this.renderAdminList(this.adminAuditLogs, logs, (log) => `
                <span>${this.escapeHtml(log.action)}</span>
                <strong>${this.escapeHtml(log.resourceType || '')}</strong>
            `);
            },

        renderIntegrationStatus(data) {
            const labels = {
                not_configured: 'Non configurée', not_checked: 'Non vérifiée', checking: 'Vérification…',
                connected: 'Accessible', rejected: 'Accès refusé', unavailable: 'Indisponible',
                timeout: 'Délai dépassé', quota_exceeded: 'Quota dépassé', rate_limited: 'Trop de requêtes',
                invalid_response: 'Réponse invalide'
            };
            for (const [name, id] of [['youtube', 'admin-youtube-status'], ['spotifyPublic', 'admin-spotify-status'], ['spotifyOAuth', 'admin-spotify-oauth-status']]) {
                const element = document.getElementById(id);
                if (!element) continue;
                const state = data?.connections?.[name]?.state;
                const knownState = Object.hasOwn(labels, state);
                element.textContent = knownState ? labels[state] : 'État indisponible';
                element.dataset.state = knownState ? state : 'unavailable';
            }
            const lastCheck = document.getElementById('admin-integrations-last-check');
            if (lastCheck) {
                const date = data?.checkedAt ? new Date(data.checkedAt) : null;
                lastCheck.textContent = date && Number.isFinite(date.getTime())
                    ? `Dernière vérification : ${date.toLocaleString('fr-FR')}` : 'Aucune vérification effectuée.';
            }
        },

        async checkIntegrations() {
            if (this.currentUser?.role !== 'admin' || this.integrationsChecking) return;
            const userId = this.currentUser.id;
            this.integrationsChecking = true;
            if (this.adminIntegrationCheck) this.adminIntegrationCheck.disabled = true;
            const lastCheck = document.getElementById('admin-integrations-last-check');
            if (lastCheck) lastCheck.textContent = 'Vérification en cours…';
            try {
                const response = await fetchImpl(`${API_URL}/admin/integrations/check`, {
                    method: 'POST', credentials: 'include', signal: AbortSignal.timeout(12_000)
                });
                if (this.currentUser?.id !== userId || this.currentUser?.role !== 'admin') return;
                if (response.status === 401) { this.currentUser = null; this.showAuth(); return; }
                if (!response.ok) {
                    if (lastCheck) lastCheck.textContent = response.status === 429
                        ? 'Attends quelques instants avant de vérifier à nouveau.' : 'Vérification indisponible. Réessaie plus tard.';
                    return;
                }
                const data = await response.json();
                if (this.currentUser?.id === userId && this.currentUser?.role === 'admin') this.renderIntegrationStatus(data);
            } catch {
                if (this.currentUser?.id === userId && lastCheck) lastCheck.textContent = 'Vérification indisponible. Réessaie plus tard.';
            } finally {
                this.integrationsChecking = false;
                if (this.adminIntegrationCheck) this.adminIntegrationCheck.disabled = false;
            }
        },

        async fetchUpdateStatus() {
            clearTimeout(this.updatePollTimer);
            if (this.currentUser?.role !== 'admin' || !this.adminUpdateStatus) return;
            let keepPolling = false;
            try {
                const response = await fetchImpl(`${API_URL}/admin/updates`, { credentials: 'include', signal: AbortSignal.timeout(5000) });
                if (response.status === 401 || response.status === 403) {
                    this.adminUpdateCheck.disabled = this.adminUpdateInstall.disabled = true;
                    this.updateRequestId = null;
                    return;
                }
                if (!response.ok) throw new Error('Update service unavailable');
                const status = await response.json();
                const pending = this.updateRequestId && this.updateRequestId !== status.requestId;
                const busy = ['checking', 'downloading', 'backing_up', 'restarting', 'rolling_back'].includes(status.phase);
                const labels = {
                    idle: status.updateAvailable ? 'Une nouvelle version est disponible.' : 'Aucune mise à jour détectée.',
                    checking: 'Recherche de la nouvelle version…', downloading: `Téléchargement : ${status.progress || 0} %`,
                    backing_up: 'Sauvegarde des données…', restarting: 'Installation et redémarrage…',
                    rolling_back: 'Retour à la version précédente…', succeeded: 'Mise à jour terminée.',
                    failed: status.rolledBack ? 'Installation échouée. La version précédente a été rétablie.' : 'Opération échouée. Vérifie le service de mise à jour.'
                };
                this.adminUpdateStatus.textContent = !status.enabled ? 'Les mises à jour ne sont pas encore configurées.'
                    : !status.online ? 'Le service de mise à jour est arrêté.'
                        : pending ? 'Demande en attente…' : labels[status.phase] || 'Vérification…';
                this.adminUpdateVersions.textContent = [status.currentVersion && `Version actuelle : ${status.currentVersion}`,
                    status.latestVersion && `Dernière release : ${status.latestVersion}`].filter(Boolean).join(' · ');
                this.adminUpdateCheck.disabled = !status.enabled || !status.online || busy || Boolean(pending);
                this.adminUpdateInstall.disabled = this.adminUpdateCheck.disabled || !status.updateAvailable;
                this.updateLatestVersion = status.latestVersion;
                keepPolling = Boolean(pending || busy);
                if (!pending && status.requestId === this.updateRequestId && !busy) {
                    const reload = this.updateReloadRequested && status.phase === 'succeeded';
                    this.updateRequestId = null;
                    this.updateReloadRequested = false;
                    if (reload) window.location.reload();
                }
            } catch {
                this.adminUpdateStatus.textContent = 'Application momentanément indisponible. Reconnexion en cours…';
                this.adminUpdateCheck.disabled = this.adminUpdateInstall.disabled = true;
                keepPolling = Boolean(this.updateRequestId);
                if (keepPolling && !this.updatePollUntil) this.updatePollUntil = Date.now() + 20 * 60_000;
            }
            if (keepPolling && Date.now() < (this.updatePollUntil || Infinity)) {
                this.updatePollTimer = setTimeout(() => this.fetchUpdateStatus(), 2000);
            }
        },

        async startAppUpdate(action) {
            if (this.currentUser?.role !== 'admin' || !['check', 'install'].includes(action)) return;
            this.adminUpdateCheck.disabled = this.adminUpdateInstall.disabled = true;
            try {
                const response = await fetchImpl(`${API_URL}/admin/updates/${action}`, {
                    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(action === 'install' ? { version: this.updateLatestVersion } : {}),
                    signal: AbortSignal.timeout(5000)
                });
                if (!response.ok) throw new Error('Update request rejected');
                const result = await response.json();
                this.updateRequestId = result.requestId;
                this.updateReloadRequested = action === 'install';
                this.updatePollUntil = Date.now() + 20 * 60_000;
            } catch {
                this.showNotice('Impossible de lancer cette opération. Réessaie dans un instant.', true);
            }
            await this.fetchUpdateStatus();
        },

    };
}
