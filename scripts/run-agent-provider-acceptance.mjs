import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(workspace, 'src-tauri', 'Cargo.toml');
const toolsModel = process.env.TERMBRIDGE_M6_OLLAMA_TOOLS_MODEL ?? 'qwen3:0.6b';
const noToolsModel = process.env.TERMBRIDGE_M6_OLLAMA_NO_TOOLS_MODEL ?? 'smollm:135m';
const ollamaBaseUrl = process.env.TERMBRIDGE_M6_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const minimaxOnly = process.argv.includes('--minimax-only');
export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimaxi.com';
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7';

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function requireLocalModel(model) {
  const result = spawnSync('ollama', ['show', model], {
    cwd: workspace,
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
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

export function validatedMiniMaxBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TERMBRIDGE_M6_MINIMAX_BASE_URL must be a valid MiniMax HTTPS URL');
  }
  const officialHost = url.hostname === 'api.minimaxi.com' || url.hostname === 'api.minimax.io';
  const supportedPath = url.pathname === '/' || url.pathname === '/v1' || url.pathname === '/v1/';
  if (
    url.protocol !== 'https:'
    || !officialHost
    || !supportedPath
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(
      'TERMBRIDGE_M6_MINIMAX_BASE_URL must use an official MiniMax service root',
    );
  }
  return value.replace(/\/$/, '');
}

export function buildMiniMaxLiveEnv(sourceEnv) {
  const apiKey = sourceEnv.MINIMAX_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error(
      'MINIMAX_API_KEY is required for MiniMax live acceptance; set it only in the current process',
    );
  }
  const model = sourceEnv.TERMBRIDGE_M6_MINIMAX_MODEL ?? DEFAULT_MINIMAX_MODEL;
  if (!model.trim()) {
    throw new Error('TERMBRIDGE_M6_MINIMAX_MODEL must not be empty');
  }
  const env = {
    ...sourceEnv,
    TERMBRIDGE_M6_MINIMAX_LIVE: '1',
    TERMBRIDGE_M6_MINIMAX_BASE_URL: validatedMiniMaxBaseUrl(
      sourceEnv.TERMBRIDGE_M6_MINIMAX_BASE_URL ?? DEFAULT_MINIMAX_BASE_URL,
    ),
    TERMBRIDGE_M6_MINIMAX_MODEL: model,
    MINIMAX_API_KEY: apiKey,
  };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

function runMiniMaxLiveAcceptance() {
  const env = buildMiniMaxLiveEnv(process.env);
  cargoLiveTest('m6_live_minimax_chat_completions_tool_acceptance', env);
}

function main() {
  if (minimaxOnly) {
    runMiniMaxLiveAcceptance();
    return;
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

  if (process.env.TERMBRIDGE_M6_MINIMAX_LIVE === '1') {
    runMiniMaxLiveAcceptance();
  } else {
    process.stdout.write('SKIP MiniMax live acceptance: TERMBRIDGE_M6_MINIMAX_LIVE is not 1.\n');
    if (process.argv.includes('--require-minimax')) process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
