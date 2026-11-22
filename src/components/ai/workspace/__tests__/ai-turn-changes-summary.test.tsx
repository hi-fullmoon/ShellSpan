import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiToolNode, AiTurnProcessNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { AiTurnChangesSummary, summarizeTurnFileChanges } from '../ai-turn-changes-summary';

function makeTool(overrides: Partial<AiToolNode>): AiToolNode {
  return {
    kind: 'tool',
    key: 'tool:1',
    sourceKind: 'agent',
    sessionId: 'sess-e',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 2,
    lastSeq: 3,
    timestamp: new Date().toISOString(),
    callId: 'call-1',
    name: 'apply_patch',
    nativeName: 'apply_patch',
    title: null,
    summary: '',
    state: 'succeeded',
    effect: 'stateChange',
    durationMs: 120,
    detailRef: { kind: 'agentTool', sessionId: 'sess-e', callId: 'call-1', turnId: 'turn-1', stepId: 'step-1' },
    evidenceRefs: [],
    input: {},
    output: null,
    error: null,
    target: null,
    idempotency: 'no',
    approval: null,
    ...overrides,
  };
}

function makeProcess(overrides: Partial<AiTurnProcessNode> = {}): AiTurnProcessNode {
  return {
    kind: 'turnProcess',
    key: 'turn-process:turn-1',
    sourceKind: 'agent',
    sessionId: 'sess-e',
    turnId: 'turn-1',
    stepId: null,
    firstSeq: 1,
    lastSeq: 8,
    timestamp: new Date().toISOString(),
    status: 'completed',
    answerGeneration: 'req-1',
    hasStartBoundary: true,
    hasEndBoundary: true,
    childKeys: [],
    children: [],
    ...overrides,
  };
}

describe('AiTurnChangesSummary', () => {
  beforeEach(async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  afterEach(cleanup);

  it('does not render while the turn is still running or when only read/terminal tools ran', () => {
    const editTool = makeTool({
      input: { path: 'src/app.ts', old_string: 'a\n', new_string: 'b\nc\n' },
    });
    expect(summarizeTurnFileChanges(makeProcess({ status: 'running', hasEndBoundary: false, children: [editTool] }))).toBeNull();

    const readTool = makeTool({
      name: 'read_file',
      nativeName: 'read_file',
      input: { path: 'src/app.ts' },
    });
    expect(summarizeTurnFileChanges(makeProcess({ children: [readTool] }))).toBeNull();
  });

  it('aggregates multiple edits per file, excludes failed edits, and opens the tool diff on click', () => {
    const firstEdit = makeTool({
      key: 'tool:1',
      callId: 'call-1',
      input: { path: 'etc/nginx/nginx.conf', old_string: 'worker_processes 1;\n', new_string: 'worker_processes auto;\nworker_rlimit_nofile 65535;\n' },
    });
    const secondEditSameFile = makeTool({
      key: 'tool:2',
      callId: 'call-2',
      input: { path: 'etc/nginx/nginx.conf', old_string: 'keepalive_timeout 65;\n', new_string: 'keepalive_timeout 30;\n' },
    });
    const failedEdit = makeTool({
      key: 'tool:3',
      callId: 'call-3',
      state: 'failed',
      input: { path: 'etc/nginx/broken.conf', old_string: 'a\n', new_string: 'b\n' },
    });
    const trashTool = makeTool({
      key: 'tool:4',
      callId: 'call-4',
      name: 'trash_file',
      nativeName: 'trash_file',
      input: { path: 'etc/nginx/old.conf' },
    });

    const onOpenTool = vi.fn();
    const process = makeProcess({
      children: [firstEdit, secondEditSameFile, failedEdit, trashTool],
      childKeys: [firstEdit.key, secondEditSameFile.key, failedEdit.key, trashTool.key],
    });
    const { container } = render(<AiTurnChangesSummary process={process} onOpenTool={onOpenTool} />);

    const trigger = container.querySelector<HTMLButtonElement>('.ai-turn-changes-trigger')!;
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('2 files modified by tools');
    expect(container.querySelector('[data-ai-turn-changes-totals]')).toHaveTextContent('+3-2');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText('etc/nginx/broken.conf')).not.toBeInTheDocument();
    expect(screen.getByText('Moved to Trash')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View changes in etc/nginx/nginx.conf' }));
    expect(onOpenTool).toHaveBeenCalledExactlyOnceWith(secondEditSameFile);
  });
});
