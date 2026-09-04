import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(workspace, 'tests', 'ssh-e2e', 'compose.yml');
const projectName = `shellspan-stage6d-${process.pid}`;
const testFilter = 'file_reference_isolated_ssh_production_listing';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

let composeAttempted = false;
let failure;
try {
  run('docker', [
    'build', '--tag', 'shellspan-ssh-e2e:local', path.dirname(composeFile),
  ]);
  // Set this before `up`: Docker can create part of the project and still
  // return a failure (for example, after one container becomes unhealthy).
  // The finally block must tear down that partial environment as well.
  composeAttempted = true;
  run('docker', [
    'compose', '--project-name', projectName, '--file', composeFile,
    'up', '--detach', '--wait', '--pull', 'never',
  ]);
  run('cargo', [
    'test', '--manifest-path', path.join(workspace, 'src-tauri', 'Cargo.toml'),
    '--lib', '--locked', testFilter, '--', '--ignored', '--nocapture',
    '--test-threads=1',
  ], {
    env: {
      ...process.env,
      SHELLSPAN_E2E_SSH_FIXTURE: '1',
      SHELLSPAN_E2E_SSH_HOST: '127.0.0.1',
      SHELLSPAN_E2E_SSH_PORT: '22222',
      SHELLSPAN_E2E_SSH_USERNAME: 'shellspan',
      SHELLSPAN_E2E_SSH_PASSWORD: 'shellspan-e2e',
      SHELLSPAN_E2E_SSH_JUMP_HOST: '127.0.0.1',
      SHELLSPAN_E2E_SSH_JUMP_PORT: '22223',
      SHELLSPAN_E2E_SSH_JUMP_TARGET_HOST: 'ssh',
      SHELLSPAN_E2E_SSH_JUMP_TARGET_PORT: '22',
    },
  });
  run('docker', ['compose','--project-name',projectName,'--file',composeFile,'exec','--user','root','-T','ssh','mv','/usr/bin/python3','/usr/bin/python3-fixture-disabled']);
  run('cargo', [
    'test', '--manifest-path', path.join(workspace, 'src-tauri', 'Cargo.toml'),
    '--lib', '--locked', testFilter, '--', '--ignored', '--nocapture',
    '--test-threads=1',
  ], {
    env: {
      ...process.env,
      SHELLSPAN_FILES_NO_PYTHON: '1',
      SHELLSPAN_E2E_SSH_FIXTURE: '1',
      SHELLSPAN_E2E_SSH_HOST: '127.0.0.1',
      SHELLSPAN_E2E_SSH_PORT: '22222',
      SHELLSPAN_E2E_SSH_USERNAME: 'shellspan',
      SHELLSPAN_E2E_SSH_PASSWORD: 'shellspan-e2e',
      SHELLSPAN_E2E_SSH_JUMP_HOST: '127.0.0.1',
      SHELLSPAN_E2E_SSH_JUMP_PORT: '22223',
      SHELLSPAN_E2E_SSH_JUMP_TARGET_HOST: 'ssh',
      SHELLSPAN_E2E_SSH_JUMP_TARGET_PORT: '22',
    },
  });
} catch (error) {
  failure = error;
} finally {
  if (composeAttempted) {
    const cleanup = spawnSync('docker', [
      'compose', '--project-name', projectName, '--file', composeFile,
      'down', '--volumes', '--remove-orphans',
    ], {
      cwd: workspace,
      stdio: 'inherit',
    });
    if (!failure && cleanup.error) failure = cleanup.error;
    if (!failure && cleanup.status !== 0) {
      failure = new Error(`docker compose down exited with status ${cleanup.status}`);
    }
  }
}

if (failure) throw failure;
