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
  SHELLSPAN_E2E_SSH_NO_SFTP_PORT: '22224',
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
  cargoTest(
    'session::tests::ordinary_ssh_bash_prepares_integration_with_compatible_startup',
    ['--ignored', '--exact'],
  );
  cargoTest(
    'session::tests::ordinary_ssh_zsh_prepares_integration_with_compatible_startup',
    ['--ignored', '--exact'],
  );
  cargoTest(
    'session::tests::remote_control_failure_cleans_files_without_blocking_the_user_shell',
    ['--ignored', '--exact'],
  );
  cargoTest('session::tests::remote_bound_terminal_bash_reuses_source_shell_acceptance', ['--ignored', '--exact']);
  cargoTest('session::tests::remote_bound_terminal_zsh_reuses_source_shell_smoke', ['--ignored', '--exact']);
  cargoTest('session::tests::ordinary_ssh_unsupported_shell_is_unavailable_without_a_second_transport', ['--ignored', '--exact']);
  cargoTest('session::tests::ordinary_ssh_without_sftp_falls_back_to_a_usable_shell', ['--ignored', '--exact']);
  cargoTest(
    'session::tests::remote_integration_scope_cleans_resources_after_post_prepare_failure',
    ['--ignored', '--exact'],
  );
  cargoTest(
    'execution::fixture::isolated_ssh_sftp_end_to_end_reviewed_execution_uname',
    ['--ignored', '--exact'],
  );
  cargoTest(
    'agent_runtime::native::http_probe::tests::isolated_ssh_probe_reaches_only_the_remote_loopback_service',
    ['--ignored', '--exact'],
  );
  console.log(
    '\nIsolated SSH gate completed with shared ordinary bash/zsh PTYs, startup compatibility, cleanup, Direct SSH exec, and scoped remote-loopback HTTP.',
  );
} finally {
  if (fixtureStarted) run(docker, [...compose, 'down']);
}
