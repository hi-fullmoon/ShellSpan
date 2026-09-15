import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const compose = ['compose', '-f', 'tests/ssh-e2e/compose.yml'];
const fixtureEnvironment = {
  ...process.env,
  SHELLSPAN_E2E_SSH_FIXTURE: '1',
  SHELLSPAN_E2E_SSH_HOST: '127.0.0.1',
  SHELLSPAN_E2E_SSH_PORT: '22222',
  SHELLSPAN_E2E_SSH_USERNAME: 'shellspan',
  SHELLSPAN_E2E_SSH_PASSWORD: 'shellspan-e2e',
};

function run(command, args, options = {}) {
  const rendered = [command, ...args].join(' ');
  console.log(`\n> ${rendered}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${rendered} exited with status ${result.status ?? 'unknown'}`);
  }
}

function cargoTest(filter, testArgs = []) {
  run(cargo, [
    'test',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    filter,
    '--lib',
    '--',
    ...testArgs,
    '--nocapture',
    '--test-threads=1',
  ], { env: fixtureEnvironment });
}

let fixtureStarted = false;
try {
  run(docker, ['build', '-t', 'shellspan-ssh-e2e:local', 'tests/ssh-e2e']);
  run(docker, [...compose, 'up', '-d', '--wait']);
  fixtureStarted = true;
  cargoTest('session::tests::remote_agent_ssh_pty_bash_phase4_acceptance', ['--ignored', '--exact']);
  cargoTest('session::tests::remote_agent_ssh_pty_zsh_phase4_state_smoke', ['--ignored', '--exact']);
  cargoTest('session::tests::remote_agent_ssh_pty_unsupported_shell_is_unavailable', ['--ignored', '--exact']);
  cargoTest(
    'session::tests::remote_integration_scope_cleans_resources_after_post_prepare_failure',
    ['--ignored', '--exact'],
  );
  cargoTest(
    'execution::fixture::isolated_ssh_sftp_end_to_end_reviewed_execution_uname',
    ['--ignored', '--exact'],
  );
  console.log(
    '\nPhase 4 isolated SSH gate completed with real bash/zsh PTYs, post-prepare cleanup, and Direct SSH exec.',
  );
} finally {
  if (fixtureStarted) run(docker, [...compose, 'down']);
}
