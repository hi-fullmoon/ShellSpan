import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Run with node scripts/verify-ai-sftp-location.mjs on a desktop with Docker.
// The desktop app, authentication and SFTP all use production code.
const repository = resolve(import.meta.dirname, '..');
const artifacts = resolve(repository, 'artifacts/tests/ai-sftp-location');
await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(resolve(artifacts, 'routes-'));
const token = randomBytes(12).toString('hex');
const password = randomBytes(24).toString('hex');
const prefix = `shellspan-sftp-${token}`;
const image = 'shellspan-ssh-e2e:local';
const targetHost = 'sftp-target';
const entry = 'src/components/ai/__tests__/ai-sftp-location.native.tsx';
const fileName = '.host:2026';
const docker = (args, input) => execFileSync('docker', args, { encoding: 'utf8', input, timeout: 30_000 }).trim();
const cleanups = [];
let server;
let child;
let output = '';
let paused = false;

function startContainer(name, options, command = []) {
  docker(['run', '--detach', '--rm', '--name', name, ...options, image, ...command]);
  cleanups.push(() => docker(['rm', '--force', name]));
  docker(['exec', '-i', name, 'chpasswd'], `shellspan:${password}\n`);
}

async function gatewayKey(name) {
  for (let attempt = 0; ; attempt++) {
    try {
      return docker(['exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']).split(/\s+/).slice(0, 2).join(' ');
    } catch (error) {
      if (attempt === 39) throw error;
      await delay(250);
    }
  }
}

async function startRoute(label, keyVolume) {
  const network = `${prefix}-${label}`;
  docker(['network', 'create', network]);
  cleanups.push(() => docker(['network', 'rm', network]));
  const target = `${network}-target`;
  const gateway = `${network}-gateway`;
  startContainer(target, ['--network', network, '--network-alias', targetHost, '--hostname', target,
    '--mount', `type=volume,src=${keyVolume},dst=/isolated-key,readonly`],
  ['/usr/sbin/sshd', '-D', '-e', '-h', '/isolated-key/host']);
  const hostname = docker(['exec', target, 'cat', '/etc/hostname']);
  docker(['exec', '--user', 'shellspan', target, 'cp', '/etc/hostname', `/home/shellspan/upload/${fileName}`]);
  startContainer(gateway, ['--network', network, '--publish', '127.0.0.1::22']);
  const port = Number(docker(['port', gateway, '22/tcp']).split(':').pop());
  assert(port > 0, 'Expected a loopback-only jump port');
  return { target, hostname, port, knownHost: `[127.0.0.1]:${port} ${await gatewayKey(gateway)}` };
}

try {
  try { docker(['image', 'inspect', image, '--format', '{{.Id}}']); }
  catch {
    execFileSync('docker', ['build', '-t', image, 'tests/ssh-e2e'], { cwd: repository, stdio: 'inherit' });
  }
  const keyVolume = `${prefix}-key`;
  docker(['volume', 'create', keyVolume]);
  cleanups.push(() => docker(['volume', 'rm', keyVolume]));
  // The identical alias on both isolated networks needs one trusted target key.
  // Generate it inside Docker and expose only the public key to the host.
  const keyOptions = ['run', '--rm', '--network', 'none', '--mount', `type=volume,src=${keyVolume},dst=/isolated-key`, image];
  docker([...keyOptions, 'ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', '/isolated-key/host']);
  const publicKey = docker([...keyOptions, 'cat', '/isolated-key/host.pub']).split(/\s+/).slice(0, 2).join(' ');
  const first = await startRoute('a', keyVolume);
  const second = await startRoute('b', keyVolume);
  assert.notEqual(first.hostname, second.hostname);
  await writeFile(resolve(dataDir, 'known_hosts'), `${targetHost} ${publicKey}\n${first.knownHost}\n${second.knownHost}\n`, { mode: 0o600 });

  const result = Promise.withResolvers();
  server = await createServer({
    root: repository, configFile: false, appType: 'custom', logLevel: 'error',
    resolve: { alias: { '@': resolve(repository, 'src') } },
    optimizeDeps: { entries: [entry] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [react(), tailwindcss(), {
      name: 'native-ai-sftp-location',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url === `/${token}`) {
            response.setHeader('Content-Type', 'text/html');
            response.end(`<!doctype html><meta charset="utf-8"><main id="root"></main><script type="module" src="/${entry}"></script>`);
          } else if (request.url === `/${token}/config`) {
            response.setHeader('Content-Type', 'application/json');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify({ password, targetHost, fileName, routes: [first, second].map(({ port, hostname }) => ({ port, hostname })) }));
          } else if (request.method === 'POST' && request.url === `/${token}/pause`) {
            docker(['pause', first.target]);
            paused = true;
            response.end();
          } else if (request.method === 'POST' && request.url === `/${token}/resume`) {
            docker(['unpause', first.target]);
            paused = false;
            response.end();
          } else if (request.method === 'POST' && request.url === `/${token}/result`) {
            let message = '';
            request.on('data', chunk => { message += chunk; });
            request.on('end', () => { response.end(); result.resolve(message); });
          } else next();
        });
      },
    }],
  });
  cleanups.push(() => { if (paused) docker(['unpause', first.target]); });
  await server.listen();
  const devUrl = `http://127.0.0.1:${server.httpServer.address().port}/${token}`;
  child = spawn('pnpm', ['exec', 'tauri', 'dev', '--no-watch', '--config', JSON.stringify({
    identifier: `com.shellspan-dev.sftp-${token}`,
    build: { beforeDevCommand: '', devUrl },
    app: { windows: [{ label: 'main', title: 'Agent SFTP location regression', width: 1200, height: 760 }] },
  })], {
    cwd: repository, detached: true, env: { ...process.env, SHELLSPAN_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output = (output + chunk.toString().replaceAll(password, '[redacted]')).slice(-14000); });
  }
  child.on('error', result.reject);
  child.on('exit', code => result.reject(new Error(`Desktop app exited before reporting (${code})`)));
  assert.equal(await Promise.race([result.promise, delay(240_000, 'Timed out', { ref: false })]), 'PASS');
  process.stdout.write('PASS: SFTP kept the selected remote file across tab switches and selected the correct host through each jump route.\n');
} catch (error) {
  process.stderr.write(`${error}\n${output}\n`);
  process.exitCode = 1;
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await server?.close();
  for (const cleanup of cleanups.reverse()) {
    try { cleanup(); } catch (error) { process.stderr.write(`${error}\n`); process.exitCode = 1; }
  }
}
