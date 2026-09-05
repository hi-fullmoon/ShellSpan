import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
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

  it('keeps Native limited to the nine OS-effect tools', async () => {
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
      'exec_command',
      'write_stdin',
      'wait_process',
      'kill_process',
      'read_file',
      'list_directory',
      'search_text',
      'apply_patch',
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
});
