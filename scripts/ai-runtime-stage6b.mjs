import { spawnSync } from 'node:child_process';
const gates = [
  ['cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--locked', 'skill_']],
  ['pnpm', ['exec', 'vitest', 'run', 'src/components/ai/__tests__/ai-skills-menu.test.tsx', 'src/components/ai/__tests__/ai-workspace-controller.test.tsx', 'src/lib/ai/__tests__/skill-projection.test.ts', 'src/lib/ai/__tests__/session-adapters.test.ts', 'src/lib/ai/__tests__/composer-machine.test.ts', '--maxWorkers=1']],
  ['node', ['scripts/ai-runtime-stage6b-controller.mjs']],
  ['node', ['scripts/ai-runtime-stage6b-sftp.mjs']],
  ['node', ['scripts/ai-runtime-stage6b-visual.mjs']],
];
for (const [command, args] of gates) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
