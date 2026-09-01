import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assessTasks,
  buildSummary,
  validateBaseline,
  validateTaskSet,
} from '../collect-agent-v2-baseline.mjs';

const workspace = path.resolve(import.meta.dirname, '..', '..');
const taskSetBytes = readFileSync(path.join(workspace, 'evals', 'agent-v2', 'task-set.json'));
const taskSet = JSON.parse(taskSetBytes.toString('utf8'));
const baseline = JSON.parse(
  readFileSync(path.join(workspace, 'evals', 'agent-v2', 'baseline.json'), 'utf8'),
);

describe('Agent v2 baseline collector', () => {
  it('validates seven representative tasks covering all v3 built-ins', () => {
    expect(() => validateTaskSet(taskSet)).not.toThrow();
    expect(taskSet.tasks).toHaveLength(7);
    expect(new Set(taskSet.tasks.flatMap((task) => task.v3Tools))).toEqual(
      new Set([
        'exec_command',
        'write_stdin',
        'wait_process',
        'kill_process',
        'read_file',
        'list_directory',
        'search_text',
        'apply_patch',
        'transfer_file',
        'host_snapshot',
        'ask_user',
        'update_plan',
      ]),
    );
  });

  it('rejects unknown task fields', () => {
    const invalid = structuredClone(taskSet);
    invalid.tasks[0].unexpected = true;
    expect(() => validateTaskSet(invalid)).toThrow('invalid Agent evaluation task set');
  });

  it('summarizes the frozen v2 capability baseline', () => {
    const assessments = assessTasks(taskSet);
    expect(buildSummary([], assessments)).toEqual({
      passedProbes: 0,
      failedProbes: 0,
      skippedProbes: 0,
      supportedTasks: 2,
      partialTasks: 2,
      unsupportedTasks: 3,
    });
  });

  it('keeps the checked-in baseline machine-readable', () => {
    expect(() => validateBaseline(baseline)).not.toThrow();
    expect(baseline.taskSetSha256).toBe(createHash('sha256').update(taskSetBytes).digest('hex'));
    expect(baseline.v2ContractSha256).toBe(
      createHash('sha256')
        .update(readFileSync(path.join(workspace, 'protocol', 'agent', 'v2', 'agent-contract.schema.json')))
        .digest('hex'),
    );
  });
});
