import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const temp = await mkdtemp(join(tmpdir(), 'shellspan-skills-bridge-'));
const ready = join(temp, 'ready.json');
const bridge = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--locked', 'agent_runtime::runtime::tests::skill_bridge_tests::skill_controller_bridge', '--', '--exact', '--ignored', '--nocapture'], { stdio: 'inherit', env: { ...process.env, SHELLSPAN_SKILLS_BRIDGE_READY: ready } });
const completion = new Promise((resolve, reject) => { bridge.once('error', reject); bridge.once('exit', resolve); });
try {
  let state;
  const deadline = Date.now() + 180000;
  while (!state && Date.now() < deadline) {
    if (bridge.exitCode !== null) throw new Error(`Rust bridge exited ${bridge.exitCode}`);
    try { state = JSON.parse(await readFile(ready, 'utf8')); } catch { await delay(50); }
  }
  if (!state) throw new Error('Rust bridge startup timed out');
  const client = spawn('pnpm', ['exec', 'vitest', 'run', 'src/components/ai/__tests__/ai-skills-runtime-bridge.test.tsx', '--maxWorkers=1'], { stdio: 'inherit', env: { ...process.env, SHELLSPAN_SKILLS_BRIDGE: JSON.stringify(state) } });
  const status = await new Promise((resolve, reject) => { client.once('error', reject); client.once('exit', resolve); });
  await fetch(state.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: '__stop', args: {} }) });
  const rustStatus = await completion;
  if (status !== 0 || rustStatus !== 0) throw new Error(`controller=${status}; runtime=${rustStatus}`);
} finally {
  if (bridge.exitCode === null) { bridge.kill('SIGTERM'); await completion; }
  await rm(temp, { recursive: true, force: true });
}
