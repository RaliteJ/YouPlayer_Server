const repository = 'RaliteJ/YouPlayer_Server';
const api = `https://api.github.com/repos/${repository}`;

// Only an explicit admin check contacts GitHub; this service never installs code.
export function createReleaseStatus({ commit = process.env.YOUPLAYER_BUILD_COMMIT,
  fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const localCommit = /^[a-f0-9]{40}$/.test(commit || '') ? commit : null;
  let result = { localCommit, state: localCommit ? 'not_checked' : 'local_unknown',
    updateAvailable: null, latestRelease: null, checkedAt: null };
  let pending;
  const snapshot = () => ({ ...result, latestRelease: result.latestRelease && { ...result.latestRelease } });

  async function request(endpoint, missing) {
    const response = await fetchImpl(`${api}${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'YouPlayer-Server', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(8000), redirect: 'error'
    });
    if (!response.ok) throw Object.assign(new Error('Release check failed'), {
      releaseState: response.status === 404 ? missing
        : response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
          ? 'rate_limited' : 'unavailable'
    });
    return response.json();
  }

  async function probe() {
    let latestRelease = null;
    let state;
    try {
      const release = await request('/releases/latest', 'no_release');
      if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string'
        || !release.tag_name || release.tag_name.length > 200 || /[\x00-\x20\x7f]/.test(release.tag_name)) throw new Error('Invalid release');
      const tag = encodeURIComponent(release.tag_name);
      latestRelease = { tag: release.tag_name, url: `https://github.com/${repository}/releases/tag/${tag}` };
      const comparison = await request(`/compare/${localCommit}...${tag}?per_page=1`, 'local_unknown');
      const states = { ahead: 'release_ahead', behind: 'local_ahead', identical: 'up_to_date', diverged: 'diverged' };
      if (!Object.hasOwn(states, comparison.status)) throw new Error('Invalid comparison');
      state = states[comparison.status];
    } catch (error) {
      state = error.releaseState || 'unavailable';
    }
    result = { localCommit, state, latestRelease, checkedAt: new Date(now()).toISOString(),
      updateAvailable: state === 'release_ahead' ? true : ['up_to_date', 'local_ahead'].includes(state) ? false : null };
    return snapshot();
  }

  function check() {
    if (!localCommit) return Promise.resolve(snapshot());
    if (pending) return pending;
    if (result.checkedAt && now() - Date.parse(result.checkedAt) < 300_000) return Promise.resolve(snapshot());
    pending = probe().finally(() => { pending = null; });
    return pending;
  }
  return { snapshot, check };
}

export function registerReleaseRoutes(app, { requireAdmin, status = createReleaseStatus() }) {
  function authenticatedAdmin(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Authentification requise' });
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acces admin requis' });
    next();
  }
  app.get('/admin/releases', requireAdmin, authenticatedAdmin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(status.snapshot());
  });
  app.post('/admin/releases/check', requireAdmin, authenticatedAdmin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await status.check());
  });
}
