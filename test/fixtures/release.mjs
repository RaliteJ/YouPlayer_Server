import { generateKeyPairSync, sign } from 'node:crypto';
import { imageRepository } from '../../scripts/release-channel.mjs';

export const keys = generateKeyPairSync('ed25519');
export const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
export const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
export function manifest(version = 'v1.0.0', sequence = 1) {
  return { schema: 3, contract: 1, dataVersion: 1, rollbackCompatible: true, version, sequence,
    commit: 'a'.repeat(40), platforms: Object.fromEntries(['linux/amd64', 'linux/arm64'].map(platform => [platform,
      Object.fromEntries(['backend', 'frontend'].map(service => [service, `${imageRepository(service)}@sha256:${String(sequence).repeat(64)}`]))])) };
}
export function envelope(value = manifest()) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { payload: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') };
}
