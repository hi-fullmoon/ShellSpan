import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const runtimeRoot = path.join(repositoryRoot, 'src-tauri/src/agent_runtime');
const nativeRoot = path.join(runtimeRoot, 'native');

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(candidate);
      return entry.isFile() && entry.name.endsWith('.rs') ? [candidate] : [];
    }),
  );
  return nested.flat();
}

async function combinedSource(root) {
  const files = await sourceFiles(root);
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}

describe('single Agent Runtime architecture', () => {
  it('keeps manual test pages out of the application bootstrap', async () => {
    const main = await readFile(path.join(repositoryRoot, 'src/main.tsx'), 'utf8');
    const { importedFiles } = ts.preProcessFile(main, true, true);
    const testImports = importedFiles
      .map(({ fileName }) => fileName)
      .filter(fileName => /(?:^|\/)(?:tests|__tests__)\//.test(fileName));
    expect(testImports).toEqual([]);
  });

  it('rejects unscheduled native acceptance before launching an application', () => {
    const environment = { ...process.env };
    delete environment.SHELLSPAN_ALLOW_FOREGROUND_TESTS;
    delete environment.SHELLSPAN_DATA_DIR;
    const result = spawnSync(process.execPath, [
      path.join(repositoryRoot, 'scripts/verification/agent/verify-ai-session-stream.mjs'),
      '--data-scope', 'com.shellspan.validation.storage-check', '--no-model',
    ], { cwd: repositoryRoot, env: environment, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Native App acceptance is disabled by default');
  });

  it('contains no dead-code suppression or legacy runtime control plane', async () => {
    const runtime = await combinedSource(runtimeRoot);
    expect(runtime).not.toMatch(/allow\s*\(\s*dead_code\s*\)/);
    for (const forbidden of [
      ['AgentTaskStore', 'Native'].join(''),
      ['TaskRuntimeState', 'Native'].join(''),
      ['FleetRuntime', 'Native'].join(''),
      ['register', 'fleet'].join('_'),
      ['register', 'sub', 'agent'].join('_'),
      ['submit', 'fleet', 'verification'].join('_'),
      ['execute', 'fleet', 'tool'].join('_'),
      ['agent', 'runtime', 'v3'].join('_'),
      ['agent', 'contract', 'v3'].join('_'),
    ]) {
      expect(runtime).not.toContain(forbidden);
    }
  });

  it('keeps Native limited to the registered OS-effect tools', async () => {
    const entries = await readdir(nativeRoot);
    expect(entries).not.toEqual(
      expect.arrayContaining(['context.rs', 'fleet.rs', 'persistence.rs', 'result.rs']),
    );
    const native = await combinedSource(nativeRoot);
    expect(native).not.toContain('update_plan');
    expect(native).not.toMatch(/struct\s+\w*(?:SubAgent|Fleet)|fn\s+\w*(?:sub_agent|fleet)/);

    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, 'protocol/agent/runtime/built-in-tools.json'), 'utf8'),
    );
    expect(manifest.tools.map(({ name }) => name)).toEqual([
      'inspect_host',
      'inspect_service',
      'query_logs',
      'diagnose_endpoint',
      'exec_command',
      'terminal_execute',
      'probe_http',
      'read_terminal',
      'write_terminal_input',
      'wait_terminal',
      'inspect_vim_buffer',
      'insert_vim_text',
      'save_vim_buffer',
      'close_vim_editor',
      'write_stdin',
      'wait_process',
      'kill_process',
      'read_file',
      'list_directory',
      'search_text',
      'write_file',
      'edit_file',
      'apply_patch',
      'trash_file',
      'transfer_file',
    ]);
  });

  it('routes update_plan through the primary Session event pipeline', async () => {
    const modelTools = await readFile(path.join(runtimeRoot, 'model_tools.rs'), 'utf8');
    const pipeline = await readFile(path.join(runtimeRoot, 'tool_pipeline.rs'), 'utf8');
    const session = await readFile(path.join(runtimeRoot, 'session.rs'), 'utf8');
    expect(modelTools).toContain('name: "update_plan"');
    expect(pipeline).toContain('AgentSessionEventPayload::TaskPlan');
    expect(pipeline).toContain('sessionRuntimeAuthorized');
    expect(session).toContain('Payload::TaskPlan');
  });

  it('keeps the native manifest valid against the canonical schemas', async () => {
    const protocolRoot = path.join(repositoryRoot, 'protocol/agent/runtime');
    const [contractSchema, manifestSchema, manifest] = await Promise.all(
      ['tool-contract.schema.json', 'tool-manifest.schema.json', 'built-in-tools.json'].map(
        async (name) => JSON.parse(await readFile(path.join(protocolRoot, name), 'utf8')),
      ),
    );
    const validator = new Ajv2020({ allErrors: true, strict: true });
    validator.addSchema(contractSchema);
    expect(validator.validate(manifestSchema, manifest), validator.errorsText()).toBe(true);
  });

  it('distinguishes native tools, model facades, and synthetic session-runtime tools without overlap', async () => {
    const protocolRoot = path.join(repositoryRoot, 'protocol/agent/runtime');
    const [contractSchema, builtInManifest, syntheticSchema, syntheticManifest, nativeRegistry, toolPipeline] = await Promise.all([
      readFile(path.join(protocolRoot, 'tool-contract.schema.json'), 'utf8').then(JSON.parse),
      readFile(path.join(protocolRoot, 'built-in-tools.json'), 'utf8').then(JSON.parse),
      readFile(path.join(protocolRoot, 'synthetic-tools.schema.json'), 'utf8').then(JSON.parse),
      readFile(path.join(protocolRoot, 'synthetic-tools.json'), 'utf8').then(JSON.parse),
      readFile(path.join(nativeRoot, 'registry.rs'), 'utf8'),
      readFile(path.join(runtimeRoot, 'tool_pipeline.rs'), 'utf8'),
    ]);

    const validator = new Ajv2020({ allErrors: true, strict: true });
    validator.addSchema(contractSchema);
    expect(validator.validate(syntheticSchema, syntheticManifest), validator.errorsText()).toBe(true);

    const nativeNames = new Set(builtInManifest.tools.map(({ name }) => name));
    const syntheticNames = new Set(syntheticManifest.syntheticTools.map(({ name }) => name));
    const facadeNames = new Set(syntheticManifest.modelFacades.map(({ name }) => name));

    expect(syntheticNames.size).toBe(syntheticManifest.syntheticTools.length);
    expect(facadeNames.size).toBe(syntheticManifest.modelFacades.length);
    expect([...nativeNames].filter((name) => syntheticNames.has(name))).toEqual([]);
    expect([...nativeNames].filter((name) => facadeNames.has(name))).toEqual([]);
    expect([...syntheticNames].filter((name) => facadeNames.has(name))).toEqual([]);

    for (const facade of syntheticManifest.modelFacades) {
      for (const targetTool of facade.nativeTools) {
        expect(nativeNames.has(targetTool)).toBe(true);
      }
    }

    for (const name of syntheticNames) {
      expect(nativeRegistry).not.toContain(`"${name}"`);
    }

    const orchBlock = toolPipeline
      .split('ORCHESTRATION_TOOL_NAMES: &[&str] = &[')[1]
      .split('];')[0];
    const orchestrationTools = [...orchBlock.matchAll(/"([^"]+)"/g)].map(([, name]) => name);
    expect(orchestrationTools.length).toBeGreaterThan(0);
    const byName = new Map(syntheticManifest.syntheticTools.map((entry) => [entry.name, entry]));
    for (const name of orchestrationTools) {
      expect(
        ['subagentOrchestration', 'fleetOrchestration'],
      ).toContain(byName.get(name)?.category);
    }
  });
});
