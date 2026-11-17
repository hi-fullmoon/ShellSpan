import { Activity, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiArtifactDetails } from '../workspace/ai-artifact-details';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import { AiToolDetails } from '../workspace/ai-tool-details';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { storedToolOutputId } from '@/lib/ai/conversation-tool';
import type { AiToolNode } from '@/lib/ai/conversation-node';
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
  const [tool, setTool] = useState<AiToolNode | null>(null);
  const [artifactId, setArtifactId] = useState<string>();
  const storedId = tool && storedToolOutputId(tool);
  return (
    <main className="ai-panel-shell mx-auto h-dvh min-w-0 max-w-2xl">
      {tool && (artifactId ? (
        <AiArtifactDetails sessionId={tool.sessionId} node={null} artifactId={artifactId}
          title={t('ai.workspace.details.output')} load={loadOutput} onBack={() => setArtifactId(undefined)} />
      ) : (
        <AiToolDetails node={tool} onBack={() => setTool(null)}
          onOpenStoredOutput={storedId ? () => setArtifactId(storedId) : undefined} />
      ))}
      <Activity mode={tool ? 'hidden' : 'visible'}>
        <AiConversationNodeList nodes={nodes} onOpenTool={setTool} />
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
