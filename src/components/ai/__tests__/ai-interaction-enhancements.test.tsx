import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@/tests/composer-editor-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiApprovalPanel } from '@/components/ai/workspace/ai-approval-panel';
import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import { AiTurnChangesSummary, AiTurnRollbackContext } from '@/components/ai/workspace/ai-turn-changes-summary';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { FileCheckpointRollbackDialog } from '@/components/ai/workspace/file-checkpoint-rollback-dialog';
import { createAiComposerState, type AiComposerState } from '@/lib/ai/composer-machine';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { decodeDocumentMessage } from '@/lib/ai/document-message';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';
import * as tauriIpc from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const baseApproval: AiPendingApproval = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  stepId: 'step-1',
  requestId: 'req-1',
  callId: 'call-1',
  approvalId: 'approval-1',
  risk: 'stateChange',
  effect: 'stateChange',
  prompt: null,
  reason: null,
  expiresAtUnixMs: null,
  toolName: 'edit_file',
  evidenceRefs: [],
  target: { kind: 'local', targetId: 'local', sessionId: 'term-1', label: 'Local' },
  arguments: {
    path: '/etc/nginx/nginx.conf',
    old_string: 'worker_processes 1;',
    new_string: 'worker_processes auto;',
  },
};

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('AiApprovalPanel diff preview and reject with note', () => {
  it('renders inline diff preview for edit_file approvals', () => {
    const { container } = render(
      <AiApprovalPanel
        approval={baseApproval}
        decision={null}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const preview = container.querySelector('[data-slot="ai-approval-diff-preview"]');
    expect(preview).toBeInTheDocument();
    expect(preview?.textContent).toContain('worker_processes 1;');
    expect(preview?.textContent).toContain('worker_processes auto;');
  });

  it('sends optional rejection guidance when rejecting with a note', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(
      <AiApprovalPanel
        approval={baseApproval}
        decision={null}
        error={null}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reject with note' }));
    const textarea = screen.getByPlaceholderText('e.g. Do not restart yet, check with --dry-run first…');
    fireEvent.change(textarea, { target: { value: 'Check nginx -t before editing' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onReject).toHaveBeenCalledWith('Check nginx -t before editing');
  });

  it('calls onReject without reason on direct cancel', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(
      <AiApprovalPanel
        approval={baseApproval}
        decision={null}
        error={null}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onReject).toHaveBeenCalledWith();
  });
});

describe('AiEmptyHero quick skill chips', () => {
  it('shows quick operations skills in agent empty state and inserts skill into draft', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(
      <AiWorkspaceRoot
        mode="agent"
        scope="terminal"
        view={null}
        canStartAgent
        composerState={createAiComposerState({ runtimeStatus: 'idle' })}
        onDraftChange={onDraftChange}
      />,
    );
    const chip = screen.getByRole('button', { name: 'System status' });
    expect(chip).toBeVisible();
    await user.click(chip);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const decoded = decodeDocumentMessage(onDraftChange.mock.calls[0][0] as string);
    expect(decoded.text).toBe('/system-status ');
    expect(decoded.skills).toContain('system-status');
  });

  it('omits operations skill chips in ask mode', () => {
    render(
      <AiWorkspaceRoot
        mode="ask"
        scope="workbench"
        view={null}
        canStartAgent
        composerState={createAiComposerState({ runtimeStatus: 'idle' })}
        onDraftChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'System status' })).not.toBeInTheDocument();
  });
});

describe('AiComposerSeat prompt history navigation', () => {
  function HistoryHarness({ history }: { readonly history: readonly string[] }) {
    const [state, setState] = useState<AiComposerState>(() => createAiComposerState({ runtimeStatus: 'idle' }));
    return (
      <div className="@container/ai-workspace">
        <AiComposerSeat
          phase="active"
          status="idle"
          composerState={state}
          promptHistory={history}
          onDraftChange={(draft) => setState((current) => ({ ...current, draft }))}
        />
      </div>
    );
  }

  it('cycles through prior prompts on ArrowUp/ArrowDown from empty draft and preserves typed drafts', async () => {
    render(<HistoryHarness history={['check nginx', 'tail /var/log/syslog']} />);
    const editor = screen.getByRole('textbox');
    editor.focus();

    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    await waitFor(() => expect(editor.textContent).toBe('tail /var/log/syslog'));

    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    await waitFor(() => expect(editor.textContent).toBe('check nginx'));

    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    await waitFor(() => expect(editor.textContent).toBe('tail /var/log/syslog'));

    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    await waitFor(() => expect(editor.textContent).toBe(''));
  });
});

