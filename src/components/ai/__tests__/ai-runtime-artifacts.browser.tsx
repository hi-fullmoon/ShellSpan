import { Activity, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiArtifactDetails } from '../workspace/ai-artifact-details';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentArtifactResponse, AgentSessionEvent } from '@/types/agent-session';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

async function loadOutput(sessionId: string, artifactId: string): Promise<AgentArtifactResponse> {
  const response = await fetch(`/saved-output/${sessionId}/${artifactId}`);
  if (!response.ok) throw new Error('Could not read the recorded artifact.');
  return response.json();
}

function RecordedConversation({ events }: { readonly events: readonly AgentSessionEvent[] }) {
  const [nodes] = useState(() => projectAgentChatNodes(events));
  const [storedOutput, setStoredOutput] = useState<{ sessionId: string; artifactId: string } | null>(null);
  return (
    <main className="ai-panel-shell mx-auto h-dvh min-w-0 max-w-2xl">
      {storedOutput && (
        <AiArtifactDetails sessionId={storedOutput.sessionId} node={null} artifactId={storedOutput.artifactId}
          title={t('ai.workspace.details.output')} load={loadOutput} onBack={() => setStoredOutput(null)} />
      )}
      <Activity mode={storedOutput ? 'hidden' : 'visible'}>
        <AiConversationNodeList
          nodes={nodes}
          onOpenStoredOutput={(node, artifactId) => setStoredOutput({ sessionId: node.sessionId, artifactId })}
        />
      </Activity>
    </main>
  );
}

const root = createRoot(document.getElementById('root')!);
export async function show(locale: Locale, width: number) {
  const events: AgentSessionEvent[] = await (await fetch('/evidence')).json();
  useAppStore.setState({ locale });
  await initI18n(locale);
  root.render(<RecordedConversation key={`${locale}:${width}`} events={events} />);
}
