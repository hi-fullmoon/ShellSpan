import { describe, expect, it } from 'vitest';
import { createOperationId, findOperationId } from '@/lib/operation-id';

describe('operation ids', () => {
  it('finds transfer and AI ids in IPC argument shapes', () => {
    expect(findOperationId({ request: { operationId: 'transfer-123' } })).toBe('transfer-123');
    expect(findOperationId({ request: { requestId: 'ai-request-9' } })).toBe('ai-request-9');
    expect(findOperationId({ operationId: 'forward-4' })).toBe('forward-4');
  });

  it('rejects ids that could inject log lines', () => {
    expect(findOperationId({ operationId: 'safe\nforged-log' })).toBeUndefined();
  });

  it('creates a namespaced id', () => {
    expect(createOperationId('List Remote Directory')).toMatch(/^list-remote-directory-/);
  });
});
