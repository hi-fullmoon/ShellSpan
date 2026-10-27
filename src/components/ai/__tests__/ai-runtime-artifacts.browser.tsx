import { createRoot } from 'react-dom/client';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import { groupConversationArtifacts } from '@/lib/ai/conversation-artifact';
import type { AiArtifactNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
export async function show(locale: Locale, width: number) {
  const artifacts: AiArtifactNode[] = await (await fetch('/evidence')).json();
  useAppStore.setState({ locale });
  await initI18n(locale);
  root.render(<main key={`${locale}:${width}`} className="ai-panel-shell mx-auto min-w-0 max-w-2xl p-4">
    <AiConversationNodeList nodes={groupConversationArtifacts(artifacts)}
      onOpenArtifact={artifact => { document.body.dataset.openedArtifact = artifact.artifactId; }} />
  </main>);
  return { count: artifacts.length, lastArtifactId: artifacts[artifacts.length - 1].artifactId };
}
