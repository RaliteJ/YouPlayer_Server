export function createHttpSecurity(config) {
	function corsOrigin(origin, callback) {
		if (!origin || config.corsOrigins.length === 0) {
			callback(null, config.isProduction ? false : true);
			return;
		}
		callback(null, config.corsOrigins.includes(origin));
	}

	function sameOrigin(req, origin) {
		try {
			const originUrl = new URL(origin);
			return originUrl.host === req.get("host");
		} catch {
			return false;
		}
	}

	function requestWriteOrigin(req) {
		const origin = req.get("origin");
		if (origin) {
			return origin;
		}

		const referer = req.get("referer");
		if (!referer) {
			return "";
		}

		try {
			return new URL(referer).origin;
		} catch {
			return "";
		}
	}

	function requireTrustedOrigin(req, res, next) {
		if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
			return next();
		}

		const origin = requestWriteOrigin(req);
		if (!origin && !config.requireOriginForWrites) {
			return next();
		}
		if (origin && (sameOrigin(req, origin) || config.corsOrigins.includes(origin))) {
			return next();
		}
		return res.status(403).json({ error: "Origine non autorisee" });
	}

	function securityHeaders(_req, res, next) {
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Referrer-Policy", "same-origin");
		res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'"
		);
		next();
	}

	return { corsOrigin, requireTrustedOrigin, securityHeaders };
}
