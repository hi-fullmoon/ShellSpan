import { createRef, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiQuestionPanel } from '../workspace/ai-question-panel';
import { useAiSessionController } from '../workspace/use-ai-session-controller';
import { createAgentSessionAdapter } from '@/lib/ai/agent-session-adapter';
import { QuestionSubmissionError, questionSubmissionIssue } from '@/lib/ai/question-submission';
import {
  invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeAgentRuntimeFollowup,
  invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession, invokeDeleteAgentRuntimeSession,
  invokeCreateLocalSession, invokeCloseSession,
} from '@/lib/ipc/tauri';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import { questionKey, type AnswerQuestionInput } from '@/types/agent-question';
import type { ModelSelection } from '@/types/ai';
import { t } from '@/locales';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

/** Exercise the production controller and form against a real native validation rejection. */
export async function verifyQuestionSubmissionRecovery(selection: ModelSelection): Promise<void> {
  const sessionId = `question-recovery-${crypto.randomUUID()}`;
  const adapter = createAgentSessionAdapter();
  const api = createRef<ReturnType<typeof useAiSessionController>>();
  const host = document.body.appendChild(document.createElement('section'));
  host.className = 'ai-panel-shell @container/ai-workspace';
  const root = createRoot(host);
  let created = false;
  let terminalId: string | undefined;
  let draftKey: string | undefined;
  let unsubscribe: (() => void) | undefined;
  function Harness() {
    const controller = useAiSessionController({ scope: 'workbench', adapter });
    useImperativeHandle(api, () => controller);
    return controller.view?.pendingQuestion && <AiQuestionPanel question={controller.view.pendingQuestion}
      onAnswer={controller.answerQuestion} onRefresh={controller.refreshQuestionAnswer} />;
  }
  const button = (key: Parameters<typeof t>[0]): HTMLButtonElement => {
    const result = [...host.querySelectorAll('button')].find(element => element.textContent === t(key));
    assert(result, `Missing question action: ${key}`);
    return result;
  };
  try {
    const terminal = await invokeCreateLocalSession();
    terminalId = terminal.sessionId;
    const target = { kind: 'local', targetId: `terminal-${terminal.sessionId}`, sessionId: terminal.sessionId } as const;
    await invokeCreateAgentRuntimeSession({ sessionId, taskId: sessionId,
      target,
      goal: 'Verify question answer validation and recovery', executionSurface: 'direct',
      permissionMode: 'operator', capabilityScope: { toolNames: ['ask_user_question'], effects: ['none'], targetIds: [target.targetId] } });
    created = true;
    await invokeStartAgentRuntime({ sessionId, selection });
    let view = await adapter.open(sessionId);
    unsubscribe = adapter.subscribe(sessionId, next => { view = next; });
    await invokeAgentRuntimeFollowup({ sessionId, messageId: crypto.randomUUID(),
      content: 'Call ask_user_question exactly once with one single-select question, id "continue", question "Continue verification?", and no options. After receiving the answer, reply done without calling any other tools.' });
    await eventually(() => {
      assert(view.status !== 'failed', `The real model failed before asking its question: ${questionSubmissionIssue(view.error?.message ?? view.statusReason).detail}`);
      return !!view.pendingQuestion;
    }, 'The real model did not ask its question');
    const question = view.pendingQuestion;
    assert(question, 'Missing committed native question');
    const input: AnswerQuestionInput = {
      identity: question.identity, clientOperationId: crypto.randomUUID(),
      answers: question.questions.map(item => ({ id: item.id, selected: [crypto.randomUUID()] })),
    };
    let rejection: QuestionSubmissionError | undefined;
    try { await adapter.answerQuestion(input); }
    catch (error) {
      assert(error instanceof QuestionSubmissionError, 'Expected the actual native validation diagnostic');
      rejection = error;
    }
    assert(rejection?.issue.reason === 'invalid', 'The backend must reject an unknown selected option');
    draftKey = questionKey(question.identity);
    useAgentQuestionStore.getState().setDraft(draftKey, { answers: input.answers, submission: input, issue: rejection.issue });
    flushSync(() => root.render(<Harness />));
    await eventually(() => !!api.current, 'The production question controller did not mount');
    api.current!.openSession(view.summary);
    await eventually(() => !!host.querySelector('[data-question-error="invalid"]'), 'The rejected answer did not reach the production form');
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = api.current!.view;
      const refresh = button('ai.workspace.question.refresh');
      refresh.click();
      await eventually(() => api.current!.view !== previous && !refresh.disabled,
        'Read-only question refresh did not finish');
      const draft = useAgentQuestionStore.getState().drafts[draftKey];
      assert(draft?.issue?.reason === 'invalid' && draft.issue.detail === rejection.issue.detail,
        'Refreshing a still-pending question must retain its confirmed validation rejection');
      assert(draft.submission?.clientOperationId === input.clientOperationId, 'Refresh must preserve the rejected operation');
      assert(!api.current!.view?.committedOperationIds?.includes(input.clientOperationId), 'Refresh must not submit the rejected answers');
      assert(!button('ai.workspace.question.edit').disabled, 'Refresh must keep Edit answers available');
      assert(![...host.querySelectorAll('button')].some(element => element.textContent === t('ai.workspace.question.retry')),
        'A confirmed rejection must not offer retrying the same invalid answers');
    }
    button('ai.workspace.question.edit').click();
    await eventually(() => host.querySelector('textarea')?.disabled === false, 'Editing must unlock the rejected answer');
    const textarea = host.querySelector('textarea')!;
    textarea.focus();
    assert(document.execCommand('insertText', false, 'Continue verification'), 'Native text input failed');
    await eventually(() => !button('ai.workspace.question.submit').disabled, 'The corrected answer did not become submittable');
    button('ai.workspace.question.submit').click();
    const corrected = useAgentQuestionStore.getState().drafts[draftKey]?.submission;
    assert(corrected && corrected.clientOperationId !== input.clientOperationId, 'Editing must create a new answer operation');
    assert(corrected.answers.every(answer => answer.custom === 'Continue verification' && !answer.selected.length),
      'The corrected submission must contain the actual edited answer');
    await eventually(() => !view.pendingQuestion && !!view.committedOperationIds?.includes(corrected.clientOperationId),
      'The corrected answer was not committed by the real backend');
    assert(!view.committedOperationIds?.includes(input.clientOperationId), 'The rejected operation must remain uncommitted');
    await eventually(() => !useAgentQuestionStore.getState().drafts[draftKey!], 'The accepted answer draft was not cleared');
  } finally {
    root.unmount();
    host.remove();
    unsubscribe?.();
    adapter.dispose();
    if (draftKey) useAgentQuestionStore.getState().clear(draftKey);
    if (created) {
      await invokeCancelAgentRuntime({ sessionId });
      await invokeArchiveAgentRuntimeSession({ sessionId });
      await invokeDeleteAgentRuntimeSession({ sessionId });
    }
    if (terminalId) await invokeCloseSession(terminalId);
  }
}
