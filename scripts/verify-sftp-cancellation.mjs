import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Real native window, SSH/SFTP, production hooks, store and UI. No test doubles.
// Each run owns one loopback-only container and one random host-trust entry.
const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const image = 'shellspan-sftp-cancellation:local';
const token = randomUUID();
const name = `shellspan-sftp-cancellation-${token}`;
const directory = resolve(repository, '.sftp-cancellation', token);
const inputDirectory = resolve(directory, 'inputs');
const downloadDirectory = resolve(directory, 'downloads');
const filenames = {
  largeA: 'cancel-a.bin', raceA: 'race-a.bin', raceB: 'race-b.bin',
  smallB: 'queue-next.json', smallC: 'queue-tail.lock',
};
const timeoutMs = 10 * 60_000;
let containerCreated = false;
let switchContainerCreated = false;
const switchName = `${name}-switch`;
let child;
let server;
let resultResponse;
let timer;
let abortRequested = false;
let password;
let diagnostics = '';
const cleanupErrors = [];
const evidence = { ok: false, timestamp: new Date().toISOString(), container: name };
const nativeResult = Promise.withResolvers();
const cleanupResult = Promise.withResolvers();

function command(executable, args, options = {}) {
  const output = execFileSync(executable, args, {
    cwd: repository, encoding: 'utf8', timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
  return output?.trim() ?? '';
}

function docker(...args) { return command('docker', args); }

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(request) {
  assert.equal(request.method, 'POST', 'Expected POST');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    assert(length <= 65536, 'Oversized native test result');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function interrupt() {
  if (abortRequested) return;
  abortRequested = true;
  clearTimeout(timer);
  // Let the real hooks cancel workers and remove trust before terminating.
  timer = setTimeout(() => {
    nativeResult.resolve({ ok: false, error: 'Native regression interrupted or timed out' });
    cleanupResult.resolve({ ok: false, error: 'Native cleanup acknowledgement timed out' });
  }, 15_000);
}

async function stopChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolveExit) => child.once('exit', resolveExit));
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; return; }
  const exited = await Promise.race([exit.then(() => true), delay(5000).then(() => false)]);
  if (!exited) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exit;
  }
}

