import { trackLikeKey } from './client-utils.js';

export function parseLrc(value = '') {
    const lines = [];
    // An offset embedded in a file is not a verified alignment for the played video.
    if (/\[offset\s*:/i.test(value)) return lines;
    for (const line of value.split(/\r?\n/).slice(0, 2000)) {
        const stamps = [...line.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
        const text = line.replace(/\[[^\]]*\]/g, '').trim();
        for (const stamp of stamps) lines.push({
            time: Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] || 0}`), text
        });
    }
    return lines.sort((a, b) => a.time - b.time);
}

export function lyricsCanSync(data, duration) {
    if (data?.source === 'lyrics.ovh') return false;
    if (data?.source === 'YouTube' && data.sameSource === true) return true;
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
        const key = trackLikeKey(this.playerState.currentTrack);
        this.lyricsStatus.textContent = 'Recherche des paroles et sous-titres…';
        const duration = this.playerState.duration || 0;
        let data;
        try { data = await this.apiFetch(`/lyrics?trackId=${this.currentId}&key=${encodeURIComponent(key)}&duration=${duration}`); } catch {}
        if (this.lyricsRequest !== request || this.currentUser?.id !== user) return;
        this.lyricsRequest = null;
        if (!data?.available || data.key !== key) {
            this.lyricsStatus.textContent = 'Paroles indisponibles pour le moment. Réessaie plus tard.';
            return;
        }
        this.lyricsData = data;
        this.lyricsLines = Array.isArray(data.timedLines)
            ? data.timedLines.slice(0, 2000).filter(line => Number.isFinite(line.time) && line.time >= 0 && typeof line.text === 'string')
            : parseLrc(data.syncedLyrics || '');
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
        const provider = data.source === 'YouTube' ? data.automatic ? 'Sous-titres automatiques YouTube : la transcription peut contenir des erreurs.' : 'Sous-titres YouTube de la vidéo lue.' : '';
        this.lyricsStatus.textContent = !data.found ? 'Aucune parole trouvée pour ce morceau.'
            : data.instrumental ? 'Ce morceau est instrumental.'
            : data.source === 'lyrics.ovh' ? 'Paroles en texte seul · lyrics.ovh. Cette source ne fournit pas de synchronisation.'
            : provider ? `${provider}${synced ? ' Suivi synchronisé.' : ' Texte seul.'}`
            : synced ? 'Paroles synchronisées · LRCLIB. Ajuste le décalage si nécessaire.'
            : 'Paroles en texte seul · LRCLIB. La synchronisation est désactivée pour cette version.';
        this.lyricsContent.replaceChildren();
        const source = this.lyricsSource;
        if (source) {
            source.hidden = !data.found;
            source.textContent = `Source : ${['YouTube', 'lyrics.ovh'].includes(data.source) ? data.source : 'LRCLIB'}`;
            source.href = /^https:\/\/lrclib\.net(?:\/|$)/.test(data.sourceUrl || '') || /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(data.sourceUrl || '')
                || /^https:\/\/api\.lyrics\.ovh\/v1\/[^/]+\/[^/]+$/.test(data.sourceUrl || '') ? data.sourceUrl : 'https://lrclib.net';
        }
        if (synced) {
            for (const line of this.lyricsLines) {
                const element = document.createElement('p');
                element.textContent = line.text || ' ';
                this.lyricsContent.append(element);
            }
        } else {
            this.lyricsContent.textContent = data.plainLyrics || this.lyricsLines.map(line => line.text).join('\n') || (data.syncedLyrics || '').replace(/\[[^\]]*\]/g, '').trim()
                || (data.found && !data.instrumental ? 'Le texte des paroles n’est pas disponible.' : '');
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
