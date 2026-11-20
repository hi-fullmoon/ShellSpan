import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
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
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${rendered} exited with status ${result.status ?? 'unknown'}`);
  }
  return result.stdout;
}

function cargoTest(filter, testArgs = [], env = fixtureEnvironment) {
  const output = run(cargo, [
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
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (!/^test result: ok\. 1 passed; 0 failed; 0 ignored;/m.test(output)) {
    throw new Error(`Expected exactly one passing SSH regression for ${filter}`);
  }
}

async function verifyAgentAuthentication() {
  const directory = mkdtempSync('/tmp/shellspan-agent-test-');
  const socket = path.join(directory, 'agent.sock');
  const key = path.join(directory, 'identity');
  const environment = { ...fixtureEnvironment, SSH_AUTH_SOCK: socket };
  let agent;
  try {
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    agent = spawn('ssh-agent', ['-D', '-a', socket], { cwd: directory, stdio: 'ignore' });
    await once(agent, 'spawn');
    const deadline = Date.now() + 3_000;
    while (!existsSync(socket) && agent.exitCode === null && Date.now() < deadline) await delay(25);
    if (!existsSync(socket)) throw new Error('The isolated SSH agent did not create its socket');
    run('ssh-add', [key], { env: environment });
    run(docker, [...compose, 'exec', '-T', 'ssh', 'sh', '-c',
      'install -d -m 700 -o shellspan -g shellspan /home/shellspan/.ssh && umask 077 && cat > /home/shellspan/.ssh/authorized_keys && chown shellspan:shellspan /home/shellspan/.ssh/authorized_keys',
    ], { input: readFileSync(key + '.pub'), stdio: ['pipe', 'inherit', 'inherit'] });
    cargoTest('connection::tests::isolated_ssh_preflight_authenticates_with_the_local_agent', ['--ignored', '--exact'], environment);
  } finally {
    if (agent?.pid && agent.exitCode === null && agent.signalCode === null) {
      const exited = once(agent, 'exit');
      agent.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

let fixtureStarted = false;
try {
  run(docker, ['build', '-t', 'shellspan-ssh-e2e:local', 'tests/ssh-e2e']);
  run(docker, [...compose, 'up', '-d', '--wait']);
  fixtureStarted = true;
  cargoTest(
    'port_forward::tests::isolated_ssh_dynamic_socks5_forward_routes_remote_traffic_and_stops',
    ['--ignored', '--exact'],
  );
  if (process.platform !== 'win32') await verifyAgentAuthentication();
  cargoTest(
    'session::tests::initial_directory_ssh_integrated_shell_runs_after_login_scripts',
    ['--ignored', '--exact'],
  );
  cargoTest(
    'session::tests::initial_directory_ssh_fallback_preserves_single_zshenv_and_echo',
    ['--ignored', '--exact'],
  );
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
  cargoTest('session::tests::remote_prompt_recovers_tty_modes_after_vim_exit', ['--ignored', '--exact']);
  cargoTest('session::tests::vim_bridge_tests::isolated_ssh_vim_bridge_edits_and_verifies_both_editors', ['--ignored', '--exact']);
  cargoTest('session::tests::vim_bridge_tests::isolated_ssh_vim_bridge_guards_disk_versions_and_resumes', ['--ignored', '--exact']);
  if (process.platform !== 'win32') {
    cargoTest('session::tests::remote_ssh_write_queue_resumes_pinned_control_before_pty_input', ['--ignored', '--exact']);
    cargoTest('session::tests::remote_ssh_write_queue_retries_after_silent_window_update', ['--ignored', '--exact']);
  }
  cargoTest('session::tests::terminal_recovery_tests::isolated_ssh_stop_restores_manual_input_on_fresh_connections', ['--ignored', '--exact']);
  cargoTest('session::tests::terminal_recovery_tests::isolated_ssh_input_timeout_disconnect_and_reconnect_do_not_replay', ['--ignored', '--exact']);
  cargoTest('session::tests::terminal_recovery_tests::isolated_ssh_buffered_editor_receipt_does_not_wait_for_more_network_input', ['--ignored', '--exact']);
  cargoTest('session::tests::terminal_recovery_tests::isolated_ssh_long_source_frames_receive_exact_acknowledgements', ['--ignored', '--exact']);
  cargoTest('session::tests::ordinary_ssh_unsupported_shell_is_unavailable_without_a_second_transport', ['--ignored', '--exact']);
  cargoTest('session::tests::ordinary_ssh_without_sftp_falls_back_to_a_usable_shell', ['--ignored', '--exact']);
  cargoTest('session::tests::stalled_native_startup_reconnects_to_a_usable_plain_ssh_pty', ['--ignored', '--exact']);
  cargoTest('session::tests::slow_startup_sftp_uses_the_native_budget_and_can_be_cancelled', ['--ignored', '--exact']);
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
  cargoTest(
    'port_forward::tests::isolated_scoped_http_bridge_preserves_half_close_and_stops_on_cancel_or_deadline',
    ['--ignored', '--exact'],
  );
  console.log(
    '\nIsolated SSH gate completed with ordinary bash/zsh PTYs, startup compatibility, cleanup, Direct SSH exec, scoped remote-loopback HTTP, and SOCKS5 forwarding.',
  );
} finally {
  if (fixtureStarted) run(docker, [...compose, 'down']);
}
