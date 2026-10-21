import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertCargoTestsRan, assertCommandSucceeded } from './verify-terminal-broker-windows.mjs';

assert.equal(process.platform, 'darwin', 'Native Bash diagnostics require macOS');
const root = path.resolve(import.meta.dirname, '..');
const rounds = Number(process.argv[2] ?? 20);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 100, 'Expected 1..100 rounds');

const build = spawnSync('cargo', [
  'test', '--manifest-path', 'src-tauri/Cargo.toml', '--all-features', '--lib',
  '--no-run', '--locked', '--message-format=json',
], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
if (build.error) throw build.error;
assert.equal(build.status, 0, 'Failed to compile native tests');
const artifacts = build.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const binaries = artifacts.filter(event => event.reason === 'compiler-artifact'
  && event.profile?.test && event.target?.name === 'shell_span_lib' && event.executable);
assert.equal(binaries.length, 1, 'Expected exactly one native library test executable');

function runTest(exactTest) {
  const run = spawnSync(binaries[0].executable, [
    exactTest,
    '--exact', '--nocapture', '--test-threads=1',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, SHELLSPAN_BASH_FAILURE_DIAGNOSTICS: '1' } });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  assertCommandSucceeded(run, exactTest);
  assertCargoTestsRan(run.stdout, exactTest, exactTest);
}
runTest('local_terminal_input::tests::macos_interrupt_routing_preserves_native_tty_controls');
for (let round = 0; round < rounds; round++) {
  runTest('terminal_integration::tests::native_bash_concurrent_prompt_helpers_preserve_job_control');
}
console.log(`Native Bash concurrency checks passed ${rounds} consecutive rounds`);
