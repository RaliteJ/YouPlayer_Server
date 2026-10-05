export class DownloadQueue {
	constructor({ concurrency = 2 } = {}) {
		this.concurrency = Math.max(1, Number(concurrency) || 1);
		this.active = 0;
		this.pending = [];
	}

	enqueue(task) {
		return new Promise((resolve, reject) => {
			this.pending.push({ task, resolve, reject });
			this.drain();
		});
	}

	drain() {
		while (this.active < this.concurrency && this.pending.length > 0) {
			const job = this.pending.shift();
			this.active += 1;
			Promise.resolve()
				.then(job.task)
				.then(job.resolve, job.reject)
				.finally(() => {
					this.active -= 1;
					this.drain();
				});
		}
	}

	stats() {
		return {
			active: this.active,
			pending: this.pending.length,
			concurrency: this.concurrency
		};
	}
}

export const downloadQueue = new DownloadQueue({
	concurrency: Number(process.env.YOUPLAYER_DOWNLOAD_CONCURRENCY) || 2
});
