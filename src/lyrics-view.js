import { trackLikeKey } from './client-utils.js';
import { spotifyBrowserBridge } from './spotify-browser-bridge.js';

export async function lookupSpotifyLyrics(track, bridge = spotifyBrowserBridge) {
    if (!bridge) return null;
    let url;
    try { url = new URL(track?.url); } catch { return null; }
    const id = url.origin === 'https://open.spotify.com' && /^\/track\/([A-Za-z0-9]{22})$/.exec(url.pathname)?.[1];
    if (!id) return null;
    try {
        if (!(await bridge.status())?.authenticated) return null;
        const data = await bridge.getLyrics(id);
        if (!data?.available || !data.found) return null;
        return { ...data, duration: Number(track.duration_ms) > 0 ? Number(track.duration_ms) / 1000 : null };
    } catch { return null; }
}

export function lyricsCanSync(data, duration) {
    return Number.isFinite(duration) && duration > 0 && Number.isFinite(data?.duration)
        && data.duration > 0 && Math.abs(duration - data.duration) <= 2;
}

export const lyricsView = {
    initLyrics() {
        this.lyricsPanel = document.getElementById('lyrics-panel');
        this.lyricsToggle = document.getElementById('lyrics-toggle');
        this.lyricsStatus = document.getElementById('lyrics-status');
        this.lyricsContent = document.getElementById('lyrics-content');
        this.lyricsSource = document.getElementById('lyrics-source');
        this.lyricsSync = document.getElementById('lyrics-sync');
        this.lyricsOffset = document.getElementById('lyrics-offset');
        this.lyricsToggle?.addEventListener('click', () => {
            this.lyricsPanel.hidden = !this.lyricsPanel.hidden;
            this.lyricsToggle.setAttribute('aria-expanded', String(!this.lyricsPanel.hidden));
            if (!this.lyricsPanel.hidden) void this.loadLyrics();
        });
        document.getElementById('lyrics-retry')?.addEventListener('click', () => { this.lyricsData = null; void this.loadLyrics(); });
        this.lyricsSync?.addEventListener('change', () => this.renderLyrics());
        this.lyricsOffset?.addEventListener('input', () => this.updateLyricsProgress({ force: true, instant: true }));
        if (this.lyricsContent && typeof ResizeObserver !== 'undefined') {
            this.lyricsResizeObserver = new ResizeObserver(() => {
                this.updateLyricsProgress({ force: true, instant: true });
                this.revealLyrics();
            });
            this.lyricsResizeObserver.observe(this.lyricsContent);
        }
    },

    refreshLyricsTrack() {
        const identity = JSON.stringify([this.currentUser?.id, this.currentId, trackLikeKey(this.playerState.currentTrack)]);
        if (this.lyricsIdentity === identity) return;
        this.lyricsIdentity = identity;
        this.lyricsRequest = null;
        this.lyricsData = null;
        this.lyricsLines = [];
        this.lyricsMode = null;
        if (this.lyricsOffset) this.lyricsOffset.value = '0';
        this.lyricsContent?.replaceChildren();
        this.lyricsContent?.classList.remove('is-synced');
        const source = this.lyricsSource;
        if (source) source.hidden = true;
        if (this.lyricsStatus) this.lyricsStatus.textContent = 'Ouvre les paroles pour ce morceau.';
        if (this.lyricsPanel && !this.lyricsPanel.hidden) void this.loadLyrics();
    },

    resetLyrics() {
        this.lyricsRequest = null;
        this.lyricsIdentity = null;
        this.lyricsData = null;
        this.lyricsLines = [];
        this.lyricsContent?.replaceChildren();
        this.lyricsContent?.classList.remove('is-synced');
        const source = this.lyricsSource;
        if (source) source.hidden = true;
        if (this.lyricsPanel) this.lyricsPanel.hidden = true;
        this.lyricsToggle?.setAttribute('aria-expanded', 'false');
    },

    async loadLyrics() {
        if (!this.lyricsContent || this.currentUser?.role === 'admin') return;
        if (!/^\d+$/.test(String(this.currentId)) || !this.playerState.currentTrack) {
            this.lyricsStatus.textContent = 'Lance un morceau pour afficher ses paroles.';
            return;
        }
        if (this.lyricsData) { this.renderLyrics(); return; }
        if (this.lyricsRequest) return;
        const request = this.lyricsRequest = {};
        const user = this.currentUser?.id;
        this.lyricsStatus.textContent = 'Recherche des paroles Spotify…';
        const data = await lookupSpotifyLyrics(this.playerState.currentTrack);
        if (this.lyricsRequest !== request || this.currentUser?.id !== user) return;
        this.lyricsRequest = null;
        if (!data) {
            this.lyricsLines = [];
            this.lyricsContent.replaceChildren();
            this.lyricsContent.classList.remove('is-synced');
            this.lyricsSync.disabled = true;
            this.lyricsOffset.disabled = true;
            if (this.lyricsSource) this.lyricsSource.hidden = true;
            this.lyricsStatus.textContent = 'Aucune parole Spotify disponible. Vérifie que l’extension est connectée à Spotify.';
            return;
        }
        this.lyricsData = data;
        this.lyricsLines = Array.isArray(data.timedLines)
            ? data.timedLines.slice(0, 2000).filter(line => Number.isFinite(line.time) && line.time >= 0 && typeof line.text === 'string') : [];
        this.renderLyrics();
    },

    renderLyrics() {
        if (!this.lyricsData || !this.lyricsContent) return;
        const data = this.lyricsData;
        const canSync = this.lyricsLines.length > 0 && lyricsCanSync(data, this.playerState.duration);
        this.lyricsSync.disabled = !canSync;
        this.lyricsOffset.disabled = !canSync || !this.lyricsSync.checked;
        const synced = canSync && this.lyricsSync.checked;
        this.lyricsMode = synced ? 'synced' : 'plain';
        this.lyricsContent.classList.toggle('is-synced', synced);
        this.lyricsStatus.textContent = synced
            ? 'Paroles synchronisées · Spotify / Musixmatch. Ajuste le décalage si nécessaire.'
            : 'Paroles en texte seul · Spotify / Musixmatch. La synchronisation est désactivée pour cette version.';
        this.lyricsContent.replaceChildren();
        const source = this.lyricsSource;
        if (source) {
            source.hidden = !data.found;
            source.textContent = 'Source : Spotify';
            source.href = /^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]{22}$/.test(data.sourceUrl || '') ? data.sourceUrl : 'https://open.spotify.com';
        }
        if (synced) {
            for (const line of this.lyricsLines) {
                const element = document.createElement('p');
                element.textContent = line.text || ' ';
                this.lyricsContent.append(element);
            }
        } else {
            this.lyricsContent.textContent = data.plainLyrics || this.lyricsLines.map(line => line.text).join('\n')
                || (data.found ? 'Le texte des paroles n’est pas disponible.' : '');
        }
        this.lyricsActiveLine = -1;
        this.lyricsContent.scrollTop = 0;
        this.updateLyricsProgress({ force: true, instant: true });
        this.revealLyrics();
    },

    revealLyrics() {
        if (!this.nowPlayingOpen || this.lyricsPanel?.hidden || !this.lyricsContent?.clientHeight) return;
        const viewport = this.nowPlayingOverlay.getBoundingClientRect();
        const content = this.lyricsContent.getBoundingClientRect();
        if (content.top < viewport.top || content.bottom > viewport.bottom) {
            this.lyricsContent.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
    },

    updateLyricsProgress({ force = false, instant = false } = {}) {
        if (!this.lyricsData || this.lyricsPanel?.hidden) return;
        const mode = this.lyricsLines.length && lyricsCanSync(this.lyricsData, this.playerState.duration) && this.lyricsSync.checked ? 'synced' : 'plain';
        if (this.lyricsMode !== mode) { this.renderLyrics(); return; }
        if (mode !== 'synced') return;
        const offset = Math.max(-60, Math.min(60, Number(this.lyricsOffset.value) || 0));
        const time = this.playerState.currentTime - offset;
        let active = -1;
        for (let index = 0; index < this.lyricsLines.length && this.lyricsLines[index].time <= time; index++) active = index;
        if (active === this.lyricsActiveLine && !force) return;
        const previous = this.lyricsContent.children[this.lyricsActiveLine];
        previous?.classList.remove('is-active');
        previous?.removeAttribute('aria-current');
        this.lyricsActiveLine = active;
        const element = this.lyricsContent.children[active];
        element?.classList.add('is-active');
        element?.setAttribute('aria-current', 'true');
        if (element && this.nowPlayingOpen && this.lyricsContent.clientHeight) {
            const content = this.lyricsContent.getBoundingClientRect();
            const line = element.getBoundingClientRect();
            const top = this.lyricsContent.scrollTop + line.top + line.height / 2
                - content.top - this.lyricsContent.clientTop - this.lyricsContent.clientHeight / 2;
            const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            this.lyricsContent.scrollTo({ top: Math.max(0, top), behavior: instant || reducedMotion ? 'instant' : 'smooth' });
        }
    }
};
