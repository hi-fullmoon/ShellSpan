import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert(platform() === 'darwin' && arch() === 'arm64', 'The sandbox preview requires macOS arm64');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputBase = join(root, 'artifacts/tests/agent-sandbox');
const crate = join(root, 'src-tauri');
const label = 'ShellSpan Sandbox Preview';
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--reuse-preview'),
  'Usage: build-mac-sandbox-preview.mjs [--reuse-preview previous-package-directory]');
await mkdir(outputBase, { recursive: true });
const previous = args.length === 2 ? await realpath(args[1]) : null;
if (previous) {
  assert.equal(dirname(previous), await realpath(outputBase), 'Expected a previous preview package in this worktree');
}
const output = await mkdtemp(join(outputBase, 'preview-mac-'));

function run(command, args, environment = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_PROFILE_DEV_DEBUG: '0', ...environment } });
}

const probeTarget = join(crate, 'target/agent-sandbox-probe');
run('cargo', ['build', '--locked', '--manifest-path', 'scripts/agent-sandbox/Cargo.toml', '--target-dir', probeTarget]);
run('pnpm', ['build']);
const config = join(output, 'tauri-preview.json');
const launcher = join(probeTarget, 'debug/shellspan-sandbox-probe');
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const launcherSha256 = await hash(launcher);
const base = JSON.parse(await readFile(join(crate, 'tauri.conf.json'), 'utf8'));
await writeFile(config, JSON.stringify({
  productName: label, identifier: 'com.shellspan.validation.agent-sandbox-preview-keychain',
  build: { beforeBuildCommand: '' },
  bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: '-' },
    resources: { ...base.bundle.resources, [relative(crate, launcher)]: 'acceptance/nono-probe' } },
  plugins: { updater: { active: false } },
}));
run('pnpm', ['exec', 'tauri', 'build', '--debug', '--bundles', 'app', '--features',
  'native-input-acceptance', '--config', config], { SHELLSPAN_MAC_SANDBOX_LAUNCHER_SHA256: launcherSha256 });
const bundle = join(output, `${label}.app`);
await cp(join(crate, 'target/debug/bundle/macos', `${label}.app`), bundle, { recursive: true, verbatimSymlinks: true });
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
assert.equal(await hash(join(bundle, 'Contents/Resources/acceptance/nono-probe')), launcherSha256);
const start = join(output, '启动沙箱内测.command');
await cp(join(root, 'scripts/agent-sandbox/launch-mac-sandbox-preview.sh'), start);
await chmod(start, 0o755);

async function verifyOwnedDirectory(path) {
  const metadata = await lstat(path);
  assert(metadata.isDirectory() && metadata.uid === process.getuid() && await realpath(path) === path,
    `Expected an owned directory at ${path}`);
}

const userHome = await realpath(homedir());
const sandboxPrefix = '.shellspan-agent-sandbox-preview-';
const legacySandboxRoot = join(userHome, '.shellspan/agent-sandbox');

async function prepareRuntime(previousRuntime) {
  if (previousRuntime) {
    await verifyOwnedDirectory(previousRuntime);
    if (dirname(previousRuntime) === userHome && basename(previousRuntime).startsWith(sandboxPrefix)) {
      return previousRuntime;
    }
    assert((dirname(previousRuntime) === '/private/tmp' && basename(previousRuntime).startsWith('ss-sandbox-desktop-'))
      || (dirname(previousRuntime) === legacySandboxRoot && basename(previousRuntime).startsWith('preview-')),
      'Expected a managed legacy preview directory');
    const previousData = join(previousRuntime, 'data');
    await verifyOwnedDirectory(previousData);
    const active = spawnSync('/usr/sbin/lsof', ['-n', '-t', '+d', previousData, previousRuntime], { encoding: 'utf8' });
    if (active.error) throw active.error;
    assert(active.status === 1 && !active.stdout && !active.stderr,
      'Quit the previous preview and its local terminals before migrating its data');
    await assert.rejects(lstat(join(previousData, 'managed-directory-guard.json')), { code: 'ENOENT' },
      'The previous preview needs to finish sandbox recovery before migrating');
  }

  const runtime = await mkdtemp(join(userHome, sandboxPrefix));
  for (const name of ['home', 'data', 'app-directories']) {
    const destination = join(runtime, name);
    if (previousRuntime) {
      const source = join(previousRuntime, name);
      await verifyOwnedDirectory(source);
      await cp(source, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    } else {
      await mkdir(destination, { mode: 0o700 });
    }
  }
  for (const name of ['temporary', 'signals']) {
    await mkdir(join(runtime, name), { mode: 0o700 });
  }
  await writeFile(join(runtime, 'launcher.json'), JSON.stringify({ sha256: launcherSha256 }), { mode: 0o600 });
  return runtime;
}

const previousRuntime = previous ? (await readFile(join(previous, 'runtime-directory.txt'), 'utf8')).trim() : null;
const runtime = await prepareRuntime(previousRuntime);
await writeFile(join(output, 'runtime-directory.txt'), runtime, { mode: 0o600 });
const store = previous ? await readFile(join(previous, 'webkit-store.txt'), 'utf8') : randomUUID();
await writeFile(join(output, 'webkit-store.txt'), store, { mode: 0o600 });
if (previous) {
  await writeFile(join(output, 'preview-report.json'), JSON.stringify({
    bundle, launcher: start, workspace: join(runtime, 'home'), data: join(runtime, 'data'),
    launcherSha256, reusesPreviewData: true, migratedPreviewData: runtime !== previousRuntime,
  }, null, 2));
  console.log(`Preview prepared · ${join(output, 'preview-report.json')}`);
  process.exit(0);
}
const logPath = join(output, 'preview.log');
execFileSync(start, ['--check-preview-profile-keychain'], { cwd: output, timeout: 30_000, stdio: 'inherit' });
assert((await readFile(logPath, 'utf8')).includes('PREVIEW_PROFILE_KEYCHAIN_OK'),
  `Preview could not round-trip an SSH profile password through Keychain. See ${logPath}`);
const log = await open(logPath, 'a');
let app;
try {
  app = spawn(start, [], { cwd: output, detached: true, stdio: ['ignore', log.fd, log.fd] });
  await once(app, 'spawn');
  app.unref();
} finally {
  await log.close();
}
const startedAt = Date.now();
while (Date.now() - startedAt < 30_000) {
  process.kill(app.pid, 0);
  const log = await readFile(logPath, 'utf8');
  if (log.includes('invoke load_preferences completed')) {
    const result = { bundle, launcher: start, workspace: join(runtime, 'home'), data: join(runtime, 'data'),
      pid: app.pid, launcherSha256, frontendPreferencesLoaded: true, profileKeychainRoundTrip: true };
    await writeFile(join(output, 'preview-report.json'), JSON.stringify(result, null, 2));
    console.log(`Preview running · ${join(output, 'preview-report.json')}`);
    process.exit(0);
  }
  await delay(150);
}
throw new Error(`Preview frontend did not finish loading preferences. See ${logPath}`);
