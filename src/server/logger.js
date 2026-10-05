const LEVELS = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 50
};

function configuredLevel() {
	const raw = String(process.env.YOUPLAYER_LOG_LEVEL || "").toLowerCase();
	if (LEVELS[raw] !== undefined) {
		return raw;
	}
	return process.env.NODE_ENV === "test" ? "silent" : "info";
}

function shouldLog(level) {
	return LEVELS[level] >= LEVELS[configuredLevel()];
}

function write(level, args) {
	if (!shouldLog(level)) return;
	const writer = level === "error"
		? console.error
		: level === "warn"
			? console.warn
			: console.log;
	writer(...args);
}

export const logger = {
	debug: (...args) => write("debug", args),
	info: (...args) => write("info", args),
	warn: (...args) => write("warn", args),
	error: (...args) => write("error", args)
};
