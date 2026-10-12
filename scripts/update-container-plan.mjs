import path from 'node:path';

const invalid = () => { throw Object.assign(new Error('Configuration de deploiement non prise en charge'), { updateCode: 'environment-invalid' }); };
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid();
}
function string(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\n') || value.includes('\r')) invalid();
  return value;
}

// Compose only resolves interpolation. Deployment uses a bounded set of Podman
// create flags, never Compose run/up and never arbitrary shell commands.
export function containerPlans(config, { root, project, port = 8443 }) {
  keys(config, ['name', 'services', 'networks', 'volumes', 'x-podman']);
  keys(config.services, ['backend', 'frontend', 'redis']);
  if (Object.keys(config.services).length !== 3) invalid();
  keys(config.networks, ['private', 'sessions']);
  keys(config.volumes, ['youplayer_data', 'frontend_certs', 'redis_data']);
  if (Object.keys(config.networks).length !== 2 || Object.keys(config.volumes).length !== 3) invalid();
  if (config['x-podman'] && (Object.keys(config['x-podman']).some(k => k !== 'in_pod') || config['x-podman'].in_pod !== false)) invalid();
  for (const [n, v] of Object.entries(config.networks)) {
    keys(v, ['driver', 'internal']);
    if (v.driver !== 'bridge' || Boolean(v.internal) !== (n === 'sessions')) invalid();
  }
  for (const v of Object.values(config.volumes)) keys(v, []);
  const plans = {};
  const expectedVolumes = {
    backend: ['./src/playlists:/var/www/html/playlists:Z', './src/local_song:/var/www/html/local_song:Z',
      'youplayer_data:/var/lib/youplayer:Z,U', './.updates/requests:/var/lib/youplayer-updates/requests:Z',
      './.updates/status:/var/lib/youplayer-updates/status:ro,Z'],
    frontend: ['frontend_certs:/etc/nginx/certs:Z']
  };
  for (const service of ['backend', 'frontend']) {
    const c = config.services[service];
    keys(c, ['image', 'build', 'pull_policy', 'container_name', 'depends_on', 'environment', 'init', 'userns_mode',
      'security_opt', 'volumes', 'networks', 'restart', 'healthcheck', 'ports', 'command', 'entrypoint', 'user',
      'working_dir', 'read_only', 'cap_add', 'cap_drop']);
    if (c.container_name && c.container_name !== `${project}_${service}_1`) invalid();
    if (c.pull_policy !== 'never' || c.restart !== 'unless-stopped') invalid();
    const dependency = service === 'backend' ? 'redis' : 'backend';
    keys(c.depends_on, [dependency]);
    keys(c.depends_on[dependency], ['condition']);
    if (c.depends_on[dependency].condition !== 'service_healthy') invalid();
    const networks = service === 'backend' ? ['private', 'sessions'] : ['private'];
    if (JSON.stringify(c.networks) !== JSON.stringify(networks)) invalid();
    if (!Array.isArray(c.volumes) || JSON.stringify([...c.volumes].sort()) !== JSON.stringify([...expectedVolumes[service]].sort())) invalid();
    if (service === 'frontend') {
      if (!Array.isArray(c.ports) || c.ports.length !== 1 || ![`${port}:443`, `127.0.0.1:${port}:443`].includes(c.ports[0])) invalid();
    } else if (c.ports?.length) invalid();
    const args = ['--pull=never', '--name', `${project}_${service}_1`, '--restart=unless-stopped',
      '--label', `io.podman.compose.project=${project}`, '--label', `com.docker.compose.project=${project}`,
      '--label', `com.docker.compose.service=${service}`, '--label', `com.docker.compose.project.working_dir=${root}`];
    for (const n of networks) args.push('--network', `${project}_${n}:alias=${service}`);
    for (const volume of c.volumes) {
      const [source, ...rest] = volume.split(':');
      args.push('--volume', `${source.startsWith('./') ? path.resolve(root, source) : `${project}_${source}`}:${rest.join(':')}`);
    }
    for (const p of c.ports || []) args.push('--publish', p);
    if (c.init !== undefined) { if (typeof c.init !== 'boolean') invalid(); if (c.init) args.push('--init'); }
    for (const [key, flag] of [['userns_mode', '--userns'], ['user', '--user'], ['working_dir', '--workdir']]) {
      if (c[key] !== undefined) args.push(flag, string(c[key]));
    }
    if (c.read_only !== undefined) { if (typeof c.read_only !== 'boolean') invalid(); if (c.read_only) args.push('--read-only'); }
    for (const [key, flag] of [['security_opt', '--security-opt'], ['cap_add', '--cap-add'], ['cap_drop', '--cap-drop']]) {
      if (c[key] !== undefined && !Array.isArray(c[key])) invalid();
      for (const value of c[key] || []) args.push(flag, string(value));
    }
    const health = c.healthcheck;
    keys(health, ['test', 'interval', 'timeout', 'start_period', 'retries']);
    if (!Array.isArray(health.test) || health.test.length < 2 || !['CMD', 'CMD-SHELL'].includes(health.test[0])) invalid();
    if (health.test[0] === 'CMD-SHELL' && health.test.length !== 2) invalid();
    health.test.forEach(string);
    args.push('--health-cmd', health.test[0] === 'CMD' ? JSON.stringify(health.test.slice(1)) : health.test[1]);
    for (const [key, flag] of [['interval', '--health-interval'], ['timeout', '--health-timeout'], ['start_period', '--health-start-period']]) {
      if (health[key] !== undefined) args.push(flag, string(health[key]));
    }
    if (!Number.isSafeInteger(health.retries) || health.retries < 1) invalid();
    args.push('--health-retries', String(health.retries));
    const env = c.environment || {};
    keys(env, Object.keys(env));
    const environment = Object.entries(env).sort().map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid();
      return `${key}=${value === null ? '' : string(String(value))}`;
    });
    if (c.entrypoint !== undefined) {
      if (!Array.isArray(c.entrypoint)) invalid();
      args.push('--entrypoint', JSON.stringify(c.entrypoint.map(string)));
    }
    if (c.command !== undefined && !Array.isArray(c.command)) invalid();
    plans[service] = { args, environment, command: c.command?.map(string) || [] };
  }
  return plans;
}
