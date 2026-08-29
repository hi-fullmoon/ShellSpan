import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(workspace, 'src-tauri', 'Cargo.toml');
const toolsModel = process.env.TERMBRIDGE_M6_OLLAMA_TOOLS_MODEL ?? 'qwen3:0.6b';
const noToolsModel = process.env.TERMBRIDGE_M6_OLLAMA_NO_TOOLS_MODEL ?? 'smollm:135m';
const ollamaBaseUrl = process.env.TERMBRIDGE_M6_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function requireLocalModel(model) {
  const result = spawnSync('ollama', ['show', model], {
    cwd: workspace,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`Ollama model ${model} is not installed; pull it explicitly before live acceptance`);
  }
}

function cargoLiveTest(testName, env) {
  run('cargo', [
    'test', '--manifest-path', manifest, '--locked', testName,
    '--', '--ignored', '--nocapture', '--test-threads=1',
  ], env);
}

requireLocalModel(toolsModel);
requireLocalModel(noToolsModel);

const ollamaEnv = {
  ...process.env,
  TERMBRIDGE_M6_OLLAMA_LIVE: '1',
  TERMBRIDGE_M6_OLLAMA_BASE_URL: ollamaBaseUrl,
  TERMBRIDGE_M6_OLLAMA_TOOLS_MODEL: toolsModel,
  TERMBRIDGE_M6_OLLAMA_NO_TOOLS_MODEL: noToolsModel,
};
cargoLiveTest('m6_live_ollama_tools_acceptance', ollamaEnv);
cargoLiveTest('m6_live_ollama_no_tools_falls_back_without_tool_events', ollamaEnv);
cargoLiveTest('m6_live_chat_completions_tool_acceptance', {
  ...ollamaEnv,
  TERMBRIDGE_M6_COMPATIBLE_LIVE: '1',
  TERMBRIDGE_M6_COMPATIBLE_BASE_URL: `${ollamaBaseUrl.replace(/\/$/, '')}/v1`,
  TERMBRIDGE_M6_COMPATIBLE_MODEL: toolsModel,
});

if (process.env.TERMBRIDGE_M6_OPENAI_LIVE === '1') {
  cargoLiveTest('m6_live_openai_responses_tool_acceptance', process.env);
} else {
  process.stdout.write('SKIP OpenAI Responses live acceptance: TERMBRIDGE_M6_OPENAI_LIVE is not 1.\n');
  if (process.argv.includes('--require-openai')) process.exitCode = 2;
}
