import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AiContextMeter } from '../workspace/ai-context-meter';
import { validateProviderModels } from '../provider-model-catalog-editor';
import { modelDefinitionForSave } from '../provider-setup-dialog';
import type { ModelDefinition } from '@/lib/ai/provider-contract';
import type { AiContextUsage } from '@/lib/ai/session-adapter';
import { contextUsageForModel } from '@/lib/ai/session-settings';
import evidence from '@/test/fixtures/context-budget-review.json';
import models from '../../../../protocol/llm/fixtures/resolved-models.json';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

// Replay the actual accounting evidence through the new budget presentation.
export const recordedBudgetUsage: AiContextUsage = {
  contextWindow: evidence.contextWindow,
  source: 'reported',
  usedTokens: evidence.uncachedInputTokens + evidence.cacheReadTokens,
  estimatedTokens: evidence.inputTokens,
  requestBudget: {
    outputTokens: evidence.budget.outputReserveTokens,
    safetyTokens: evidence.budget.safetyReserveTokens,
    usableInputTokens: evidence.budget.usableInputTokens,
    compactionThresholdTokens: evidence.budget.compactionThresholdTokens,
    compactionTargetTokens: evidence.budget.compactionTargetTokens,
  },
};

afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('explains the actual trigger despite 23% confirmed usage in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const user = userEvent.setup();
  render(<AiContextMeter usage={recordedBudgetUsage} />);
  await user.click(screen.getByRole('button'));
  const panel = screen.getByRole('dialog');
  expect(panel.querySelector('.ai-context-meter-header')).toHaveTextContent('23%');
  expect(panel).toHaveTextContent('46.5K / 200K');
  const budget = within(panel.querySelector('[data-slot="ai-context-budget"]') as HTMLElement);
  expect(budget.getByText('50,088 (25%)')).toBeVisible();
  expect(budget.getByText('131,072')).toBeVisible();
  expect(budget.getByText('58,928')).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('retains a 200K user declaration and serializes the independent request output budget', () => {
  const entry = models.find(item => item.provider.model === 'MiniMax-M3')!;
  const definition = { ...entry.resolved, contextWindow: evidence.contextWindow } as ModelDefinition;
  const original = JSON.stringify(definition);
  const legacy = modelDefinitionForSave({ id: entry.provider.model, definition }, definition);
  expect(legacy.requestOutputTokens).toBeUndefined();
  expect(legacy.maxOutputTokens).toBe(131_072);
  const draft = { id: entry.provider.model, definition, requestOutputTokens: 16_384 };
  const saved = JSON.parse(JSON.stringify(modelDefinitionForSave(draft, definition))) as ModelDefinition;
  expect(saved).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 131_072, requestOutputTokens: 16_384 });
  expect(validateProviderModels([{ ...draft, definition: saved }])).toBeUndefined();
  for (const requestOutputTokens of [0, -1, 1.5, 131_073, Infinity]) {
    expect(validateProviderModels([{ ...draft, requestOutputTokens }])?.kind).toBe('invalidDefinition');
  }
  expect(JSON.stringify(definition)).toBe(original);
  expect(contextUsageForModel(recordedBudgetUsage, 128_000)?.requestBudget).toBeUndefined();
});

it('saves a smaller context without reducing model output capacity', () => {
  const entry = models.find(item => item.provider.model === 'MiniMax-M3')!;
  const definition = entry.resolved as ModelDefinition;
  const draft = { id: entry.provider.model, definition, contextWindow: 64_000, requestOutputTokens: 8_192 };
  expect(validateProviderModels([draft])).toBeUndefined();
  const saved = JSON.parse(JSON.stringify(modelDefinitionForSave(draft, definition))) as ModelDefinition;
  expect(saved).toMatchObject({ contextWindow: 64_000, maxOutputTokens: 131_072, requestOutputTokens: 8_192 });
  expect(validateProviderModels([{ id: draft.id, definition: saved }])).toBeUndefined();
  expect(definition.contextWindow).toBe(1_000_000);
  expect(definition.maxOutputTokens).toBe(131_072);
  expect(validateProviderModels([{ ...draft, requestOutputTokens: 60_800 }]))
    .toEqual({ kind: 'invalidBudget', index: 0 });
  expect(validateProviderModels([{ ...draft, requestOutputTokens: undefined }]))
    .toEqual({ kind: 'invalidBudget', index: 0 });
});
