import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  assertBenchmarkShape,
  assertCargoTestsRan,
  assertCommandSucceeded,
  parseBenchmark,
  parseRustHost,
  verifyBenchmarkRound,
} from './verify-terminal-broker-windows.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = 'cargo';
const benchmarkBytes = 2_097_152;
const benchmarkRepetitions = 5;
const benchmarkSessions = 4;

export const supportedRustHosts = Object.freeze({
  x64: 'x86_64-apple-darwin',
  arm64: 'aarch64-apple-darwin',
});

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function render(command, args) {
  return [command, ...args].join(' ');
}

function run(command, args) {
  const rendered = render(command, args);
  console.log(`\n> ${rendered}`);
  const result = execute(command, args);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assertCommandSucceeded(result, rendered);
  return result.stdout;
}

function cargoTest(filter, testArgs = [], exactTest = null) {
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
  ]);
  assertCargoTestsRan(output, filter, exactTest);
}

function cargoExampleTest(example) {
  const output = run(cargo, [
    'test',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--example',
    example,
    '--',
    '--nocapture',
  ]);
  assertCargoTestsRan(output, `--example ${example}`);
}

function benchmark(broker) {
  const args = [
    'run',
    '--locked',
    '--release',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--example',
    'terminal_transport_baseline',
    '--',
    '--bytes',
    String(benchmarkBytes),
    '--repetitions',
    String(benchmarkRepetitions),
    '--sessions',
    String(benchmarkSessions),
  ];
  if (broker) args.push('--broker');
  const result = parseBenchmark(run(cargo, args));
  assertBenchmarkShape(result, broker);
  return result;
}

export function main() {
  if (process.platform !== 'darwin') {
    console.error(
      `MISSING: native macOS PTY execution is required; current platform is ${process.platform}/${process.arch}.`,
    );
    process.exit(2);
  }

  const expectedRustHost = supportedRustHosts[process.arch];
  if (!expectedRustHost) {
    console.error(
      `MISSING: the accepted macOS lane requires x64 or arm64; current architecture is ${process.arch}.`,
    );
    process.exit(2);
  }
  const rustc = execute('rustc', ['-vV']);
  const actualRustHost = rustc.error || rustc.status !== 0 ? null : parseRustHost(rustc.stdout);
  if (actualRustHost !== expectedRustHost) {
    console.error(
      `MISSING: ${expectedRustHost} Rust host toolchain is required for macOS ${process.arch}; received ${actualRustHost ?? 'none'}.`,
    );
    process.exit(2);
  }
  process.stdout.write(rustc.stdout);

  const missingShells = ['/bin/bash', '/bin/zsh'].filter((shell) => !existsSync(shell));
  if (missingShells.length > 0) {
    console.error(`MISSING: required native macOS shells: ${missingShells.join(', ')}.`);
    process.exit(2);
  }

  run(cargo, ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--all', '--', '--check']);
  run(cargo, ['check', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets']);
  cargoExampleTest('terminal_transport_baseline');
  cargoTest('terminal_broker::tests');
  cargoTest('agent_runtime::native::terminal_execute::tests');
  cargoTest('terminal_integration::tests');
  cargoTest('agent_runtime::native::terminal_lease::tests');
  cargoTest('agent_runtime::native::terminal_interactive::tests');
  cargoTest('agent_runtime::native::runtime::tests');
  cargoTest('agent_runtime::recovery::tests');
  cargoTest('session::tests');

  for (const testName of [
    'terminal_broker::tests::macos_bash_pty_broker_preserves_raw_bytes_input_order_and_resize',
    'terminal_broker::tests::macos_zsh_pty_broker_preserves_raw_bytes_input_order_and_resize',
    'terminal_integration::tests::macos_native_bash_visible_commands_preserve_shell_state_and_raw_display',
    'terminal_integration::tests::macos_native_zsh_visible_commands_preserve_shell_state_and_raw_display',
  ]) {
    cargoTest(testName, ['--exact'], testName);
  }
  for (const testName of [
    'agent_runtime::native::terminal_interactive::tests::macos_bash_interactive_terminal_operation',
    'agent_runtime::native::terminal_interactive::tests::macos_zsh_interactive_terminal_operation',
  ]) {
    cargoTest(testName, ['--ignored', '--exact'], testName);
  }

  cargoTest('agent_runtime::native::process::tests');
  cargoTest('commands::tests');
  run(cargo, [
    'test',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--',
    '--test-threads=1',
  ]);

  for (let round = 1; round <= 2; round += 1) {
    console.log(`\nmacOS broker benchmark round ${round}`);
    const control = benchmark(false);
    const broker = benchmark(true);
    verifyBenchmarkRound(round, control, broker, 'macOS');
  }

  console.log('macOS Phase 2/3/5/6 native PTY and rollout acceptance: PASS.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
