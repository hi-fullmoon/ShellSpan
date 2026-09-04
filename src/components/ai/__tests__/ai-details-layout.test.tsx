import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiArtifactDetails } from '@/components/ai/workspace/ai-artifact-details';
import { AiToolDetails } from '@/components/ai/workspace/ai-tool-details';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const longValue = 'unbroken-payload-'.repeat(100);
const baseNode = {
  sourceKind: 'agent', sessionId: 'details-layout', turnId: 'turn-1', stepId: 'step-1',
  firstSeq: 1, lastSeq: 2, timestamp: '2026-09-04T00:00:00.000Z',
} as const;

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('AI details content sizing', () => {
  it('overrides the primitive inline fit-content minimum for long tool payloads', () => {
    const node: AiConversationNodeOf<'tool'> = {
      ...baseNode,
      kind: 'tool', key: 'tool:long-command', callId: 'long-command',
      name: 'run_terminal_command', summary: 'Command rejected', state: 'rejected',
      effect: 'unknown', durationMs: null, evidenceRefs: [],
      detailRef: { kind: 'agentTool', sessionId: baseNode.sessionId, callId: 'long-command' },
      input: { command: longValue }, output: longValue, error: null,
      target: null, idempotency: null, approval: null,
    };
    const { container } = render(<AiToolDetails node={node} onBack={vi.fn()} />);

    // Base UI supplies min-width inline; a CSS class alone cannot override it.
    const content = container.querySelector<HTMLElement>('[data-slot="scroll-area-content"]');
    expect(content).toHaveStyle({ minWidth: '0' });
    expect(content?.style.minWidth).not.toBe('fit-content');
    expect(container.querySelector('.ai-detail-code')).toHaveTextContent(longValue);
    expect(container.querySelector('.ai-terminal-output')).toHaveTextContent(longValue);
  });

  it('keeps loaded artifact details shrinkable without truncating the preview', async () => {
    const node: AiConversationNodeOf<'artifact'> = {
      ...baseNode,
      kind: 'artifact', key: 'artifact:long-report', artifactId: 'long-report',
      artifactKind: 'text', title: 'Long report', sizeBytes: longValue.length,
      mediaType: 'text/plain', sha256: 'a'.repeat(64), sensitivity: 'internal',
    };
    const { container } = render(
      <AiArtifactDetails
        sessionId={node.sessionId}
        node={node}
        onBack={vi.fn()}
        load={async () => ({
          metadata: {
            artifactId: node.artifactId, kind: 'text', title: node.title,
            mediaType: 'text/plain', sha256: 'a'.repeat(64), sizeBytes: longValue.length,
            sensitivity: 'internal', createdAtUnixMs: 1,
          },
          bodyBase64: btoa(longValue), truncated: false,
        })}
      />,
    );

    expect(await screen.findByText(longValue)).toBeInTheDocument();
    const content = container.querySelector<HTMLElement>('[data-slot="scroll-area-content"]');
    expect(content).toHaveStyle({ minWidth: '0' });
    expect(content?.style.minWidth).not.toBe('fit-content');
  });
});
