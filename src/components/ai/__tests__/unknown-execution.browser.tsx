import { createRoot } from 'react-dom/client';
import { AiToolRow } from '../workspace/ai-tool-presentation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { Locale } from '@/types';
import capture from '@/test/fixtures/terminal-unknown-execution.json';
import '@/styles/base.css';
import '../styles/styles.css';

export async function mount(host: HTMLElement, locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const nodes = projectAgentChatNodes(capture as readonly AgentSessionEvent[]);
  const tool = nodes.flatMap(node => node.kind === 'turnProcess' ? node.children : [])
    .find((node): node is AiConversationNodeOf<'tool'> => node.kind === 'tool');
  if (!tool || tool.state !== 'uncertain') throw new Error('Recorded unknown execution was not preserved');
  createRoot(host).render(<AiToolRow node={tool} />);
}
