import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const name = `shellspan-diagnostics-${process.pid}-${Date.now()}`;
const image = 'shellspan-diagnostics-e2e:local';
const collector = 'src-tauri/src/agent_runtime/native/diagnostic_collector.py';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return result;
}

let started = false;
try {
  run('python3', ['-B', 'src-tauri/src/agent_runtime/native/__tests__/test_diagnostic_collector.py']);
  run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', 'diagnostic', '--lib']);
  run('docker', ['build', '-t', image, 'tests/agent-diagnostics']);
  // systemd needs its own writable cgroup namespace. No host mounts, network,
  // published ports, Docker socket, credentials or persistent volumes are shared.
  run('docker', ['run', '-d', '--rm', '--name', name, '--privileged', '--cgroupns=private',
    '--network=none', '--tmpfs', '/run', '--tmpfs', '/run/lock', '--tmpfs', '/tmp', image], { stdio: 'pipe' });
  started = true;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    const check = spawnSync('docker', ['exec', name, 'systemctl', 'is-active', 'systemd-journald.service'],
      { cwd: root, stdio: 'pipe', timeout: 3000 });
    if (check.status === 0) { ready = true; break; }
    await delay(300);
  }
  if (!ready) throw new Error('isolated systemd journal did not become ready');
  run('docker', ['cp', collector, `${name}:/opt/diagnostic_collector.py`]);
  run('docker', ['cp', 'tests/agent-diagnostics/test_systemd.py', `${name}:/opt/test_systemd.py`]);
  run('docker', ['exec', name, 'python3', '-B', '/opt/test_systemd.py']);
} finally {
  if (started) run('docker', ['rm', '-f', name], { stdio: 'pipe' });
}
