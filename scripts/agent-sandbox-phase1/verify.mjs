import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [nonoArg, srtArg, resultsArg = 'artifacts/tests/agent-sandbox-phase1'] = process.argv.slice(2);
if (!nonoArg || !srtArg) {
  throw new Error('Usage: node verify.mjs <nono probe binary> <srt binary> [results directory]');
}
const nono = realpathSync(nonoArg);
const srt = realpathSync(srtArg);
const node = realpathSync(process.execPath);
const results = resolve(resultsArg);
mkdirSync(results, { recursive: true });
const runDir = mkdtempSync(join(realpathSync(results), `run-${platform()}-`));
// srt creates Unix sockets beneath TMPDIR. Use a short private fixture path on
// macOS so its socket path fits the OS address limit.
const fixtureRoot = platform() === 'darwin'
  ? mkdtempSync(join(realpathSync('/tmp'), 'ss-sbx-'))
  : mkdirSync(join(runDir, 'fixtures'), { recursive: true });
writeFileSync(join(runDir, 'fixture-root.txt'), `${fixtureRoot}\n`);
const startedMark = 'PHASE1_STARTED';
const commandTimeout = 12_000;
const read = (file) => readFileSync(file, 'utf8');
const backends = ['direct', 'nono', 'nono-hardened', 'srt'];

function changeImmutable(flag, path) {
  const r = spawnSync('/usr/bin/chflags', [flag, path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`chflags ${flag} ${path}: ${r.error?.message ?? r.stderr.trim()}`);
}

async function withProtectedParents(fixture, run) {
  const protectedPaths = [];
  try {
    // Both parents are private fixtures directly below the system-managed
    // temporary directory. The writable workspace itself keeps normal flags.
    for (const path of [fixture.anchor, fixture.root]) {
      changeImmutable('uchg', path);
      protectedPaths.push(path);
    }
    return await run();
  } finally {
    const errors = [];
    for (const path of protectedPaths.reverse()) {
      try {
        changeImmutable('nouchg', path);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Could not restore the private fixture directories');
  }
}

function renameDenial(source, destination) {
  try {
    renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    return error.code;
  }
  return null;
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function findTestChild(durationSuffix) {
  // Match the fixture's unique argv in the parent's PID namespace. A child
  // PID printed by a sandboxed command can be in a different namespace.
  const result = spawnSync('/usr/bin/pgrep', ['-fx', `/bin/sleep 30[.]${durationSuffix}`], { encoding: 'utf8' });
  if (result.status === 1) return null;
  const pid = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Could not identify the test child using pgrep');
  }
  return pid;
}

function execute(executable, args, options) {
  return new Promise((done) => {
    const time = performance.now();
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let err;
    let actionError;
    let triggered = false;
    let closed = false;
    let escalation;
    function stop(reason) {
      if (closed || options.stopReason) return;
      options.stopReason = reason;
      signalGroup(child.pid, 'SIGTERM');
      escalation = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 500);
    }
    const deadline = setTimeout(() => stop('harnessDeadline'), commandTimeout);
    child.on('error', (error) => { err = error.message; });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') err = error.message;
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-32_768);
      if (!options.onOutput || triggered) return;
      try {
        triggered = options.onOutput(stdout, child, stop);
      } catch (error) {
        actionError = error.message;
        stop('harnessError');
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-32_768);
    });
    if (!options.onOutput) child.stdin.end(options.input);
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      done({ code, signal, stdout, stderr, elapsedMs: Math.round(performance.now() - time),
        stopReason: options.stopReason, error: err ?? actionError });
    });
  });
}

function prepare(anchor = fixtureRoot) {
  const root = mkdtempSync(join(anchor, 'case-'));
  const workspace = join(root, 'workspace');
  const temporary = join(root, 'temporary');
  const outsideRead = join(root, 'outside-read');
  const outsideWrite = join(root, 'outside-write');
  const home = join(root, 'home');
  for (const dir of [workspace, temporary, outsideRead, outsideWrite, home]) mkdirSync(dir);
  writeFileSync(join(workspace, 'inside.txt'), 'inside-workspace\n');
  writeFileSync(join(outsideRead, 'canary.txt'), 'outside-read-canary\n');
  symlinkSync(outsideWrite, join(workspace, 'outside-link'));
  copyFileSync(fileURLToPath(new URL('./network-probe.mjs', import.meta.url)), join(workspace, 'network-probe.mjs'));
  const settings = join(root, 'srt.json');
  writeFileSync(settings, JSON.stringify({
    filesystem: {
      allowWrite: [workspace, temporary], denyWrite: [], denyRead: [outsideRead], allowRead: [],
    },
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false },
  }), { mode: 0o600 });
  return { anchor, root, workspace, temporary, outsideWrite, settings, env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C', TMPDIR: temporary,
    WORKSPACE: workspace, NODE: node, PRIVATE_TEMP: temporary, OUTSIDE_READ: outsideRead, OUTSIDE_WRITE: outsideWrite,
  } };
}

