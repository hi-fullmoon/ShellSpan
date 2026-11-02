// P1 acceptance only. No application/native production route is enabled here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const output = path.join(root, '.artifacts/tests/native-input-p0/p1-validation');
await mkdir(output, { recursive: true });
const steps = [];
async function run(name, command, args, environment = {}) {
  const logPath = path.join(output, `${name}.log`);
  const log = createWriteStream(logPath);
  const started = Date.now();
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => log.end(resolve));
  steps.push({ name, command, args, exitCode: code, elapsedMs: Date.now() - started, logPath });
  assert.equal(code, 0, `${name} failed; inspect ${logPath}`);
}
async function validateCaptures() {
  const schema = JSON.parse(await readFile('protocol/agent/runtime/native-input.schema.json', 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('control.bin')) files.push(file);
    }
  }
  await walk('.artifacts/tests/native-input-p0/p1-evidence');
  const counts = {};
  for (const file of files) {
    let count = 0;
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      assert(line.length > 0, `empty frame: ${file}`);
      assert(Buffer.byteLength(line) + 1 <= 131072, `oversized frame: ${file}`);
      const value = JSON.parse(line);
      assert(validate(value), `${file}: ${validate.errors?.map(error => error.message).join('; ')}`);
      count++;
    }
    const bytes = await readFile(file);
    assert(bytes.length > 0 && bytes.at(-1) === 10, `incomplete recorded control frame: ${file}`);
    counts[file] = { frames: count, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  assert(files.length >= 12, 'real native acceptance captures are missing');
  await writeFile(path.join(output, 'schema-captures.json'), JSON.stringify(counts, null, 2));
  return counts;
}
if (process.argv.includes('--schema-only')) {
  const captures = await validateCaptures();
  console.log(`NIP actual-capture schemas passed (${Object.keys(captures).length} files)`);
  process.exit(0);
}
let failure;
try {
  await run('producer-build', 'python3', ['scripts/native-input-p1/build.py']);
  const cargo = ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib'];
  for (const [name, filter] of [['state', 'terminal_command::tests::'], ['broker', 'terminal_broker::tests::'],
    ['executor', 'agent_runtime::native::terminal_execute::tests::'], ['lease', 'agent_runtime::native::terminal_lease::tests::']]) {
    await run(name, 'cargo', [...cargo, filter, '--', '--test-threads=1'], { SHELLSPAN_P1_MATRIX_PATH: path.join(output, 'state-matrix.json') });
  }
  await run('native', 'cargo', [...cargo, 'terminal_native_protocol::native_protocol_real_', '--', '--ignored', '--test-threads=1']);
  await validateCaptures();
  await run('display', 'node', ['src/lib/terminal/__tests__/native-input-display-binding.browser.mjs']);
  await run('frontend', 'pnpm', ['exec', 'vitest', 'run', 'src/components/terminal/__tests__/agent-terminal-command-feedback.test.ts',
    'src/components/terminal/__tests__/terminal-controller-layer.test.tsx', 'src/components/terminal/__tests__/terminal-pane.test.tsx',
    'src/components/terminal/__tests__/terminal-registry.test.ts', 'scripts/__tests__/terminal-protocol-contract.test.mjs']);
} catch (error) { failure = String(error); }
await writeFile(path.join(output, 'summary.json'), JSON.stringify({ phase: 'P1', scope: 'macOS arm64; pinned GNU Bash 5.3 / Readline 8.3.6; native production routing disabled', result: failure ? 'FAIL' : 'PASS', steps, failure }, null, 2));
if (failure) throw Error(failure);
console.log(`P1 acceptance passed (${steps.length} steps); evidence: ${output}`);
