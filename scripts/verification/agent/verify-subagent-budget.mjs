import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function completion(child, description) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${description} failed (${signal ?? code})`));
    });
  });
}

// Compilation belongs to the explicit native gate, outside Vitest's hook/test
// deadlines. Cargo's standard JSON artifact stream identifies the real binary
// on both macOS and Windows without guessing a target-directory hash or suffix.
async function main() {
  const compiler = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml',
    '--all-features', '--locked', '--lib', '--no-run', '--message-format=json-render-diagnostics'], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const compiled = completion(compiler, 'Native budget test build');
  let binary;
  const artifacts = (async () => {
    for await (const line of createInterface({ input: compiler.stdout, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const artifact = JSON.parse(line);
      if (artifact.reason === 'compiler-artifact' && artifact.target.name === 'shell_span_lib'
        && artifact.profile.test && artifact.executable) binary = artifact.executable;
    }
  })();
  await Promise.all([compiled, artifacts]);
  if (!binary) throw new Error('Cargo did not produce the native budget test executable');
  const tests = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run', '--config', 'vitest.native.config.ts'], {
    cwd: root,
    env: { ...process.env, SHELLSPAN_CHILD_CONTINUATION_TEST_BINARY: binary },
    stdio: 'inherit',
  });
  await completion(tests, 'Native budget UI regression');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
