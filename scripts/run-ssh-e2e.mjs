import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(workspace, 'tests', 'ssh-e2e', 'compose.yml');
const projectName = 'termbridge-e2e';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

let started = false;
try {
  run('docker', [
    'build', '--tag', 'termbridge-ssh-e2e:local', path.dirname(composeFile),
  ]);
  run('docker', [
    'compose', '--project-name', projectName, '--file', composeFile,
    'up', '--detach', '--wait', '--pull', 'never',
  ]);
  started = true;
  run('cargo', [
    'test', '--manifest-path', path.join(workspace, 'src-tauri', 'Cargo.toml'),
    '--locked', 'isolated_ssh_sftp_end_to_end', '--', '--ignored', '--nocapture',
    '--test-threads=1',
  ], {
    env: {
      ...process.env,
      TERMBRIDGE_E2E_SSH_FIXTURE: '1',
      TERMBRIDGE_E2E_SSH_HOST: '127.0.0.1',
      TERMBRIDGE_E2E_SSH_PORT: '22222',
      TERMBRIDGE_E2E_SSH_USERNAME: 'termbridge',
      TERMBRIDGE_E2E_SSH_PASSWORD: 'termbridge-e2e',
      TERMBRIDGE_E2E_SSH_JUMP_HOST: '127.0.0.1',
      TERMBRIDGE_E2E_SSH_JUMP_PORT: '22223',
      TERMBRIDGE_E2E_SSH_JUMP_TARGET_HOST: 'ssh',
      TERMBRIDGE_E2E_SSH_JUMP_TARGET_PORT: '22',
    },
  });
} finally {
  if (started) {
    const cleanup = spawnSync('docker', [
      'compose', '--project-name', projectName, '--file', composeFile,
      'down', '--volumes', '--remove-orphans',
    ], {
      cwd: workspace,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (cleanup.error) throw cleanup.error;
    if (cleanup.status !== 0 && process.exitCode === undefined) process.exitCode = cleanup.status ?? 1;
  }
}
