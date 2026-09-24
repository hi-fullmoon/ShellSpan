import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/components/ai/styles/styles.css';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { AiComposerModelSelector } from '@/components/ai/workspace/ai-composer-model-selector';
import { AgentExecutionSurfaceSelector } from '@/components/ai/agent-execution-surface-selector';
import { AgentPermissionSelector } from '@/components/ai/agent-permission-selector';
import { builtinSkillPreview } from '@/lib/ai/builtin-skills';
import { createAiComposerState, type AiComposerPhase } from '@/lib/ai/composer-machine';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import { applyTheme } from '@/lib/theme';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { agentSessionBaselineView } from './agent-session-baseline-page';
import { agentSessionBaselineScenario } from './fixtures/agent-session-baseline';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';

interface ComposerScene {
  phase?: AiComposerPhase;
  draft: string;
  owner: string;
  status: AiSessionStatus;
  hero: boolean;
  terminal: boolean;
  errorMessage?: string | null;
  unavailableReason?: string | null;
  needsRoot?: boolean;
  targetLabel?: string;
}

const base = agentSessionBaselineView(agentSessionBaselineScenario('hello'));
const listSkills = async () => builtinSkillPreview;
const listFiles = async () => ({
  status: 'ready' as const, code: null, scope: null, excluded: 0,
  entries: Array.from({ length: 16 }, (_, i) => ({ path: `src/file-${i}.ts`, kind: 'file' as const })),
});

function ComposerPage({ mode }: { readonly mode: 'ask' | 'agent' }) {
  const params = new URLSearchParams(location.search);
  const errorMessage = params.get('error');
  const approvalPreview = params.get('approvalPreview');
  const pendingApproval: AiPendingApproval | null = approvalPreview ? {
    sessionId: 'visual-session', turnId: 'visual-turn', stepId: 'visual-step',
    requestId: 'visual-request', callId: 'visual-call', approvalId: 'visual-approval',
    risk: 'stateChange', prompt: null, reason: 'nativePolicyRequiresApproval',
    expiresAtUnixMs: Date.now() + 60_000, toolName: 'write_terminal_input',
    target: { kind: 'local', targetId: 'visual-target', sessionId: 'visual-terminal', label: 'Local terminal' },
    arguments: { inputKind: 'paste', byteLength: 17, contentPersisted: false },
    effect: 'stateChange', evidenceRefs: [],
  } : null;
  const [scene, setScene] = useState<ComposerScene>({
    draft: '', owner: 'A', status: 'idle', hero: false, terminal: false, errorMessage,
  });
  const [stops, setStops] = useState(0);
  const activeTerminalId = useTerminalStore((state) => state.activeSessionId);
  Object.assign(window, {
    composerTest: { update: (patch: Partial<ComposerScene>) => setScene(current => ({ ...current, ...patch })) },
  });
  return <main className="ai-panel-shell" data-ai-scope={mode === 'ask' ? 'workbench' : 'terminal'} data-composer-test-ready data-stop-count={stops}
    style={{ width: '100vw', height: '100vh' }}>
    <AiWorkspaceRoot
      mode={mode}
      view={scene.hero ? null : {
        ...base,
        status: pendingApproval ? 'waiting' : scene.status,
        summary: { ...base.summary, id: scene.owner, status: pendingApproval ? 'waiting' : scene.status },
        pendingApproval,
      }}
      scope={mode === 'ask' ? 'workbench' : 'terminal'} canStartAgent={!scene.unavailableReason}
      agentUnavailableReason={scene.unavailableReason}
      composerState={createAiComposerState({ sessionId: scene.hero ? null : scene.owner, draft: scene.draft,
        runtimeStatus: pendingApproval ? 'waiting' : scene.status,
        phase: pendingApproval ? 'waitingApproval' : scene.phase,
        waitingApproval: Boolean(pendingApproval), terminal: scene.terminal,
        lastError: scene.errorMessage
          ? { kind: 'unknown', message: scene.errorMessage, retryable: true }
          : null })}
      skillsScopeKey={scene.owner}
      skillsNeedsRoot={scene.needsRoot}
      projectTargetLabel={scene.targetLabel}
      approvalArguments={approvalPreview === 'ready'
        ? { inputKind: 'paste', text: 'printf "visual approval"\n' }
        : null}
      approvalArgumentsLoading={approvalPreview === 'loading'}
      approvalArgumentsError={approvalPreview === 'error' ? 'Exact private arguments unavailable' : null}
      onApprove={() => undefined}
      onReject={() => undefined}
      onDraftChange={draft => setScene(current => ({ ...current, draft }))}
      onNewSession={() => setScene(current => ({ ...current, owner: `${current.owner}-new`, draft: '', hero: true, status: 'idle', terminal: false }))}
      onSubmitGesture={() => setScene(current => ({ ...current, draft: '', status: 'running', hero: false }))}
      onDismissError={() => setScene(current => ({ ...current, errorMessage: null }))}
      onStop={() => setStops(current => current + 1)}
      onPasteImages={() => undefined}
      onListSkills={listSkills} onListFileReferences={listFiles}
      modelLabel="deepseek-v4"
      modelControl={<AiComposerModelSelector />}
      permissionControl={mode === 'agent' && activeTerminalId
        ? <AgentPermissionSelector sessionId={activeTerminalId} variant="composer" />
        : undefined}
      executionSurfaceControl={mode === 'agent' && activeTerminalId
        ? <AgentExecutionSurfaceSelector surface="direct" realTerminalState="ready" />
        : undefined}
      onOpenModel={() => undefined}
    />
  </main>;
}

export async function mountComposerPage(root: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
  const mode = params.get('mode') === 'ask' ? 'ask' : 'agent';
  useAppStore.setState({ locale, theme });
  await initI18n(locale); applyTheme(theme);
  document.body.style.margin = '0'; document.body.style.overflow = 'hidden';
  createRoot(root).render(<ComposerPage mode={mode} />);
}
