import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiTurnFooter } from '../workspace/ai-turn-footer';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { Locale } from '@/types';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import '@/styles/base.css';
import '../styles/styles.css';

const node = projectAgentChatNodes(capture as AgentSessionEvent[]).find(node => node.kind === 'turnTail');
if (!node || node.kind !== 'turnTail') throw new Error('Recorded session must have a turn footer');
const footer = node;

export async function mount(host: HTMLElement, locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const root = createRoot(host);
  flushSync(() => root.render(<AiTurnFooter node={footer} />));
}
