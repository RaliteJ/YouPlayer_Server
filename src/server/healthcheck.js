// Container-local readiness probe; no cookies, secrets or dependency details.
try {
	const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health/ready`, {
		signal: AbortSignal.timeout(4_000), redirect: 'error'
	});
	if (!response.ok || (await response.json()).status !== 'ok') process.exitCode = 1;
} catch { process.exitCode = 1; }