try {
  assert(process.platform !== 'win32', 'This native runner currently supports macOS and Linux desktops');
  docker('info');
  console.log('Preparing isolated OpenSSH and the native debug executable.');
  command('docker', ['build', '--pull=false', '-t', image, 'tests/sftp-cancellation'], { stdio: 'inherit' });
  const metadata = JSON.parse(command('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml']));
  const application = metadata.packages.find((pkg) => pkg.manifest_path === resolve(repository, 'src-tauri/Cargo.toml'));
  const binaries = application?.targets.filter((target) => target.kind.includes('bin'));
  assert(binaries?.length === 1, 'Expected one native application binary in Cargo metadata');
  const binary = binaries[0];
  command('cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', binary.name], {
    timeout: 20 * 60_000, stdio: 'inherit',
  });
  await mkdir(inputDirectory, { recursive: true });
  await mkdir(downloadDirectory);
  evidence.gitHead = command('git', ['rev-parse', 'HEAD']);
  evidence.inputs = {};
  for (const [key, filename] of Object.entries(filenames)) {
    const source = key === 'smallB' ? 'package.json'
      : key === 'smallC' ? 'src-tauri/Cargo.lock' : resolve(metadata.target_directory, 'debug', binary.name);
    const destination = resolve(inputDirectory, filename);
    await copyFile(resolve(repository, source), destination);
    evidence.inputs[filename] = await checksum(destination);
  }
  docker('run', '-d', '--name', name, '--cpus', '0.5', '--label', 'shellspan.test=sftp-cancellation',
    '-p', '127.0.0.1::22', image);
  containerCreated = true;
  const inspection = JSON.parse(docker('inspect', name))[0];
  const port = Number(inspection.NetworkSettings.Ports['22/tcp'][0].HostPort);
  assert(Number.isInteger(port) && port > 0, 'Missing isolated loopback port');
  evidence.port = port;
  password = randomBytes(24).toString('hex');
  command('docker', ['exec', '-i', name, 'chpasswd'], {
    input: `shellspan:${password}\n`, stdio: ['pipe', 'ignore', 'pipe'],
  });
  let fingerprint;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const output = docker('exec', name, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub');
      const match = output.match(/SHA256:[A-Za-z0-9+/]+/);
      assert(match, 'ssh-keygen did not report a SHA256 fingerprint');
      fingerprint = `ED25519 ${match[0]}`;
      break;
    } catch (error) {
      if (attempt === 29) throw error;
      await delay(200);
    }
  }
  evidence.hostFingerprint = fingerprint;
  docker('run', '-d', '--name', switchName, '--label', 'shellspan.test=sftp-cancellation', '-p', '127.0.0.1::22', image);
  switchContainerCreated = true;
  command('docker', ['exec', '-i', switchName, 'chpasswd'], { input: `shellspan:${password}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
  const switchPort = Number(JSON.parse(docker('inspect', switchName))[0].NetworkSettings.Ports['22/tcp'][0].HostPort);
  let switchFingerprint;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const match = docker('exec', switchName, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub').match(/SHA256:[A-Za-z0-9+/]+/);
      assert(match, 'Second SSH server fingerprint missing');
      switchFingerprint = `ED25519 ${match[0]}`;
      break;
    } catch (error) {
      if (attempt === 29) throw error;
      await delay(200);
    }
  }
  for (const serverName of [name, switchName]) {
    docker('exec', serverName, 'mkdir', '-p', '/home/shellspan/switch-target', '/home/shellspan/elsewhere');
    docker('exec', serverName, 'chown', '-R', 'shellspan:shellspan', '/home/shellspan/switch-target', '/home/shellspan/elsewhere');
  }
  const config = {
    port, password, fingerprint, switchPort, switchFingerprint, inputDirectory, downloadDirectory,
    ...Object.fromEntries(Object.entries(filenames).map(([key, filename]) => [key, resolve(inputDirectory, filename)])),
  };
  const html = 'src/components/sftp/__tests__/sftp-cancellation.native.html';
  server = await createServer({
    configFile: false, root: repository,
    resolve: { alias: { '@': resolve(repository, 'src') } },
    optimizeDeps: { entries: [html] },
    plugins: [react(), tailwindcss(), {
      name: 'native-sftp-cancellation-results',
      configureServer(vite) {
        vite.middlewares.use(`/__sftp-config/${token}`, (request, response) => {
          if (request.method !== 'GET') { response.writeHead(405).end(); return; }
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(config));
        });
        vite.middlewares.use(`/__sftp-control/${token}`, (_request, response) => {
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({ abort: abortRequested }));
        });
        vite.middlewares.use(`/__sftp-stage/${token}`, async (request, response) => {
          try {
            const stage = await readJson(request);
            assert(['switch-active', 'switch-tooltip', 'capture-wide', 'capture-narrow', 'switch-conflict', 'switch-download', 'switch-copy', 'switch-complete'].includes(stage), 'Invalid test stage');
            const capture = process.env.SFTP_CAPTURE === '1';
            if (!stage.startsWith('capture-')) console.log(`Native verification: ${stage}`);
            if (capture && stage === 'switch-active') docker('update', '--cpus', '0.02', name);
            if (capture && stage.startsWith('capture-')) {
              console.log(`Screenshot ready: ${resolve(directory, stage)} (create .done to continue)`);
              const deadline = Date.now() + 45_000;
              while (!abortRequested && Date.now() < deadline) {
                try { await access(resolve(directory, `${stage}.done`)); break; }
                catch { await delay(200); }
              }
              if (stage === 'capture-narrow') docker('update', '--cpus', '0.5', name);
            }
            response.end('ok');
          } catch { response.writeHead(400).end(); }
        });
        vite.middlewares.use(`/__sftp-result/${token}`, async (request, response) => {
          try {
            assert(!resultResponse, 'Duplicate native result');
            const result = await readJson(request);
            resultResponse = response;
            nativeResult.resolve(result);
            // Keep the native window alive until filesystem checks complete.
          } catch (error) {
            response.writeHead(400).end();
            nativeResult.resolve({ ok: false, error: error.message });
          }
        });
        vite.middlewares.use(`/__sftp-cleanup/${token}`, async (request, response) => {
          try { cleanupResult.resolve(await readJson(request)); response.end('ok'); }
          catch (error) { response.writeHead(400).end(); cleanupResult.resolve({ ok: false, error: error.message }); }
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  const devUrl = `http://127.0.0.1:${server.httpServer.address().port}/${html}?token=${token}`;
  child = spawn('pnpm', ['exec', 'tauri', 'dev', '--no-watch',
    ...(process.env.SFTP_CAPTURE_RUNNER ? ['--runner', process.env.SFTP_CAPTURE_RUNNER] : []), '--config', JSON.stringify({
    identifier: 'com.shellspan-dev', build: { beforeDevCommand: '', devUrl },
    app: { windows: [{ label: 'main', title: 'ShellSpan native SFTP cancellation regression', width: 1200, height: 760 }] },
  })], { cwd: repository, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString().replaceAll(password, '[redacted]')).slice(-8000); });
  child.once('error', (error) => {
    nativeResult.resolve({ ok: false, error: error.message });
    cleanupResult.resolve({ ok: false, error: 'Native app did not start' });
  });
  child.once('exit', (code) => {
    nativeResult.resolve({ ok: false, error: `Native app exited before reporting (${code})` });
    cleanupResult.resolve({ ok: false, error: 'Native app exited before cleanup acknowledgement' });
  });
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  timer = setTimeout(interrupt, timeoutMs);
  console.log('Running upload cancellation, task handoff and download cancellation over real SSH.');
  const native = await nativeResult.promise;
  evidence.native = native;
  if (native.nativeCleanupComplete !== true) cleanupErrors.push('Native SSH/host-trust cleanup was not confirmed');
  assert.equal(native.ok, true, native.error ?? 'Native SSH cancellation failed');
  assert.equal(native.nativeCleanupComplete, true, 'Native SSH/host-trust cleanup failed');
  assert.equal(abortRequested, false, 'Native SSH cancellation was interrupted');
  evidence.uploadChecksums = {};
  for (const filename of [filenames.smallB, filenames.smallC, filenames.raceA, filenames.raceB]) {
    const actual = docker('exec', name, 'sha256sum', `/home/shellspan/upload/${filename}`).split(/\s+/)[0];
    assert.equal(actual, evidence.inputs[filename], `Uploaded checksum mismatch: ${filename}`);
    evidence.uploadChecksums[filename] = actual;
  }
  evidence.downloadChecksums = {};
  for (const filename of [filenames.smallB, filenames.smallC]) {
    const actual = await checksum(resolve(downloadDirectory, filename));
    assert.equal(actual, evidence.inputs[filename], `Downloaded checksum mismatch: ${filename}`);
    evidence.downloadChecksums[filename] = actual;
  }
  evidence.remoteFiles = docker('exec', name, 'ls', '-A', '/home/shellspan/upload').split('\n');
  assert(!evidence.remoteFiles.some((filename) => filename.includes(filenames.largeA)), 'Cancelled upload left a target or temporary file');
  evidence.cancelledUploadFilesAbsent = true;
  evidence.switchChecksums = {};
  for (const filename of [filenames.largeA, filenames.smallB, filenames.smallC]) {
    const actual = docker('exec', name, 'sha256sum', `/home/shellspan/switch-target/${filename}`).split(/\s+/)[0];
    assert.equal(actual, evidence.inputs[filename], `Switching changed uploaded content: ${filename}`);
    evidence.switchChecksums[filename] = actual;
  }
  const copiedChecksum = docker('exec', switchName, 'sha256sum', '/home/shellspan/switch-target/cancel-a.bin').split(/\s+/)[0];
  assert.equal(copiedChecksum, evidence.inputs[filenames.largeA], 'Cross-host copy changed content after switch');
  evidence.switchCopyChecksum = copiedChecksum;
  assert.equal(await checksum(resolve(downloadDirectory, filenames.largeA)), evidence.inputs[filenames.largeA], 'Download changed content after switch');
  assert.equal(docker('exec', switchName, 'ls', '-A', '/home/shellspan/switch-target'), filenames.largeA, 'Original upload task wrote to switched host');
  assert.equal(docker('exec', switchName, 'ls', '-A', '/home/shellspan/elsewhere'), '', 'Original task wrote to switched directory');
  evidence.ok = true;
} catch (error) {
  evidence.error = error.message;
  if (diagnostics) evidence.nativeDiagnostics = diagnostics;
} finally {
  clearTimeout(timer);
  if (resultResponse) {
    resultResponse.setHeader('Content-Type', 'application/json');
    resultResponse.end(JSON.stringify({ trashInputs: true }));
    const timeout = setTimeout(() => cleanupResult.resolve({ ok: false, error: 'Test file cleanup timed out' }), 30_000);
    const cleaned = await cleanupResult.promise;
    clearTimeout(timeout);
    evidence.filesCleanup = cleaned;
    if (!cleaned.ok || !cleaned.filesCleaned) cleanupErrors.push(cleaned.error ?? 'Test files were not moved to trash');
    else {
      for (const path of [inputDirectory, downloadDirectory]) {
        try { await access(path); cleanupErrors.push(`Test directory still exists: ${path}`); }
        catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error.message); }
      }
    }
  }
  try { await stopChild(); } catch (error) { cleanupErrors.push(`Native process cleanup: ${error.message}`); }
  try { await server?.close(); } catch (error) { cleanupErrors.push(`Vite cleanup: ${error.message}`); }
  if (containerCreated) {
    try {
      docker('rm', '-f', name);
      assert(!docker('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'), 'Test container still exists');
    } catch (error) { cleanupErrors.push(`Container cleanup: ${error.message}`); }
  }
  if (switchContainerCreated) {
    try { docker('rm', '-f', switchName); }
    catch (error) { cleanupErrors.push(`Switch container cleanup: ${error.message}`); }
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  evidence.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length) evidence.ok = false;
  if (abortRequested) { evidence.ok = false; evidence.error ??= 'Native regression interrupted or timed out'; }
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

assert.equal(evidence.ok, true, `${evidence.error ?? cleanupErrors.join('; ')}\nEvidence: ${resolve(directory, 'result.json')}`);
console.log(`Native SSH transfers passed: cancellation, queues, host/directory switching and SHA256 checks; temporary resources cleaned. Evidence: ${resolve(directory, 'result.json')}`);
