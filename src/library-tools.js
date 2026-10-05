const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');

export function orderLibrary(playlists, { query = '', sort = 'name', pinned = [], recent = [] } = {}) {
	const needles = fold(query).trim().split(/\s+/).filter(Boolean);
	const rank = (names, name) => names.includes(name) ? names.indexOf(name) : Number.MAX_SAFE_INTEGER;
	return playlists.filter((playlist) => needles.every((word) => fold(playlist.title || playlist.name).includes(word)))
		.slice().sort((a, b) => {
			const pinOrder = Number(pinned.includes(b.name)) - Number(pinned.includes(a.name));
			if (pinOrder) return pinOrder;
			if (sort === 'recent') {
				const delta = rank(recent, a.name) - rank(recent, b.name);
				if (delta) return delta;
			}
			if (sort === 'count' && (b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
			return String(a.title || a.name).localeCompare(String(b.title || b.name), 'fr', { numeric: true, sensitivity: 'base' });
		});
}

export function rediscoverPlaylist(playlists, recent = [], random = Math.random) {
	const playable = playlists.filter((playlist) => playlist.count !== 0);
	const forgotten = playable.filter((playlist) => !recent.includes(playlist.name));
	const pool = forgotten.length ? forgotten : playable;
	return pool.length ? pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] : null;
}

// A user-requested wall-clock pause only; never detects track end or changes queue.
export class SleepTimer {
	constructor({ onExpire, onChange = () => {}, now = Date.now,
		schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
		unschedule = (timer) => globalThis.clearTimeout(timer) }) {
		Object.assign(this, { onExpire, onChange, now, schedule, unschedule });
		this.deadline = null;
		this.expired = false;
		this.timer = null;
	}

	set(minutes) {
		if (![0, 15, 30, 60, 90].includes(minutes)) throw new Error('Durée invalide');
		this.cancel();
		if (!minutes) return;
		this.deadline = this.now() + minutes * 60_000;
		this.timer = this.schedule(() => this.check(), minutes * 60_000);
		this.onChange();
	}

	check() {
		if (this.deadline !== null && this.now() >= this.deadline) {
			this.unschedule(this.timer);
			this.timer = null;
			this.deadline = null;
			this.expired = true;
			this.onExpire();
			this.onChange();
		}
		return this.expired;
	}

	resume() {
		if (this.deadline !== null && this.now() >= this.deadline) {
			this.unschedule(this.timer);
			this.timer = null;
			this.deadline = null;
		}
		this.expired = false;
		this.onChange();
	}

	cancel() {
		this.unschedule(this.timer);
		this.timer = null;
		this.deadline = null;
		this.expired = false;
		this.onChange();
	}
}
