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

  it('aggregates multiple edits per file, excludes failed edits, and expands inline diff on click', () => {
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

    const process = makeProcess({
      children: [firstEdit, secondEditSameFile, failedEdit, trashTool],
      childKeys: [firstEdit.key, secondEditSameFile.key, failedEdit.key, trashTool.key],
    });
    const { container } = render(<AiTurnChangesSummary process={process} />);

    const trigger = container.querySelector<HTMLButtonElement>('.ai-turn-changes-trigger')!;
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('2 files modified by tools');
    expect(container.querySelector('[data-ai-turn-changes-totals]')).toHaveTextContent('+3-2');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText('etc/nginx/broken.conf')).not.toBeInTheDocument();
    expect(screen.getByText('Moved to Trash')).toBeInTheDocument();

    const fileButton = screen.getByRole('button', { name: 'View changes in etc/nginx/nginx.conf' });
    expect(fileButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fileButton);
    expect(fileButton).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('[data-ai-turn-changes-file-body] [data-ai-tool-view="diff"]')).toBeInTheDocument();
    expect(container.textContent).toContain('keepalive_timeout 30;');

    const deletedButton = screen.getByRole('button', { name: 'View changes in etc/nginx/old.conf' });
    fireEvent.click(deletedButton);
    expect(deletedButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument();
  });

  it('expands a concise saved summary with path copy instead of raw JSON for diff-less saves like save_vim_buffer', () => {
    const vimSave = makeTool({
      key: 'tool:vim-save',
      callId: 'call-vim-save',
      name: 'save_vim_buffer',
      nativeName: 'save_vim_buffer',
      input: {
        connectionPolicyBinding: 'secret-binding-hash',
        path: '/root/agent_vim_test.txt',
        snapshotId: 'snap-2',
      },
      output: {
        editor: 'vim',
        outcome: 'saved',
        snapshot: {
          lineCount: 3,
        },
      },
    });
    const process = makeProcess({
      children: [vimSave],
      childKeys: [vimSave.key],
    });
    const { container } = render(<AiTurnChangesSummary process={process} />);

    fireEvent.click(container.querySelector<HTMLButtonElement>('.ai-turn-changes-trigger')!);
    const fileButton = screen.getByRole('button', { name: 'View changes in /root/agent_vim_test.txt' });
    fireEvent.click(fileButton);

    expect(fileButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Saved · 3 lines')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('connectionPolicyBinding');
    expect(container.textContent).not.toContain('snap-2');
  });
});
