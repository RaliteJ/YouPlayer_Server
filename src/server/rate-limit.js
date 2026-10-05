export function createRateLimit({ windowMs, max, message = "Trop de requetes" }) {
	const hits = new Map();

	return function rateLimit(req, res, next) {
		const now = Date.now();
		const key = req.ip || req.socket?.remoteAddress || "unknown";
		const bucket = hits.get(key);

		if (!bucket || bucket.resetAt <= now) {
			hits.set(key, { count: 1, resetAt: now + windowMs });
			return next();
		}

		bucket.count += 1;
		if (bucket.count > max) {
			res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
			return res.status(429).json({ error: message });
		}

		return next();
	};
}
