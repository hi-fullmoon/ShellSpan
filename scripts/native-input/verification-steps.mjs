import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const repositoryRoot = resolve(import.meta.dirname, '../..');
export const cargoLibraryTests = ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib'];
export const terminalFrontendTests = [
  'src/components/terminal/__tests__/agent-terminal-command-feedback.test.ts',
  'src/components/terminal/__tests__/terminal-controller-layer.test.tsx',
  'src/components/terminal/__tests__/terminal-pane.test.tsx',
  'src/components/terminal/__tests__/terminal-registry.test.ts',
  'scripts/__tests__/terminal-protocol-contract.test.mjs',
];

export async function verifyRuntimeComponents(run, environment = {}) {
  const filters = [
    ['state', 'terminal_command::tests::'],
    ['broker', 'terminal_broker::tests::'],
    ['executor', 'agent_runtime::native::terminal_execute::tests::'],
    ['lease', 'agent_runtime::native::terminal_lease::tests::'],
  ];
  for (const [name, filter] of filters) {
    await run(name, 'cargo', [...cargoLibraryTests, filter, '--', '--test-threads=1'], environment);
  }
}

export function runCapturedStep(command, args, { logPath, environment = {}, maxBuffer = 32 * 1024 * 1024 }) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, SHELLSPAN_NATIVE_BUILD_ROOT: 'artifacts/tests', ...environment },
    encoding: 'utf8',
    maxBuffer,
  });
  writeFileSync(logPath, `${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`);
  return result;
}
