import { spawnSync } from 'node:child_process';
const gates = [
  ['cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--locked', 'image_', '--', '--test-threads=1']],
  ['pnpm', ['exec', 'vitest', 'run', 'src/components/ai/__tests__/image-draft.test.tsx', 'src/lib/ai/__tests__/session-adapters.test.ts', 'src/components/ai/__tests__/ai-workspace-controller.test.tsx', 'src/lib/ai/__tests__/conversation-projection.test.ts', 'src/components/ai/__tests__/system-prompt-snapshots.test.tsx', '--maxWorkers=1']],
  ['node', ['scripts/ai-runtime-stage6c-browser.mjs']],
];
for (const [command, args] of gates) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
