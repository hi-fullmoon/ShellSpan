import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiConversation } from '../workspace/ai-conversation';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { createAiWorkspaceNavigationState } from '@/lib/ai/panel-route';
import { createAgentChatProjector } from '@/lib/ai/conversation-projection';
import { createAgentActivityProjector } from '@/lib/ai/agent-session-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { AiScrollAnchor } from '@/lib/ai/panel-route';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
let events: readonly AgentSessionEvent[] = [];
let anchor: AiScrollAnchor | undefined;
let workspace = false;
const project = createAgentChatProjector();
const projectActivity = createAgentActivityProjector();
await initI18n('zh-CN');
Object.assign(window, {
  initializeRuntimeReplay(recorded: readonly AgentSessionEvent[], useWorkspace = false) { events = recorded; workspace = useWorkspace; },
  replayUntil(length: number) {
    const prefix = events.slice(0, length);
    const nodes = project(prefix);
    const status = projectActivity(prefix).status;
    if (workspace) {
      const sessionId = prefix[0]?.sessionId ?? null;
      flushSync(() => root.render(
        <main className="flex h-dvh min-h-0 flex-col">
          <AiWorkspaceRoot view={null} scope="terminal" mode="agent" pendingNodes={nodes}
            composerState={createAiComposerState({ sessionId, runtimeStatus: status })}
            navigation={createAiWorkspaceNavigationState(sessionId)} />
        </main>,
      ));
      return;
    }
    flushSync(() => root.render(
      <main className="ai-workspace-root ai-panel-shell flex h-dvh min-h-0 flex-col" data-ai-scope="workbench">
        <AiConversation nodes={nodes} status={status}
          throughSeq={prefix[prefix.length - 1]?.seq ?? null} initialAnchor={anchor} onAnchorChange={value => { anchor = value; }} />
      </main>,
    ));
  },
});
