import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/components/ai/ai-panel.css';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { builtinSkillPreview } from '@/lib/ai/builtin-skills';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import type { AiSessionStatus } from '@/lib/ai/conversation-node';
import { applyTheme } from '@/lib/theme';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { agentSessionBaselineView } from './agent-session-baseline-page';
import { agentSessionBaselineScenario } from './fixtures/agent-session-baseline';

interface ComposerScene {
  draft: string;
  owner: string;
  status: AiSessionStatus;
  hero: boolean;
  terminal: boolean;
  unavailableReason?: string | null;
}

const base = agentSessionBaselineView(agentSessionBaselineScenario('hello'));
const listSkills = async () => builtinSkillPreview;
const listFiles = async () => ({
  status: 'ready' as const, code: null, scope: null, excluded: 0,
  entries: Array.from({ length: 16 }, (_, i) => ({ path: `src/file-${i}.ts`, kind: 'file' as const })),
});

function ComposerPage() {
  const [scene, setScene] = useState<ComposerScene>({ draft: '', owner: 'A', status: 'idle', hero: false, terminal: false });
  const [stops, setStops] = useState(0);
  Object.assign(window, {
    composerTest: { update: (patch: Partial<ComposerScene>) => setScene(current => ({ ...current, ...patch })) },
  });
  return <main className="ai-panel-shell" data-ai-scope="workbench" data-composer-test-ready data-stop-count={stops}
    style={{ width: '100vw', height: '100vh' }}>
    <AiWorkspaceRoot
      view={scene.hero ? null : { ...base, status: scene.status, summary: { ...base.summary, id: scene.owner } }}
      scope="workbench" canStartAgent={!scene.unavailableReason}
      agentUnavailableReason={scene.unavailableReason}
      composerState={createAiComposerState({ sessionId: scene.hero ? null : scene.owner, draft: scene.draft,
        runtimeStatus: scene.status, terminal: scene.terminal })}
      skillsScopeKey={scene.owner}
      onDraftChange={draft => setScene(current => ({ ...current, draft }))}
      onNewSession={() => setScene(current => ({ ...current, owner: `${current.owner}-new`, draft: '', hero: true, status: 'idle', terminal: false }))}
      onSubmitGesture={() => setScene(current => ({ ...current, draft: '', status: 'running', hero: false }))}
      onStop={() => setStops(current => current + 1)}
      onListSkills={listSkills} onListFileReferences={listFiles}
      modelLabel="deepseek-v4" onOpenModel={() => undefined}
    />
  </main>;
}

export async function mountComposerPage(root: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
  useAppStore.setState({ locale, theme });
  await initI18n(locale); applyTheme(theme);
  document.body.style.margin = '0'; document.body.style.overflow = 'hidden';
  createRoot(root).render(<ComposerPage />);
}
