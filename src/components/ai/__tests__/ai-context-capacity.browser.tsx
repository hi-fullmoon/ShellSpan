import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { AiContextMeter } from '../workspace/ai-context-meter';
import { ProviderModelCatalogEditor, type ProviderModelDraft } from '../provider-model-catalog-editor';
import { modelDefinitionForSave } from '../provider-setup-dialog';
import type { ModelDefinition } from '@/lib/ai/provider-contract';
import { contextUsageForModel } from '@/lib/ai/session-settings';
import type { AiContextUsage } from '@/lib/ai/session-adapter';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import accountingCapture from '@/test/fixtures/context-usage-runtime.json';
import budgetEvidence from '@/test/fixtures/context-budget-review.json';
import modelFixtures from '../../../../protocol/llm/fixtures/resolved-models.json';
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

export async function showBudget(locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const usage: AiContextUsage = {
    contextWindow: budgetEvidence.contextWindow, source: 'reported',
    usedTokens: budgetEvidence.uncachedInputTokens + budgetEvidence.cacheReadTokens,
    estimatedTokens: budgetEvidence.inputTokens,
    requestBudget: {
      outputTokens: budgetEvidence.budget.outputReserveTokens,
      safetyTokens: budgetEvidence.budget.safetyReserveTokens,
      usableInputTokens: budgetEvidence.budget.usableInputTokens,
      compactionThresholdTokens: budgetEvidence.budget.compactionThresholdTokens,
      compactionTargetTokens: budgetEvidence.budget.compactionTargetTokens,
    },
  };
  root.render(<main className="ai-panel-shell flex h-screen items-end justify-end p-4">
    <AiContextMeter usage={usage} />
  </main>);
}

const minimax = modelFixtures.find(item => item.provider.model === 'MiniMax-M3')!;
const initialDefinition: ModelDefinition = {
  contextWindow: budgetEvidence.contextWindow,
  maxOutputTokens: minimax.resolved.maxOutputTokens,
  toolCalling: 'supported', textInput: 'supported', imageInput: 'supported',
  reasoning: minimax.resolved.reasoning,
  compat: minimax.resolved.compat as ModelDefinition['compat'],
  vision: minimax.resolved.vision,
};
let savedDefinition: ModelDefinition = initialDefinition;
export const settingsDefinition = () => JSON.parse(JSON.stringify(savedDefinition)) as ModelDefinition;

function BudgetSettings() {
  const [models, setModels] = useState<ProviderModelDraft[]>([{ id: minimax.provider.model, definition: initialDefinition }]);
  return <main className="ai-panel-shell p-4">
    <ProviderModelCatalogEditor models={models} defaultModelId={minimax.provider.model}
      inherited={false} canReset={false} disabled={false} discovering={false}
      onChange={next => {
        setModels(next);
        if (next[0]) savedDefinition = modelDefinitionForSave(next[0], initialDefinition);
      }}
      onDefaultChange={() => undefined} onDiscover={async () => []}
      onDeclare={async () => undefined} onReset={() => undefined} />
  </main>;
}

export async function showSettings(locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  savedDefinition = initialDefinition;
  root.render(<BudgetSettings key={locale} />);
}
