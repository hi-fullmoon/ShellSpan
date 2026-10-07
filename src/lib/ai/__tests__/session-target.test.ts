import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeCreationProjectRoot } from '../session-target';
import type { AiCreateSessionInput } from '../session-adapter';

const root = path.resolve(import.meta.dirname, '../../../..');
describe('Frozen project target intent', () => {
  it.each(['requestApproval', 'scopedAutopilot', 'operator'] as const)('freezes workspace root without changing %s', permissionMode => {
    const input: AiCreateSessionInput = {kind:'agent', request:{sessionId:'new-session',taskId:'new-task',goal:'Inspect project',target:{kind:'local',targetId:'local',sessionId:'terminal'},sandboxPolicy:'workspace',executionSurface:'direct',permissionMode}};
    const frozen = freezeCreationProjectRoot(input, root);
    expect(frozen.request.target?.cwd).toBe(root);
    expect(frozen.request.permissionMode).toBe(permissionMode);
    expect(frozen.request.sandboxPolicy).toBe('workspace');
    expect(input.request.target?.cwd).toBeUndefined();
    expect(() => freezeCreationProjectRoot(input, null)).toThrow('sandboxWorkspaceMissing:');
  });
  it('keeps explicitly selected account access without a project root', () => {
    const input: AiCreateSessionInput = {kind:'agent',request:{sessionId:'new-session',taskId:'new-task',goal:'Inspect host',target:{kind:'local',targetId:'local',sessionId:'terminal'},sandboxPolicy:'host',executionSurface:'direct',permissionMode:'requestApproval'}};
    expect(freezeCreationProjectRoot(input, null)).toBe(input);
  });
});
