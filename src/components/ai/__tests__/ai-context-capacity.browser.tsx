import { createRoot } from 'react-dom/client';
import { AiContextMeter } from '../workspace/ai-context-meter';
import { contextUsageForModel } from '@/lib/ai/session-settings';
import type { AiContextUsage } from '@/lib/ai/session-adapter';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import accountingCapture from '@/test/fixtures/context-usage-runtime.json';
import { projectContextUsage } from '@/lib/ai/context-usage';
import catalog from '../../../../protocol/llm/catalog.json';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

const context = [...capture as readonly AgentSessionEvent[]].reverse().find(event => event.type === 'request/context');
if (context?.type !== 'request/context' || context.data.inputTokens === undefined
  || context.data.contextWindow === undefined) throw new Error('Recorded context evidence is required');
const usage: AiContextUsage = {
  usedTokens: context.data.inputTokens, contextWindow: context.data.contextWindow, source: 'estimated',
};
const root = createRoot(document.getElementById('root')!);
export const originalWindow = catalog.presets.minimax.models['MiniMax-M3'].contextWindow;

export async function show(locale: Locale, capacity: number) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  root.render(<main className="ai-panel-shell flex h-screen items-end justify-end p-4">
    <AiContextMeter usage={contextUsageForModel(usage, capacity)} />
  </main>);
}

export async function showAccounting(locale: Locale, stream: keyof typeof accountingCapture, seq: number) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const events = accountingCapture[stream] as readonly AgentSessionEvent[];
  const projected = projectContextUsage(events.filter(event => event.seq <= seq));
  root.render(<main className="ai-panel-shell flex h-screen items-end justify-end p-4">
    <AiContextMeter usage={projected} />
  </main>);
  return projected;
}
