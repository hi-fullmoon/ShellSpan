import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { conversationFoldRecording } from '@/test/fixtures/conversation-fold-runtime';
import { childFailureEvents } from '@/test/fixtures/child-recovery-recording';
import { inboxTimelineEvidence } from '@/test/fixtures/agent-inbox-timeline';
import { initI18n } from '@/locales';
import type { AgentSessionEvent } from '@/types/agent-session';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
const recordings = {
  ...Object.fromEntries(Object.entries(conversationFoldRecording).map(([name, recording]) => [name, recording.events])),
  failed: childFailureEvents,
  interleaved: inboxTimelineEvidence.events,
};
await initI18n('en-US');

function replay(events: readonly AgentSessionEvent[]) {
  const nodes = projectAgentChatNodes(events);
  const running = !events.some(event => event.type === 'turn/end');
  flushSync(() => root.render(
    <main className="ai-workspace-root ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
      <AiWorkspaceRoot scope="workbench" mode="agent" view={null} pendingNodes={nodes}
        composerState={createAiComposerState({ runtimeStatus: running ? 'running' : 'completed' })} />
    </main>,
  ));
  return nodes.filter(node => node.kind === 'assistantMessage').map(node => node.key);
}

Object.assign(window, {
  foldingRecordings: recordings,
  setFoldingLocale: initI18n,
  replayFoldingEvents: replay,
  replayFoldingRecording(name: keyof typeof recordings, length?: number) {
    return replay(recordings[name].slice(0, length));
  },
});
