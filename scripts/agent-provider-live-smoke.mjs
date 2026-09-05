import { spawnSync } from 'node:child_process';
import process from 'node:process';

const providers = [
  ...[
    ['Qwen', 'QWEN', 'qwen'], ['GLM', 'GLM', 'glm'], ['Kimi', 'KIMI', 'kimi'], ['OpenAI', 'OPENAI', 'openai'],
  ].map(([name, prefix, suffix]) => ({ name,
    ready: Boolean(process.env[`SHELLSPAN_LIVE_${prefix}_API_KEY`]),
    missing: `SHELLSPAN_LIVE_${prefix}_API_KEY`,
    test: `llm::tests::live_provider_basic_round_${suffix}`,
  })),
  {
    name: 'MiniMax',
    ready: Boolean(process.env.SHELLSPAN_LIVE_MINIMAX_API_KEY),
    missing: 'SHELLSPAN_LIVE_MINIMAX_API_KEY',
    test: 'llm::tests::live_provider_basic_round_minimax',
  },
  {
    name: 'DeepSeek',
    ready: Boolean(process.env.SHELLSPAN_LIVE_DEEPSEEK_API_KEY),
    missing: 'SHELLSPAN_LIVE_DEEPSEEK_API_KEY',
    test: 'llm::tests::live_provider_basic_round_deepseek',
  },
  {
    name: 'OpenAI-compatible no-reasoning (DeepSeek)',
    ready: Boolean(process.env.SHELLSPAN_LIVE_DEEPSEEK_API_KEY),
    missing: 'SHELLSPAN_LIVE_DEEPSEEK_API_KEY',
    test: 'llm::tests::live_provider_basic_round_deepseek_no_reasoning',
  },
  {
    name: 'Generic OpenAI-compatible',
    ready: Boolean(
      process.env.SHELLSPAN_LIVE_COMPATIBLE_BASE_URL
      && process.env.SHELLSPAN_LIVE_COMPATIBLE_MODEL,
    ),
    missing: 'SHELLSPAN_LIVE_COMPATIBLE_BASE_URL and SHELLSPAN_LIVE_COMPATIBLE_MODEL',
    test: 'llm::tests::live_provider_basic_round_compatible',
  },
];

let executed = 0;
let failed = 0;
for (const provider of providers) {
  if (!provider.ready) {
    process.stdout.write(`SKIP ${provider.name}: ${provider.missing} is not configured.\n`);
    continue;
  }
  process.stdout.write(`RUN ${provider.name}: live answer/reasoning/usage smoke as supported.\n`);
  executed += 1;
  const result = spawnSync('cargo', [
    'test',
    '--manifest-path', 'src-tauri/Cargo.toml',
    provider.test,
    '--', '--ignored', '--exact', '--nocapture',
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    failed += 1;
    process.stderr.write(`FAIL ${provider.name}: smoke exited ${result.status ?? 'without an exit code'}.\n`);
  }
}

process.stdout.write(`Live provider smoke complete: ${executed} executed (${executed - failed} passed, ${failed} failed), ${providers.length - executed} skipped.\n`);
if (failed) process.exitCode = 1;
