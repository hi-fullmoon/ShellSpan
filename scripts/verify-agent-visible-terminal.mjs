import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const includeSshFixture = process.argv.includes('--ssh-fixture');
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');

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

function cargoTest(filter, extra = []) {
  run(cargo, [
    'test',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    filter,
    '--lib',
    '--',
    ...extra,
    '--nocapture',
  ]);
}

let sshFixtureStarted = false;
try {
  run(cargo, ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--all', '--', '--check']);
  run(cargo, ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets']);
  cargoTest('agent_runtime::native::terminal_lease::tests');
  cargoTest('agent_runtime::native::pty::tests');
  cargoTest('bound_terminal_result_is_redacted_before_model_context_and_session_persistence');
  cargoTest('restart_never_replays_an_approved_side_effect_with_uncertain_outcome');
  run(process.execPath, [
    vitestCli,
    'run',
    'src/components/terminal/__tests__/terminal-controller-layer.test.tsx',
    'src/components/terminal/__tests__/terminal-pane.test.tsx',
    'src/components/terminal/__tests__/terminal-registry.test.ts',
    'src/components/ai/__tests__/ai-workspace-controller.test.tsx',
    'src/lib/ai/__tests__/session-adapters.test.ts',
    'src/lib/ipc/__tests__/tauri.test.ts',
  ]);

  if (includeSshFixture) {
    run(docker, ['build', '-t', 'shellspan-ssh-e2e:local', 'tests/ssh-e2e']);
    run(docker, ['compose', '-f', 'tests/ssh-e2e/compose.yml', 'up', '-d', '--wait']);
    sshFixtureStarted = true;
    cargoTest(
      'agent_runtime::native::pty::tests::remote_ssh_posix_visible_command_protocol_is_end_to_end',
      ['--ignored', '--exact'],
    );
  } else {
    console.log('\nSSH fixture test skipped; pass --ssh-fixture to build and run the isolated Docker service.');
  }

  console.log(`\nHost platform gate completed on ${process.platform}/${process.arch}.`);
  console.log('Platform-gated POSIX and Windows PTY tests run only on matching hosts.');
} finally {
  if (sshFixtureStarted) {
    run(docker, ['compose', '-f', 'tests/ssh-e2e/compose.yml', 'down']);
  }
}
