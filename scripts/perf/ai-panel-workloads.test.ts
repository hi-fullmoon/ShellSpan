import { describe, expect, it } from 'vitest';
import { restoreConversation, reviseNodes, reprojectStreaming } from './ai-panel-workloads';

describe('benchmark workload preflight (ordinary tests fail closed)', () => {
  it('retains all 5,000 messages, 2,500 Turn rows, and unique keys', () => {
    const nodes = restoreConversation();
    expect(nodes.filter(node => node.kind === 'userMessage')).toHaveLength(2_500);
    expect(nodes.filter(node => node.kind === 'assistantMessage')).toHaveLength(2_500);
    expect(nodes.filter(node => node.kind === 'turnProcess')).toHaveLength(2_500);
    expect(new Set(nodes.map(node => node.key)).size).toBe(7_500);
  });
  it('computes every node revision', () => expect(reviseNodes).not.toThrow());
  it('performs all 20 streaming revisions with the final assistant intact', () => expect(reprojectStreaming).not.toThrow());
});