describe('AiTurnChangesSummary rollback linkage', () => {
  const turnProcess: AiConversationNodeOf<'turnProcess'> = {
    kind: 'turnProcess',
    key: 'process:turn-1',
    sourceKind: 'agent',
    sessionId: 'session-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 1,
    lastSeq: 5,
    timestamp: '2026-11-25T00:00:00Z',
    status: 'completed',
    hasStartBoundary: true,
    hasEndBoundary: true,
    answerGeneration: '1',
    childKeys: ['tool:1'],
    children: [
      {
        kind: 'tool',
        key: 'tool:1',
        sourceKind: 'agent',
        sessionId: 'session-1',
        turnId: 'turn-1',
        stepId: 'step-1',
        firstSeq: 2,
        lastSeq: 3,
        timestamp: '2026-11-25T00:00:00Z',
        callId: 'call-1',
        name: 'edit_file',
        nativeName: 'edit_file',
        title: 'edit_file',
        summary: 'Edited nginx.conf',
        state: 'succeeded',
        effect: 'stateChange',
        durationMs: 120,
        detailRef: { kind: 'agentTool', sessionId: 'session-1', callId: 'call-1', turnId: 'turn-1', stepId: 'step-1' },
        evidenceRefs: [],
        input: { path: '/etc/nginx/nginx.conf', old_string: 'a', new_string: 'b' },
        output: { path: '/etc/nginx/nginx.conf' },
        error: null,
        target: null,
        idempotency: null,
        approval: null,
      },
    ],
  };

  it('invokes rollback callback with the changed file paths', async () => {
    const user = userEvent.setup();
    const onRollback = vi.fn();
    render(
      <AiTurnRollbackContext.Provider value={onRollback}>
        <AiTurnChangesSummary process={turnProcess} />
      </AiTurnRollbackContext.Provider>,
    );
    await user.click(screen.getByTestId('turn-changes-rollback-trigger'));
    expect(onRollback).toHaveBeenCalledWith(['/etc/nginx/nginx.conf']);
  });

  it('opens FileCheckpointRollbackDialog focused on the requested path', async () => {
    vi.spyOn(tauriIpc, 'invokeListFileCheckpoints').mockResolvedValue([
      {
        checkpointId: 'cp-1',
        taskId: 'task-1',
        targetId: 'local',
        targetKind: 'local',
        targetPath: '/etc/hosts',
        originalSha256: 'abc',
        originalByteLength: 10,
        createdAtUnixMs: 1000,
        expiresAtUnixMs: 9999999999,
      },
      {
        checkpointId: 'cp-2',
        taskId: 'task-1',
        targetId: 'local',
        targetKind: 'local',
        targetPath: '/etc/nginx/nginx.conf',
        originalSha256: 'def',
        originalByteLength: 20,
        createdAtUnixMs: 2000,
        expiresAtUnixMs: 9999999999,
      },
    ]);
    const previewSpy = vi.spyOn(tauriIpc, 'invokePreviewFileCheckpoint').mockResolvedValue({
      checkpointId: 'cp-2',
      targetPath: '/etc/nginx/nginx.conf',
      targetKind: 'local',
      existedBefore: true,
      currentExists: true,
      unchanged: false,
      modifiedAfterAgent: false,
      isBinary: false,
      truncated: false,
      unifiedDiff: '--- a\n+++ b\n-old\n+new',
    });
    const onCount = vi.fn();
    render(
      <FileCheckpointRollbackDialog
        sessionId="session-1"
        openRequest={{ nonce: 1, focusPaths: ['/etc/nginx/nginx.conf'] }}
        onCheckpointsCountChange={onCount}
      />,
    );
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(2));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledWith('session-1', 'cp-2'));
    expect(await screen.findByText('File Change Snapshots & Rollback')).toBeVisible();
  });
});
