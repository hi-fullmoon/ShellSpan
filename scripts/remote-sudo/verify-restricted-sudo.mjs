import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const image = 'shellspan-ssh-e2e:local';
const name = `shellspan-restricted-sudo-${randomUUID()}`;
const env = { ...process.env, SHELLSPAN_E2E_SUDO_RUNNER_PASSWORD: randomBytes(24).toString('hex') };
const staged = '/tmp/shellspan-runner-fixture';

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
  return result.stdout?.trim();
}

if (spawnSync('docker', ['image', 'inspect', image], { cwd, stdio: 'ignore' }).status !== 0) {
  run('docker', ['build', '-t', image, 'tests/ssh-e2e']);
}

run('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::2222', '-p', '127.0.0.1::22', image]);
try {
  run('docker', ['exec', name, 'apk', 'add', '--no-cache', 'sudo']);
  run('docker', ['exec', name, 'mkdir', '-p', staged]);
  for (const file of [
    'scripts/remote-sudo/shellspan-sudo-runner',
    'scripts/remote-sudo/sshd_config.example',
    'tests/ssh-e2e/setup-restricted-sudo.sh',
    'tests/ssh-e2e/restricted-sudo-effective-user',
    'tests/ssh-e2e/restricted-sudo-jobs.json',
    'tests/ssh-e2e/restricted-sudoers',
  ]) {
    run('docker', ['cp', file, `${name}:${staged}/`]);
  }
  run('docker', ['exec', '--env', 'SHELLSPAN_E2E_SUDO_RUNNER_PASSWORD', name, 'sh', `${staged}/setup-restricted-sudo.sh`, staged]);
  const port = /^127\.0\.0\.1:(\d+)$/.exec(run('docker', ['port', name, '2222/tcp'], true))?.[1];
  const jumpPort = /^127\.0\.0\.1:(\d+)$/.exec(run('docker', ['port', name, '22/tcp'], true))?.[1];
  const fingerprint = run('docker', ['exec', name, 'ssh-keygen', '-lf', '/etc/ssh/shellspan_runner_ed25519_key.pub'], true).split(' ')[1];
  if (!port || !jumpPort || !fingerprint?.startsWith('SHA256:')) throw new Error('Could not verify the isolated runner endpoints');
  env.SHELLSPAN_E2E_SUDO_RUNNER_HOST = '127.0.0.1';
  env.SHELLSPAN_E2E_SUDO_RUNNER_PORT = port;
  env.SHELLSPAN_E2E_SUDO_RUNNER_KEY = fingerprint;
  env.SHELLSPAN_E2E_SUDO_RUNNER_INTERNAL_PORT = '2222';
  env.SHELLSPAN_E2E_SUDO_JUMP_PORT = jumpPort;
  env.SHELLSPAN_E2E_SUDO_JUMP_PASSWORD = 'shellspan-e2e';
  run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
    'execution::fixture::isolated_restricted_sudo_runner_', '--', '--ignored']);
} finally {
  run('docker', ['rm', '-f', name], true);
}
