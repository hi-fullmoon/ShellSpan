import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/components/ai/ai-panel.css';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { applyTheme } from '@/lib/theme';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import { agentSessionBaselineView } from './agent-session-baseline-page';
import { agentSessionBaselineScenario } from './fixtures/agent-session-baseline';
import fixture from './fixtures/agent-skills-runtime.json';

function SkillsPage() {
  const base = agentSessionBaselineView(agentSessionBaselineScenario('hello'));
  const events = fixture as unknown as readonly AgentSessionEvent[];
  const [root, setRoot] = useState<string | null>(null);
  const [draft, setDraft] = useState('ordinary draft');
  const snapshot = events.find((event) => event.type === 'skill/catalog_observed' && event.data.observation.snapshot)?.data;
  if (!snapshot || !('observation' in snapshot) || !snapshot.observation.snapshot) throw new Error('fixture catalogue absent');
  const catalog = snapshot.observation.snapshot;
  return <main className="ai-panel-shell" data-ai-scope="workbench" data-stage6b-ready style={{ width: '100vw', height: '100vh' }}>
    <AiWorkspaceRoot view={{ ...base, status: 'idle', nodes: projectAgentChatNodes(events) }} scope="workbench" canStartAgent
      draft={draft} onDraftChange={setDraft} skillsNeedsRoot={!root} projectTargetLabel="Local fixture (local)"
      onListSkills={async (selected) => { if (selected) setRoot(selected); return { sessionId: base.summary.id, status: 'fresh', revision: catalog.snapshotRevision, diagnostics: [], entries: catalog.entries.filter((entry) => entry.userInvocable) }; }} />
  </main>;
}
export async function mountSkillsPage(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
  useAppStore.setState({ locale, theme }); await initI18n(locale); applyTheme(theme);
  document.body.style.margin = '0'; document.body.style.overflow = 'hidden';
  createRoot(root).render(<SkillsPage />);
}
