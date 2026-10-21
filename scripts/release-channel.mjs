import { createPublicKey, verify } from 'node:crypto';

export const REPOSITORY = 'RaliteJ/YouPlayer_Server';
export const SERVICES = ['backend', 'frontend'];
export const PLATFORMS = ['linux/amd64', 'linux/arm64'];
export const imageRepository = service => `ghcr.io/ralitej/youplayer-server-${service}`;
export const validVersion = value => typeof value === 'string' && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export const releaseError = code => Object.assign(new Error(code), { updateCode: code });

export function compareVersions(next, current) {
  if (!validVersion(next) || !validVersion(current)) throw releaseError('invalid-release');
  const a = next.slice(1).split('.').map(BigInt), b = current.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function validateManifest(value) {
  // Contract 1 only supports releases that preserve the current data format.
  if (value?.schema !== 3 || value.contract !== 1 || value.dataVersion !== 1
    || value.rollbackCompatible !== true || !validVersion(value.version)
    || !/^[a-f0-9]{40}$/.test(value.commit || '')
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || Object.keys(value.platforms || {}).sort().join() !== [...PLATFORMS].sort().join()) throw releaseError('incompatible-release');
  for (const platform of PLATFORMS) {
    const images = value.platforms[platform];
    if (Object.keys(images || {}).sort().join() !== 'backend,frontend') throw releaseError('invalid-release');
    for (const service of SERVICES) {
      const reference = images[service];
      if (typeof reference !== 'string' || reference.split('@')[0] !== imageRepository(service)
        || !/@sha256:[a-f0-9]{64}$/.test(reference)) throw releaseError('invalid-release');
    }
  }
  return value;
}

export function verifyManifest(envelope, publicKey) {
  if (typeof envelope?.payload !== 'string' || envelope.payload.length > 32_000
    || typeof envelope.signature !== 'string' || envelope.signature.length > 100) throw releaseError('invalid-signature');
  const bytes = Buffer.from(envelope.payload, 'base64');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'))) {
    throw releaseError('invalid-signature');
  }
  return validateManifest(JSON.parse(bytes.toString('utf8')));
}

export function createReleaseSource({ publicKey, fetchImpl = fetch } = {}) {
  const origins = new Set(['https://api.github.com', 'https://github.com',
    'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);
  async function json(url, asset = false) {
    const signal = AbortSignal.timeout(30_000);
    for (let redirects = 0; redirects <= 4; redirects++) {
      const target = new URL(url);
      if (!origins.has(target.origin) || target.username || target.password) throw releaseError('download-origin');
      const response = await fetchImpl(target, { redirect: 'manual', signal,
        headers: { Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'YouPlayer-Updater' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw releaseError('release-unavailable');
        url = new URL(location, target).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw releaseError(response.status === 404 ? 'no-release' : 'release-unavailable');
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw releaseError('invalid-release');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    throw releaseError('download-origin');
  }
  return {
    async latest() {
      const release = await json(`https://api.github.com/repos/${REPOSITORY}/releases/latest`);
      if (release.draft !== false || release.prerelease !== false || !validVersion(release.tag_name)) throw releaseError('invalid-release');
      const assets = release.assets?.filter(asset => asset.name === 'youplayer-release.json');
      if (assets?.length !== 1 || !/^https:\/\/api\.github\.com\/repos\/RaliteJ\/YouPlayer_Server\/releases\/assets\/\d+$/.test(assets[0].url)) {
        throw releaseError('invalid-release');
      }
      const envelope = await json(assets[0].url, true);
      const manifest = verifyManifest(envelope, publicKey);
      if (manifest.version !== release.tag_name) throw releaseError('invalid-release');
      return { manifest, envelope };
    }
  };
}
