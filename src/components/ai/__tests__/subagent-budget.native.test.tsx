import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';
import { childBudgetExhausted, childContinuationDeadline } from '@/lib/ai/subagent-continuation';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { normalizeAiSessionError } from '@/lib/ai/session-error';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';
import { useSubagentBudget } from '../workspace/use-subagent-budget';
import { AiSubagentCatalog } from '../workspace/ai-subagent-catalog';

// The explicit native gate builds this program before starting Vitest. Running
// the compiled test here produces a fresh real deadline after Vite has started.
const executeNative = promisify(execFile);
let directory: string;
let evidence: {
  available: { snapshot: AgentSessionSnapshot };
  running: { snapshot: AgentSessionSnapshot };
  exhausted: { snapshot: AgentSessionSnapshot; events: readonly AgentSessionEvent[] };
  timed: { snapshot: AgentSessionSnapshot };
  rejection: string;
};
beforeAll(async () => {
  await initI18n('en-US');
  useAppStore.setState({ locale: 'en-US' });
  directory = mkdtempSync(join(tmpdir(), 'shellspan-child-continuation-'));
  const output = join(directory, 'evidence.json');
  const binary = process.env.SHELLSPAN_CHILD_CONTINUATION_TEST_BINARY;
  if (!binary) throw new Error('Run pnpm test:subagent-budget:native to build the native evidence exporter first');
  await executeNative(binary, [
    'agent_runtime::subagent::lifecycle_tests::child_continuation_snapshot_tracks_committed_budget_and_deadline',
    '--exact', '--test-threads=1',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SHELLSPAN_CHILD_CONTINUATION_EVIDENCE: output },
    encoding: 'utf8', timeout: 20_000,
  });
  evidence = JSON.parse(readFileSync(output, 'utf8'));
}, 25_000);
afterEach(cleanup);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function Composer({ snapshot, stop }: { snapshot: AgentSessionSnapshot; stop?: () => void }) {
  const blocked = useSubagentBudget(snapshot);
  const [draft, setDraft] = useState(snapshot.header.goal);
  return <AiComposerSeat phase="active" inputMode="supplement" status={snapshot.status}
    draft={draft} onDraftChange={setDraft} onSubmit={() => undefined} onStop={stop}
    unavailableReason={blocked ? t('ai.error.childRecoveryBudgetExhausted') : null}
    availabilityHintId="child-budget-reason" />;
}

it('expires an idle child without a new event and preserves its draft', async () => {
  const snapshot = evidence.timed.snapshot;
  render(<Composer snapshot={snapshot} />);
  const editor = screen.getByRole('textbox');
  expect(editor).toHaveAttribute('contenteditable', 'true');
  expect(editor.textContent).toBe(snapshot.header.goal);
  await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'false'), { timeout: 5_000 });
  expect(editor.textContent).toBe(snapshot.header.goal);
  expect(screen.getByText(t('ai.error.childRecoveryBudgetExhausted'))).toBeVisible();
  expect(screen.getByRole('button', { name: t('ai.send') })).toBeDisabled();
  expect(snapshot.status).toBe('idle');
});

it.each(['zh-CN', 'en-US'] as const)('keeps a running child stoppable with a nonempty blocked draft in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  let stops = 0;
  render(<Composer snapshot={evidence.running.snapshot} stop={() => { stops++; }} />);
  expect(screen.getByRole('textbox').textContent).toBe(evidence.running.snapshot.header.goal);
  const button = screen.getByRole('button', { name: t('ai.workspace.stop') });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(stops).toBe(1);
  expect(screen.getByText(t('ai.error.childRecoveryBudgetExhausted'))).toBeVisible();
});

it('uses the persisted cumulative budget and supports snapshots without the new field', () => {
  const snapshot = evidence.available.snapshot;
  expect(childBudgetExhausted(snapshot, snapshot.header.createdAtUnixMs)).toBe(false);
  expect(childBudgetExhausted(evidence.exhausted.snapshot, snapshot.header.createdAtUnixMs)).toBe(true);
  const { childContinuation: _projection, ...oldSnapshot } = snapshot;
  const deadline = snapshot.header.createdAtUnixMs + snapshot.header.subagent!.budget.timeoutMs;
  expect(childContinuationDeadline(oldSnapshot)).toBe(deadline);
  expect(childBudgetExhausted(oldSnapshot, deadline - 1)).toBe(false);
  expect(childBudgetExhausted(oldSnapshot, deadline)).toBe(true);
});

it.each(['zh-CN', 'en-US'] as const)('identifies the current exhausted child in its catalog in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const { snapshot, events } = evidence.exhausted;
  const view = agentSessionView({ snapshot, events, hasTerminalEvent: false, lastCommittedSeq: snapshot.eventCount - 1 });
  render(<AiSubagentCatalog root={view.summary} current={view.summary} entries={[]}
    currentBudgetExhausted={childBudgetExhausted(snapshot)} onOpen={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: t('ai.workspace.subagents.lineageAria', { title: view.summary.title }) }));
  await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(t('ai.workspace.subagents.mode.budgetExhausted')) })).toBeVisible());
  expect(snapshot.header.subagent?.continuable).toBe(true);
});

it.each(['zh-CN', 'en-US'] as const)('preserves rejected text without offering or dispatching a permanent retry in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const content = evidence.available.snapshot.header.goal;
  const started = reduceAiComposer(createAiComposerState({ draft: content }), {
    type: 'submit.requested', gesture: 'keyboard', accelerated: false,
    clientOperationId: 'budget-rejected-followup', now: Date.now(), hasProvider: true, canCreateSession: true,
  }).state;
  const error = normalizeAiSessionError(evidence.rejection);
  expect(error.retryable).toBe(false);
  const failed = reduceAiComposer(started, { type: 'submit.failed', clientOperationId: 'budget-rejected-followup', error }).state;
  const retried: string[] = [];
  render(<AiWorkspaceErrorNotices composerState={failed} onRetryFailedDraft={id => retried.push(id)} />);
  expect(screen.getByText(content)).toBeVisible();
  expect(screen.getByText(t('ai.error.childRecoveryBudgetExhausted'))).toBeVisible();
  expect(screen.queryByRole('button', { name: t('common.retry') })).toBeNull();
  expect(retried).toEqual([]);
  const retry = reduceAiComposer(failed, { type: 'retry.requested', failedDraftId: 'budget-rejected-followup',
    clientOperationId: 'new-id', now: Date.now(), hasProvider: true, canCreateSession: true });
  expect(retry.state).toBe(failed);
  expect(retry.effects).toEqual([]);
});
