import path from 'node:path';

export const installationEnvironment = 'COMPOSE_PROJECT_NAME=youplayer-server\nYOUPLAYER_SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n';
export function installationContainers(root, images, { healthField = 'Health' } = {}) {
  const project = 'youplayer-server';
  const volume = (v, destination) => ({ Type: 'volume', Name: `${project}_${v}`, Destination: destination });
  const bind = (p, destination) => ({ Type: 'bind', Source: path.join(root, p), Destination: destination });
  return ['backend', 'frontend', 'redis'].map((s, index) => ({
    Id: String(index + 5).repeat(64), Name: `${project}_${s}_1`, Image: `sha256:${images[s] || 'e'.repeat(64)}`,
    State: { Status: 'running', [healthField]: { Status: 'healthy' } },
    Config: { Labels: { 'io.podman.compose.project': project, 'com.docker.compose.service': s },
      Healthcheck: { Test: ['CMD', 'node', 'health.js'] } },
    Mounts: s === 'backend' ? [volume('youplayer_data', '/var/lib/youplayer'), bind('src/playlists', '/var/www/html/playlists'),
      bind('src/local_song', '/var/www/html/local_song'), bind('.updates/requests', '/var/lib/youplayer-updates/requests'),
      bind('.updates/status', '/var/lib/youplayer-updates/status')]
      : s === 'redis' ? [volume('redis_data', '/data')] : [volume('frontend_certs', '/etc/nginx/certs')],
    NetworkSettings: { Networks: Object.fromEntries((s === 'backend' ? ['private', 'sessions'] : [s === 'redis' ? 'sessions' : 'private'])
      .map(n => [`${project}_${n}`, {}])) },
    HostConfig: { PortBindings: s === 'frontend' ? { '443/tcp': [{ HostPort: '8443' }] } : {} }
  }));
}

export function installationCompose() {
  const app = s => ({ image: `localhost/youplayer-server-${s}:latest`, pull_policy: 'never', restart: 'unless-stopped',
    depends_on: { [s === 'backend' ? 'redis' : 'backend']: { condition: 'service_healthy' } },
    healthcheck: { test: ['CMD', 'node', 'health.js'], interval: '30s', timeout: '5s', start_period: '20s', retries: 3 },
    networks: s === 'backend' ? ['private', 'sessions'] : ['private'],
    volumes: s === 'backend' ? ['./src/playlists:/var/www/html/playlists:Z', './src/local_song:/var/www/html/local_song:Z',
      'youplayer_data:/var/lib/youplayer:Z,U', './.updates/requests:/var/lib/youplayer-updates/requests:Z',
      './.updates/status:/var/lib/youplayer-updates/status:ro,Z'] : ['frontend_certs:/etc/nginx/certs:Z'],
    ...(s === 'backend' ? { environment: { NODE_ENV: 'production', YOUPLAYER_SESSION_SECRET: 'synthetic-private' },
      init: true, userns_mode: 'keep-id:uid=1000,gid=1000', security_opt: ['no-new-privileges:true'] } : { ports: ['8443:443'] }) });
  return { services: { backend: app('backend'), frontend: app('frontend'), redis: {} },
    networks: { private: { driver: 'bridge' }, sessions: { driver: 'bridge', internal: true } },
    volumes: { youplayer_data: {}, redis_data: {}, frontend_certs: {} }, 'x-podman': { in_pod: false } };
}

export function simulatedDeployment(root, images) {
  let all = installationContainers(root, images);
  let sequence = 100;
  const calls = [];
  const engine = {
    get all() { return all; }, set all(value) { all = value; }, calls,
    async run(program, args) {
      calls.push([program, args]);
      if (program === 'python3') return JSON.stringify(installationCompose());
      if (args[0] === 'ps') return all.map(c => c.Id).join('\n');
      if (args[0] === 'inspect') return JSON.stringify(all.filter(c => args.slice(1).includes(c.Id) || args.slice(1).includes(c.Name)));
      if (args[0] === 'create') {
        const s = args[args.indexOf('--name') + 1].includes('_backend_') ? 'backend' : 'frontend';
        const c = structuredClone(installationContainers(root, images).find(c => c.Name === `youplayer-server_${s}_1`));
        c.Id = (++sequence).toString(16).padStart(64, '0');
        c.Name = args[args.indexOf('--name') + 1]; c.Image = args.at(-1);
        c.State = { Running: false, Status: 'created' };
        for (let i = 0; i < args.length; i++) if (args[i] === '--label') {
          const [key, ...value] = args[++i].split('='); c.Config.Labels[key] = value.join('=');
        }
        all.push(c); return c.Id;
      }
      const c = all.find(c => c.Id === args.at(-1) || c.Name === args.at(-1) || c.Id === args[1]);
      if (args[0] === 'rm') all = all.filter(item => item !== c);
      if (args[0] === 'rename') c.Name = args[2];
      if (args[0] === 'start') c.State = { Running: true, Status: 'running', Health: { Status: 'healthy' } };
      if (args[0] === 'stop') c.State = { Running: false, Status: 'exited' };
      return '';
    }
  };
  return engine;
}
