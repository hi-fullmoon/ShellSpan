import { spawnSync } from 'node:child_process';
const gates = [
  ['cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--locked', 'file_reference_']],
  ['pnpm', ['exec', 'vitest', 'run', 'src/lib/ai/__tests__/file-reference-grammar.test.ts', 'src/components/ai/__tests__/ai-file-completion.test.tsx', 'src/components/ai/__tests__/ai-workspace-controller.test.tsx', 'src/lib/ipc/__tests__/tauri-file-references.test.ts', 'src/lib/ai/__tests__/session-adapters.test.ts', '--maxWorkers=1']],
  ['node', ['scripts/ai-runtime-stage6d-sftp.mjs']],
  ['node', ['scripts/ai-runtime-stage6d-browser.mjs']],
];
for (const [command, args] of gates) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
