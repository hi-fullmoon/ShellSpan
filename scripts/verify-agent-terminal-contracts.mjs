import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const terminalContractFilters = [
  'agent_runtime::native::terminal_execute::tests::',
  'terminal_lease',
];

export function selectedRustTests(output, filter) {
  const tests = [...output.matchAll(/^(.+): test\r?$/gm)].map(match => match[1]);
  assert(tests.length > 0, `No Rust tests matched ${filter}`);
  assert(tests.every(name => name.includes(filter)), 'Rust test listing escaped its filter');
  return tests;
}

export function checkRustTestResult(output, selected) {
  const reports = [...output.matchAll(/^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  assert.equal(reports.length, 1, 'Expected one completed native test suite');
  const [, passed, failed, ignored] = reports[0].map(Number);
  assert(passed > 0, 'Rust contract gate executed no passing tests');
  assert.equal(failed, 0, 'Rust contract tests failed');
  assert.equal(passed + ignored, selected.length, 'Rust execution differs from its selected test list');
  return { passed, ignored };
}

function completion(child, description) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${description} failed (${signal ?? code})`)));
  });
}

async function output(command, args, root) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const done = completion(child, 'Native Rust contract invocation');
  let result = '';
  for await (const chunk of child.stdout) result += chunk;
  try {
    await done;
  } catch (error) {
    process.stderr.write(result);
    throw error;
  }
  return result;
}

export async function verifyAgentTerminalContracts() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const compiler = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked',
    '--lib', '--no-run', '--message-format=json-render-diagnostics'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const done = completion(compiler, 'Native Rust contract build');
  let binary;
  for await (const line of createInterface({ input: compiler.stdout, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const artifact = JSON.parse(line);
    if (artifact.reason === 'compiler-message' && artifact.message.rendered) process.stderr.write(artifact.message.rendered);
    if (artifact.reason === 'compiler-artifact' && artifact.target.name === 'shell_span_lib'
      && artifact.profile.test && artifact.executable) binary = artifact.executable;
  }
  await done;
  assert(binary, 'Cargo did not produce the native Rust contract test executable');
  for (const filter of terminalContractFilters) {
    const selected = selectedRustTests(await output(binary, [filter, '--list'], root), filter);
    const result = await output(binary, [filter, '--test-threads=1'], root);
    try {
      checkRustTestResult(result, selected);
    } catch (error) {
      process.stderr.write(result);
      throw error;
    }
    process.stdout.write(result);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyAgentTerminalContracts().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