const isStarted = (r) => r.stdout.includes(startedMark) && !r.error && r.stopReason !== 'harnessDeadline';
const successful = (r) => isStarted(r) && r.code === 0;
const rejected = (r) => isStarted(r) && r.code !== null && r.code !== 0;
const written = (path) => existsSync(path) && read(path) === 'written\n';
const outputAt = (f, name) => join(f.outsideWrite, name);
const expectDeniedWrite = (name, script) => ({
  name, script,
  baseline: (r, f) => successful(r) && written(outputAt(f, name)),
  sandbox: (r, f) => rejected(r) && !existsSync(outputAt(f, name)),
});

const tcp = createServer((socket) => { socket.on('error', () => {}); socket.pipe(socket); });
tcp.listen(0, '127.0.0.1');
const udp = createSocket('udp4');
udp.on('message', (message, from) => { udp.send(message, from.port, from.address); });
udp.bind(0, '127.0.0.1');
await Promise.all([once(tcp, 'listening'), once(udp, 'listening')]);

const cases = [
  { name: 'workspace-read-write', script: 'cat inside.txt && printf "written\\n" > inside-output.txt',
    check: (r, f) => successful(r) && r.stdout.includes('inside-workspace\n')
      && written(join(f.workspace, 'inside-output.txt')) },
  { name: 'private-temp', script: 'printf "written\\n" > "$PRIVATE_TEMP/private.txt"',
    check: (r, f) => successful(r) && written(join(f.temporary, 'private.txt')) },
  { name: 'tmpdir-preserved', script: 'printf "TMPDIR=%s\\n" "$TMPDIR"; printf "written\\n" > "$TMPDIR/from-env.txt"',
    check: (r, f) => successful(r) && written(join(f.temporary, 'from-env.txt')) },
  { name: 'outside-read', script: 'cat "$OUTSIDE_READ/canary.txt"',
    baseline: (r) => successful(r) && r.stdout.includes('outside-read-canary'),
    sandbox: (r) => rejected(r) && !r.stdout.includes('outside-read-canary') },
  expectDeniedWrite('outside-write', 'printf "written\\n" > "$OUTSIDE_WRITE/outside-write"'),
  expectDeniedWrite('parent-path-write', 'printf "written\\n" > ../outside-write/parent-path-write'),
  expectDeniedWrite('symlink-write', 'printf "written\\n" > outside-link/symlink-write'),
  { name: 'child-inherits-policy',
    script: `/bin/sh -c 'printf "written\\n" > child.txt && printf "written\\n" > "$OUTSIDE_WRITE/child-outside"'`,
    baseline: (r, f) => successful(r) && written(outputAt(f, 'child-outside')),
    sandbox: (r, f) => rejected(r) && written(join(f.workspace, 'child.txt'))
      && !existsSync(outputAt(f, 'child-outside')) },
  ...[['tcp', tcp.address().port], ['udp', udp.address().port]].map(([protocol, port]) => ({
    name: `loopback-${protocol}`, script: `"$NODE" ./network-probe.mjs ${protocol} ${port}`,
    baseline: (r) => successful(r) && r.stdout.includes('LOOPBACK_REACHED'),
    sandbox: (r) => isStarted(r) && r.code === 73 && !r.stdout.includes('LOOPBACK_REACHED')
      && r.stderr.includes('loopback: '),
  })),
  { name: 'stdio-eof-exit', input: 'shellspan-stdin\n',
    script: `IFS= read -r line && printf 'stdin=%s\\n' "$line"; if IFS= read -r extra; then exit 98; fi; printf 'stderr-marker\\n' >&2; exit 42`,
    check: (r) => isStarted(r) && r.code === 42 && r.stdout.includes('stdin=shellspan-stdin\n')
      && r.stderr.includes('stderr-marker\n') },
  { name: 'workspace-replaced-after-start',
    script: 'printf "REPLACE_READY\\n"; IFS= read -r line && printf "written\\n" > "$WORKSPACE/replacement.txt"',
    onOutput(stdout, child, _stop, f) {
      if (!stdout.includes('REPLACE_READY\n')) return false;
      f.workspaceRenameDenied = renameDenial(f.workspace, join(f.root, 'previous-workspace'));
      if (!f.workspaceRenameDenied) mkdirSync(f.workspace);
      if (f.protectedParents) {
        f.parentRenameDenied = [f.root, f.anchor].map((path) => {
          const replacement = `${path}-relocated`;
          const denial = renameDenial(path, replacement);
          if (!denial) renameSync(replacement, path);
          return denial;
        });
      }
      child.stdin.end('continue\n');
      return true;
    },
    baseline: (r, f) => successful(r) && written(join(f.workspace, 'replacement.txt')),
    sandbox: (r, f) => f.protectedParents
      ? successful(r) && Boolean(f.workspaceRenameDenied) && f.parentRenameDenied?.every(Boolean)
        && written(join(f.workspace, 'replacement.txt'))
      : isStarted(r) && existsSync(join(f.root, 'previous-workspace'))
        && !existsSync(join(f.workspace, 'replacement.txt')) },
  ...['cancel', 'timeout'].map((reason) => ({
    name: `process-tree-${reason}`,
    script: (f) => `/bin/sleep 30.${f.durationSuffix} & printf 'CHILD_READY\\n'; wait "$!"`,
    onOutput(stdout, _child, stop, f) {
      if (!stdout.includes('CHILD_READY\n')) return false;
      f.settled = (async () => {
        for (let i = 0; i < 20 && !findTestChild(f.durationSuffix); i++) await delay(25);
        f.childWasRunning = Boolean(findTestChild(f.durationSuffix));
        if (reason === 'timeout') await delay(350);
        stop(reason);
        await delay(800);
        const survivor = findTestChild(f.durationSuffix);
        f.childSurvived = Boolean(survivor);
        if (survivor) {
          try { process.kill(survivor, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      })().catch((error) => {
        f.lifecycleError = error.message;
        stop('harnessError');
      });
      return true;
    },
    check: (r, f) => isStarted(r) && r.stopReason === reason && f.childWasRunning && !f.childSurvived && !f.lifecycleError,
  })),
];

function launch(backend, f, script, options = {}) {
  // Match Direct's POSIX Shell and login-shell argument shape.
  const argv = ['/bin/sh', '-lc', `printf '${startedMark}\\n'; ${script}`];
  const useNono = backend === 'nono' || backend === 'nono-hardened';
  const executable = backend === 'direct' ? argv.shift() : useNono ? nono : srt;
  const prefix = backend === 'nono-hardened' && platform() === 'linux' ? ['--seccomp-network'] : [];
  const args = useNono
    ? [...prefix, options.invalid ? join(f.root, 'missing-workspace') : f.workspace, f.temporary, node, '--', ...argv]
    : backend === 'srt'
      ? ['--settings', options.invalid ? join(f.root, 'missing-settings.json') : f.settings, '--', ...argv]
      : argv;
  const start = () => execute(executable, args, { cwd: f.workspace, env: f.env, ...options });
  f.protectedParents = backend === 'nono-hardened' && platform() === 'darwin';
  return f.protectedParents ? withProtectedParents(f, start) : start();
}

async function runCase(backend, test) {
  const f = prepare();
  f.durationSuffix = randomInt(10_000_000, 100_000_000);
  const script = typeof test.script === 'function' ? test.script(f) : test.script;
  const result = await launch(backend, f, script, {
    input: test.input,
    onOutput: test.onOutput && ((output, child, stop) => test.onOutput(output, child, stop, f)),
  });
  await f.settled;
  const check = test.check ?? (backend === 'direct' ? test.baseline : test.sandbox);
  return { name: test.name, pass: Boolean(check(result, f)),
    ...(test.name === 'workspace-replaced-after-start' && {
      workspaceRenameDenied: f.workspaceRenameDenied,
      parentRenameDenied: f.parentRenameDenied,
      replacementWritten: !f.workspaceRenameDenied && written(join(f.workspace, 'replacement.txt')),
      originalWritten: f.workspaceRenameDenied ? written(join(f.workspace, 'replacement.txt'))
        : written(join(f.root, 'previous-workspace', 'replacement.txt')),
    }),
    childWasRunning: f.childWasRunning, childSurvived: f.childSurvived,
    lifecycleError: f.lifecycleError, ...result };
}

async function managedWorkspaceLifecycle() {
  const anchors = Array.from({ length: 2 }, () => mkdtempSync(join(realpathSync('/tmp'), 'ss-sbx-managed-')));
  writeFileSync(join(runDir, 'managed-fixture-roots.json'), JSON.stringify(anchors));
  const runs = [];
  try {
    for (const anchor of anchors) {
      const fixture = prepare(anchor);
      const ready = Promise.withResolvers();
      const run = { fixture };
      run.done = launch('nono-hardened', fixture,
        'printf "MANAGED_READY\\n"; IFS= read -r line && printf "written\\n" > completed.txt', {
          onOutput(stdout, child) {
            if (!stdout.includes('MANAGED_READY\n')) return false;
            run.child = child;
            ready.resolve();
            return true;
          },
        });
      run.ready = Promise.race([ready.promise, run.done.then((result) => {
        if (!run.child) throw new Error(`Managed workspace did not start: ${result.stderr}`);
      })]);
      runs.push(run);
    }
    await Promise.all(runs.map((run) => run.ready));
    const [first, second] = runs;
    const tryMove = ({ fixture }) => {
      const moved = join(fixture.root, 'moved-workspace');
      const denial = renameDenial(fixture.workspace, moved);
      if (!denial) renameSync(moved, fixture.workspace);
      return denial;
    };
    const bothProtected = [tryMove(first), tryMove(second)];
    first.child.kill('SIGKILL');
    const firstResult = await first.done;
    const firstUnlocked = tryMove(first) === null;
    const secondStillProtected = tryMove(second);
    second.child.stdin.end('continue\n');
    const secondResult = await second.done;
    const secondUnlocked = tryMove(second) === null;
    const pass = bothProtected.every(Boolean) && firstResult.signal === 'SIGKILL' && firstUnlocked
      && Boolean(secondStillProtected) && successful(secondResult) && secondUnlocked
      && written(join(second.fixture.workspace, 'completed.txt'));
    return { pass, bothProtected, firstUnlocked, secondStillProtected, secondUnlocked, firstResult, secondResult };
  } finally {
    for (const run of runs) run.child?.kill('SIGKILL');
    await Promise.allSettled(runs.map((run) => run.done));
    for (const anchor of anchors) rmSync(anchor, { recursive: true, force: true });
  }
}

const version = JSON.parse(read(join(dirname(srt), '..', 'package.json'))).version;
const probe = spawnSync(nono, ['--probe'], { encoding: 'utf8' });
const report = {
  host: { platform: platform(), arch: arch(), kernel: release(), node: process.version },
  tools: { nono: { version: '0.82.0', license: 'Apache-2.0', probe: probe.stdout.trim(), probeExit: probe.status },
    srt: { version, license: 'Apache-2.0' } },
  results: {},
};

try {
  for (const backend of backends) {
    const timing = [];
    for (let i = 0; i < 6; i++) {
      const r = await launch(backend, prepare(), 'exit 0');
      timing.push({ pass: successful(r), elapsedMs: r.elapsedMs, code: r.code,
        stderr: successful(r) ? undefined : r.stderr });
    }
    const results = [];
    for (const test of cases) results.push(await runCase(backend, test));
    if (backend !== 'direct') {
      const r = await launch(backend, prepare(), 'exit 0', { invalid: true });
      results.push({ name: 'invalid-configuration', pass: !isStarted(r) && r.code !== null && r.code !== 0, ...r });
    }
    if (platform() === 'darwin' && backend === 'nono-hardened') {
      results.push(await runCase(backend, {
        name: 'protected-parent-cannot-be-unlocked-by-child',
        script: '/usr/bin/chflags nouchg ..',
        check: rejected,
      }));
      results.push(await runCase(backend, {
        name: 'file-rename-delete-inside-protected-workspace',
        script: 'printf file > before.txt && mv before.txt after.txt && rm after.txt',
        check: (r, f) => successful(r) && !existsSync(join(f.workspace, 'before.txt'))
          && !existsSync(join(f.workspace, 'after.txt')),
      }));
    }
    report.results[backend] = { timing, results,
      passed: results.filter((r) => r.pass).length, total: results.length };
  }
  if (platform() === 'darwin') report.managedWorkspaceLifecycle = await managedWorkspaceLifecycle();
  process.exitCode = Object.values(report.results).every(({ timing, results }) =>
    timing.every((r) => r.pass) && results.every((r) => r.pass)) && probe.status === 0
    && report.managedWorkspaceLifecycle?.pass !== false ? 0 : 1;
} finally {
  tcp.close();
  udp.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
  const reportPath = join(runDir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const counts = Object.entries(report.results).map(([name, value]) => `${name} ${value.passed}/${value.total}`);
  console.log(`${counts.join(', ')} · ${reportPath}`);
}
