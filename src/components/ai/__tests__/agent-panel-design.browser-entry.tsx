import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { routeProviderConfigs, useLlmRoutesStore } from '@/stores/llmRoutesStore';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import { terminalLoginLabel } from '@/lib/ai/terminal-login-scope';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { normalizeAiSessionError } from '@/lib/ai/session-error';
import { createAiWorkspaceNavigationState } from '@/lib/ai/panel-route';
import type { AgentSessionStreamState } from '@/lib/ai/agent-session-client';
import type { ResolvedModel } from '@/lib/ai/provider-contract';
import type { RouteSnapshot } from '@/types/ai';
import type { Locale } from '@/types';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';
import { AiComposerModelSelector } from '../workspace/ai-composer-model-selector';
import { AiContextMeter } from '../workspace/ai-context-meter';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';
import { AiQueueNotice } from '../workspace/ai-queue-notice';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
type Scene = 'question' | 'tasks' | 'settled' | 'contextTop' | 'contextBottom' | 'errors' | 'empty' | 'disabled';
type Evidence = Record<'question' | 'tasks' | 'settled' | 'failure', AgentSessionStreamState> & {
  routes: RouteSnapshot;
  modelsByRoute: Record<string, ResolvedModel[]>;
};

export async function show(locale: Locale, width: number, scene: Scene) {
  const evidence: Evidence = await (await fetch('/evidence')).json();
  useAppStore.setState({ locale });
  await initI18n(locale);
  useAgentQuestionStore.setState({ drafts: {} });
  const providers = routeProviderConfigs(evidence.routes, evidence.modelsByRoute);
  // Use the real browser model-resolution path with the exported native catalog.
  // No Tauri IPC or provider replies are replaced by a stub.
  useLlmRoutesStore.setState({ snapshot: undefined, modelsByRoute: {}, status: 'idle' });
  useAiSettingsStore.setState({ providers, defaultProviderId: evidence.routes.defaultSelection?.routeId });
  const state = evidence[scene === 'question' ? 'question' : scene === 'tasks' ? 'tasks' : scene === 'disabled' ? 'failure' : 'settled'];
  const view = agentSessionView(state);
  const failureView = agentSessionView(evidence.failure);
  const activeTarget = evidence.tasks.snapshot?.header.target;
  if (!activeTarget) throw new Error('Evidence must contain the actual terminal target.');
  const terminalLabel = terminalLoginLabel(activeTarget) ?? activeTarget.label ?? activeTarget.host ?? t('ai.workspace.localTarget');
  const selected = providers.find(provider => provider.id === view.snapshot.value.header.modelSelection?.routeId
    && provider.model === view.snapshot.value.header.modelSelection?.modelId);
  if (!selected) throw new Error('The recorded model must exist in the exported real route catalog.');
  const selectedProvider: NonNullable<typeof selected> = selected;
  const terminal: NonNullable<typeof activeTarget> = activeTarget;
  const permission = view.snapshot.value.header.permissionMode;
  const permissionMode = permission === 'operator' ? 'fullAccess' : permission === 'scopedAutopilot' ? 'autoApproveReadOnly' : 'requestApproval';
  const readOnly = scene === 'disabled';
  if (readOnly && view.snapshot.value.header.target?.sessionId === activeTarget.sessionId) {
    throw new Error('Read-only evidence must belong to another terminal.');
  }
  const executionLocked = readOnly || view.status === 'running' || view.status === 'waiting'
    || Boolean(view.snapshot.value.uncertainNativeEffects || view.pendingApproval || view.pendingQuestion);
  const usage = agentSessionView(evidence.settled).contextUsage;
  if (!usage) throw new Error('Evidence must contain real runtime context usage.');
  useTerminalStore.setState({ sessions: [] });
  if (scene !== 'empty') {
  useTerminalStore.getState().addSession({ sessionId: activeTarget.sessionId, title: terminalLabel,
    host: activeTarget.kind === 'local' ? 'local' : activeTarget.host!,
    port: activeTarget.kind === 'local' ? 0 : activeTarget.port!, username: activeTarget.username ?? '' }, activeTarget.profileId);
  useTerminalStore.getState().setStatus(activeTarget.sessionId, { sessionId: activeTarget.sessionId, status: 'connected' });
  }
  delete document.body.dataset.action;
  delete document.body.dataset.draftLength;

  function Review() {
    const [draft, setDraft] = useState('');
    const [retrying, setRetrying] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [navigation, setNavigation] = useState(() => createAiWorkspaceNavigationState(view.summary.id));
    const record = (action: string) => { document.body.dataset.action = action; };
    // Isolated boundary checks are deliberately separate from full-workspace scenes.
    if (scene === 'contextTop' || scene === 'contextBottom') return <div className={scene === 'contextTop'
      ? 'flex h-full items-start justify-end p-2' : 'flex h-full items-end justify-end p-2'}>
      <AiContextMeter usage={usage} />
    </div>;
    if (scene === 'errors') {
      if (!failureView.error) throw new Error('Evidence must contain a real failure.');
      const error = normalizeAiSessionError(failureView.error.message);
      return <div className="p-3"><AiWorkspaceErrorNotices syncError={error}
        syncRecovery={{ attempts: 1, retrying }}
        onRetrySync={async () => { setRetrying(true); record('sync'); }}
        onDismissError={() => { setDismissed(true); record('dismiss'); }} onRetryFailedDraft={() => record('draft')}
        composerState={createAiComposerState({ phase: 'error', lastError: dismissed ? null : error,
          failedDrafts: [{ id: failureView.summary.id, content: failureView.snapshot.value.header.goal, mode: 'nextTurn', error }],
        })} /><AiQueueNotice conflict={false} error={error.message} /></div>;
    }
    return <AiWorkspaceRoot mode="agent" scope="terminal" view={scene === 'empty' ? null : view}
      canStartAgent={scene !== 'empty'} terminalConnected={scene !== 'empty'} historyScopeLabel={scene === 'empty' ? null : terminalLabel}
      readOnlySession={readOnly} draft={draft} onDraftChange={value => {
        document.body.dataset.draftLength = String(value.length);
        setDraft(value);
      }}
      navigation={navigation} sessions={[agentSessionView(evidence.settled).summary, failureView.summary]}
      onHistory={() => setNavigation(current => ({ ...current, route: { kind: 'sessions' } }))}
      onBack={() => setNavigation(createAiWorkspaceNavigationState(view.summary.id))}
      onNewSession={() => record('new')} onClose={() => record('close')}
      modelLabel={selectedProvider.model} providerLabel={selectedProvider.name}
      composerState={scene === 'empty' ? createAiComposerState() : createAiComposerState({ sessionId: view.summary.id, draft, runtimeStatus: view.status,
        waitingApproval: Boolean(view.pendingApproval), waitingQuestion: Boolean(view.pendingQuestion) })}
      modelControl={<AiComposerModelSelector disabled={readOnly || scene === 'empty'} selection={selectedProvider} onSelect={async () => record('model')} />}
      permissionControl={scene === 'empty' ? undefined : <AgentPermissionSelector sessionId={terminal.sessionId} disabled={readOnly} mode={permissionMode} variant="composer" />}
      executionSurfaceControl={scene === 'empty' ? undefined : <AgentExecutionSurfaceSelector disabled={executionLocked} surface={view.snapshot.value.header.executionSurface} realTerminalState="unavailable" />}
      onAnswerQuestion={() => { record('answer'); return new Promise(() => {}); }}
      onSubmit={() => record('submit')} onStop={() => record('stop')} />;
  }
  flushSync(() => root.render(<main style={{ width, height: '100dvh', marginLeft: 'auto' }}
    className="ai-panel-shell flex min-h-0 min-w-0 flex-col" data-ai-scope="terminal">
    <Review />
  </main>));
  return { terminalLabel, questionCount: view.pendingQuestion?.questions.length ?? 0,
    model: selected.modelDefinition?.displayName ?? selected.model, draft: view.snapshot.value.header.goal,
    planCount: view.snapshot.value.task.plan?.steps.length ?? 0, executionLocked };
}
