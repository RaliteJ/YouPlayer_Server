import test from 'node:test';
import assert from 'node:assert/strict';
import { containerPlans } from '../../scripts/update-container-plan.mjs';
import { installationCompose } from '../fixtures/update-deployment.mjs';

const options = { root: '/tmp/synthetic-install', project: 'youplayer-server' };
test('container plan keeps secrets out of arguments and preserves isolation, healthcheck and DNS', () => {
  const plans = containerPlans(installationCompose(), options);
  assert.ok(plans.backend.environment.includes('YOUPLAYER_SESSION_SECRET=synthetic-private'));
  assert.equal(JSON.stringify(plans.backend.args).includes('synthetic-private'), false);
  for (const flag of ['--pull=never', '--init', '--userns', '--security-opt', '--health-cmd']) assert.ok(plans.backend.args.includes(flag));
  assert.ok(plans.backend.args.includes('youplayer-server_sessions:alias=backend'));
  assert.ok(plans.backend.args.includes('/tmp/synthetic-install/.updates/status:/var/lib/youplayer-updates/status:ro,Z'));
});

for (const [reason, mutate] of [
  ['privileged option', c => { c.services.backend.privileged = true; }],
  ['missing network', c => { delete c.networks.sessions; }],
  ['public session network', c => { c.networks.sessions.internal = false; }],
  ['extra mount', c => { c.services.backend.volumes.push('/:/host'); }],
  ['unrecognized dependency condition', c => { c.services.frontend.depends_on.backend.condition = 'service_started'; }],
  ['pod sharing', c => { c['x-podman'].in_pod = true; }],
  ['inherited environment', c => { c.services.backend.environment = ['YOUPLAYER_SESSION_SECRET']; }],
  ['multiline environment', c => { c.services.backend.environment.YOUPLAYER_SESSION_SECRET = 'synthetic-private\nINJECTED=value'; }],
  ['unexpected port', c => { c.services.frontend.ports = ['443:443']; }]
]) test(`unsupported ${reason} fails closed before any deployment`, () => {
  const config = installationCompose(); mutate(config);
  assert.throws(() => containerPlans(config, options), error => error.updateCode === 'environment-invalid' && !error.message.includes('synthetic-private'));
});
