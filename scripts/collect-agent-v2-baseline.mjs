import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import Ajv2020 from 'ajv/dist/2020.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskSetPath = path.join(workspace, 'evals', 'agent-v2', 'task-set.json');
const taskSetSchemaPath = path.join(workspace, 'evals', 'agent-v2', 'task-set.schema.json');
const baselineSchemaPath = path.join(workspace, 'evals', 'agent-v2', 'baseline.schema.json');
const baselinePath = path.join(workspace, 'evals', 'agent-v2', 'baseline.json');
const toolSchemaPath = path.join(workspace, 'protocol', 'agent', 'v3', 'tool-contract.schema.json');
const v2ContractPath = path.join(workspace, 'protocol', 'agent', 'v2', 'agent-contract.schema.json');

const securityTests = [
  'src/lib/__tests__/agent-terminal-executor.test.ts',
  'src/lib/__tests__/safe-shell-command.test.ts',
  'src/lib/__tests__/agent-command-risk.test.ts',
  'src/lib/__tests__/agent-approval-controller.test.ts',
  'src/lib/__tests__/agent-ui-controller.test.ts',
  'src/lib/__tests__/agent-sessions.test.ts',
  'src/lib/__tests__/terminal-output-buffer.test.ts',
  'src/stores/__tests__/agentPermissionStore.test.ts',
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function validateTaskSet(taskSet) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(readJson(toolSchemaPath));
  const validate = ajv.compile(readJson(taskSetSchemaPath));
  if (!validate(taskSet)) {
    throw new Error(`invalid Agent evaluation task set: ${JSON.stringify(validate.errors)}`);
  }
}

export function assessTasks(taskSet) {
  return taskSet.tasks.map((task) => ({
    taskId: task.id,
    v2Disposition: task.v2Disposition,
    gapCodes: task.v2GapCodes,
  }));
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return 'unavailable';
  return result.stdout.trim();
}

function sourceRevision() {
  const revision = commandOutput('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('unable to resolve the git source revision');
  }
  return revision;
}

function rustInvocation() {
  if (process.platform !== 'win32') {
    return { command: 'cargo', prefixArgs: [], environment: process.env };
  }
  const toolchainConfig = readFileSync(path.join(workspace, 'rust-toolchain.toml'), 'utf8');
  const channel = toolchainConfig.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (!channel) throw new Error('unable to resolve the pinned Rust channel');
  return {
    command: 'cargo',
    prefixArgs: [`+${channel}-x86_64-pc-windows-msvc`],
    environment: process.env,
    note: 'The repository-pinned MSVC toolchain was used for Windows Tauri tests.',
  };
}

function pnpmInvocation() {
  if (process.platform !== 'win32') return { command: 'pnpm', prefixArgs: [] };
  const modulePath = commandOutput('where.exe', ['pnpm'])
    .split(/\r?\n/)
    .filter((candidate) => candidate && candidate !== 'unavailable')
    .map((launcher) => path.join(path.dirname(launcher), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
    .find(existsSync) ?? '';
  if (!existsSync(modulePath)) throw new Error('unable to resolve the pnpm module launcher');
  return { command: process.execPath, prefixArgs: [modulePath] };
}

function runProbe({
  id,
  command,
  args,
  displayCommand = [command, ...args],
  environment = process.env,
  note,
  skip = false,
}) {
  if (skip) {
    return { id, command: displayCommand, status: 'skipped', exitCode: null, durationMs: 0, note };
  }
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const failureNote = result.error ? `Failed to start probe: ${result.error.message}` : undefined;
  return {
    id,
    command: displayCommand,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    durationMs,
    ...(failureNote || note ? { note: failureNote ?? note } : {}),
  };
}

export function validateBaseline(baseline) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(readJson(baselineSchemaPath));
  if (!validate(baseline)) {
    throw new Error(`invalid Agent v2 baseline: ${JSON.stringify(validate.errors)}`);
  }
}

export function buildSummary(probes, assessments) {
  const count = (items, field, value) => items.filter((item) => item[field] === value).length;
  return {
    passedProbes: count(probes, 'status', 'passed'),
    failedProbes: count(probes, 'status', 'failed'),
    skippedProbes: count(probes, 'status', 'skipped'),
    supportedTasks: count(assessments, 'v2Disposition', 'supported'),
    partialTasks: count(assessments, 'v2Disposition', 'partial'),
    unsupportedTasks: count(assessments, 'v2Disposition', 'unsupported'),
  };
}

function main() {
  const write = process.argv.includes('--write');
  const skipRust = process.argv.includes('--skip-rust');
  const taskSetBytes = readFileSync(taskSetPath);
  const taskSet = JSON.parse(taskSetBytes.toString('utf8'));
  validateTaskSet(taskSet);

  const pnpm = pnpmInvocation();
  const rust = skipRust
    ? {
        command: 'cargo',
        prefixArgs: [],
        environment: process.env,
        note: 'Rust probe was explicitly skipped by the caller.',
      }
    : rustInvocation();
  const probes = [
    runProbe({
      id: 'v2-contract',
      command: pnpm.command,
      args: [...pnpm.prefixArgs, 'exec', 'vitest', 'run', 'src/lib/__tests__/agent-contract.test.ts', '--maxWorkers=1'],
      displayCommand: ['pnpm', 'exec', 'vitest', 'run', 'src/lib/__tests__/agent-contract.test.ts', '--maxWorkers=1'],
    }),
    runProbe({
      id: 'v2-security',
      command: pnpm.command,
      args: [...pnpm.prefixArgs, 'exec', 'vitest', 'run', ...securityTests, '--maxWorkers=1'],
      displayCommand: ['pnpm', 'exec', 'vitest', 'run', ...securityTests, '--maxWorkers=1'],
    }),
    runProbe({
      id: 'v2-rust-contract',
      command: rust.command,
      args: [...rust.prefixArgs, 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', 'agent_contract::tests'],
      displayCommand: ['cargo', ...rust.prefixArgs, 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', 'agent_contract::tests'],
      environment: rust.environment,
      note: rust.note,
      skip: skipRust,
    }),
  ];
  const taskAssessments = assessTasks(taskSet);
  const baseline = {
    schemaVersion: 1,
    contractVersion: 2,
    collectorVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceRevision: sourceRevision(),
    v2ContractSha256: createHash('sha256').update(readFileSync(v2ContractPath)).digest('hex'),
    taskSetSha256: createHash('sha256').update(taskSetBytes).digest('hex'),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      rustc: commandOutput('rustc', ['--version']),
    },
    probes,
    taskAssessments,
    summary: buildSummary(probes, taskAssessments),
  };
  validateBaseline(baseline);
  const output = `${JSON.stringify(baseline, null, 2)}\n`;
  if (write) {
    writeFileSync(baselinePath, output, 'utf8');
    process.stdout.write(`Wrote ${path.relative(workspace, baselinePath)}\n`);
  } else {
    process.stdout.write(output);
  }
  if (baseline.summary.failedProbes > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
