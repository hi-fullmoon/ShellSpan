import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vitest's experimental bench runner can report exit 0 with empty samples after
// a callback assertion fails. A successful process alone is not benchmark evidence.
export function validateBenchmarkReport(report) {
  const benchmarks = report.files.flatMap(file => file.groups.flatMap(group => group.benchmarks));
  assert.equal(benchmarks.length, 3, 'all three AI panel workloads must run');
  for (const result of benchmarks) {
    assert.ok(!result.error, result.name);
    // Vitest's JSON reporter strips raw samples but preserves sampleCount.
    assert.ok(Number.isInteger(result.sampleCount) && result.sampleCount >= 5, `${result.name}: no measured samples`);
    assert.ok(result.samples.every(value => Number.isFinite(value) && value >= 0), result.name);
    for (const field of ['hz', 'mean', 'median']) {
      assert.ok(Number.isFinite(result[field]) && result[field] > 0, `${result.name}: invalid ${field}`);
    }
  }
  return benchmarks.map(({ name, hz, mean, median, sampleCount }) => ({ name, hz, meanMs: mean, medianMs: median, samples: sampleCount }));
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const evidence = await mkdtemp(path.join(tmpdir(), 'shellspan-ai-benchmark-'));
  const reportPath = path.join(evidence, 'benchmark.json');
  async function run(args) {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', ...args], { cwd: root, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, `failed: vitest ${args.join(' ')}`);
  }
  await run(['run', 'scripts/perf/ai-panel-workloads.test.ts', '--maxWorkers=1']);
  await run(['bench', '--run', 'scripts/perf/ai-panel.bench.ts', '--config', 'scripts/perf/vitest.config.ts', '--outputJson', reportPath]);
  console.log('MEASURED_BENCHMARK', JSON.stringify(validateBenchmarkReport(JSON.parse(await readFile(reportPath, 'utf8')))));
  console.log('Benchmark evidence:', reportPath);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
