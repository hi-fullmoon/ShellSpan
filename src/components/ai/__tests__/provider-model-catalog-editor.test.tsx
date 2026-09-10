import React, { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredModel, ModelDefinition } from '@/lib/ai/provider-contract';
import {
  ProviderModelCatalogEditor,
  type ProviderModelDraft,
  validateProviderModels,
} from '../provider-model-catalog-editor';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => variables
      ? `${key}:${Object.values(variables).join(':')}`
      : key,
  }),
}));

const definition: ModelDefinition = {
  contextWindow: 32_000,
  maxOutputTokens: 8_000,
  toolCalling: 'supported',
  textInput: 'supported',
  imageInput: 'unsupported',
  reasoning: [],
  compat: {
    protocol: 'openAiCompatible',
    cumulativeStream: false,
    supportsStreamUsage: true,
    nativeReasoning: false,
    splitReasoning: false,
    replayReasoningContent: false,
    thinkTagFallback: false,
    parallelToolCalls: true,
    strictSchema: true,
    preservesReasoningAcrossTurns: false,
    reasoningEncoding: 'none',
    clearThinking: false,
    defaultThinking: false,
  },
};

function Editor({ discover = async () => [] }: { discover?: () => Promise<DiscoveredModel[]> }) {
  const [models, setModels] = useState<ProviderModelDraft[]>([{ id: 'model-a', definition }]);
  const [defaultModel, setDefaultModel] = useState('model-a');
  return (
    <ProviderModelCatalogEditor
      models={models}
      defaultModelId={defaultModel}
      inherited={false}
      canReset
      disabled={false}
      discovering={false}
      onChange={(next) => {
        setModels(next);
        if (!next.some((model) => model.id === defaultModel)) setDefaultModel(next[0]?.id ?? '');
      }}
      onDefaultChange={setDefaultModel}
      onDiscover={discover}
      onDeclare={async () => undefined}
      onReset={() => undefined}
    />
  );
}

describe('ProviderModelCatalogEditor', () => {
  it('aligns the default-model control height with model inputs', () => {
    render(<Editor />);

    expect(screen.getByRole('combobox', { name: 'settings.ai.defaultModel' })).toHaveClass('h-8!');
    expect(screen.getByLabelText('settings.ai.modelIdNumber:1')).toHaveClass('h-8');
  });

  it('adds and edits a model row while naming duplicate model ids', async () => {
    const user = userEvent.setup();
    render(<Editor />);

    await user.click(screen.getByRole('button', { name: 'settings.ai.addModel' }));
    const second = screen.getByLabelText('settings.ai.modelIdNumber:2');
    await user.type(second, 'model-b');
    expect(second).toHaveValue('model-b');
    expect(screen.queryByText('settings.ai.modelIdRequired:2')).not.toBeInTheDocument();

    await user.clear(second);
    await user.type(second, 'model-a');
    expect(screen.getByText('settings.ai.modelIdDuplicate:2')).toHaveAttribute('role', 'alert');
  });

  it('treats discovery as candidates and adopts only the selected new models', async () => {
    const user = userEvent.setup();
    const discover = vi.fn().mockResolvedValue([
      { id: 'model-a' },
      { id: 'model-b', name: 'Model B', contextWindow: 64_000, maxOutputTokens: 16_000, definition },
      { id: 'model-c' },
    ]);
    render(<Editor discover={discover} />);

    await user.click(screen.getByRole('button', { name: 'settings.ai.loadModels' }));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    const picker = screen.getByRole('dialog', { name: 'settings.ai.chooseModelsTitle' });
    expect(picker).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'model-a' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /model-b/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'model-c' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'settings.ai.addSelectedModels' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /model-b/ }));
    await user.click(screen.getByRole('button', { name: 'settings.ai.addSelectedModels' }));
    expect(screen.getByLabelText('settings.ai.modelIdNumber:1')).toHaveValue('model-a');
    expect(screen.getByLabelText('settings.ai.modelIdNumber:2')).toHaveValue('model-b');
    expect(screen.getByLabelText('settings.ai.modelNameNumber:2')).toHaveValue('Model B');
    await user.click(screen.getByRole('button', { name: 'settings.ai.modelAdvancedNumber:2' }));
    expect(screen.getByLabelText('settings.ai.contextWindow')).toHaveValue(64_000);
    expect(screen.getByLabelText('settings.ai.maxOutput')).toHaveValue(16_000);
    expect(screen.queryByRole('button', { name: 'settings.ai.declareModel' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('settings.ai.modelIdNumber:3')).not.toBeInTheDocument();
  });

  it('does not bulk-select an oversized dynamic catalog', async () => {
    const user = userEvent.setup();
    const discover = vi.fn().mockResolvedValue(Array.from({ length: 75 }, (_value, index) => ({
      id: `model-${String(index + 1).padStart(2, '0')}`,
    })));
    render(<Editor discover={discover} />);

    await user.click(screen.getByRole('button', { name: 'settings.ai.loadModels' }));
    expect(await screen.findByText('settings.ai.modelSelectionLimit:50')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'settings.ai.selectAll' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.ai.addSelectedModels' })).toBeDisabled();
  });

  it('validates empty, duplicate, and invalid-capacity catalogs', () => {
    expect(validateProviderModels([])).toEqual({ kind: 'empty' });
    expect(validateProviderModels([{ id: '' }])).toEqual({ kind: 'missingId', index: 0 });
    expect(validateProviderModels([{ id: 'same' }, { id: 'same' }]))
      .toEqual({ kind: 'duplicateId', index: 1 });
    expect(validateProviderModels([{
      id: 'bad-capacity',
      definition: { ...definition, maxOutputTokens: definition.contextWindow + 1 },
    }])).toEqual({ kind: 'invalidDefinition', index: 0 });
    expect(validateProviderModels([{
      id: 'bad-vision-budget',
      contextWindow: 2_000,
      definition: {
        ...definition,
        imageInput: 'supported',
        vision: {
          maxRequestImages: 1,
          maxRequestImageBytes: 1024,
          reservedTokensPerImage: 4_096,
          imageTokenBudgetPolicy: 'fixture',
        },
      },
    }])).toEqual({ kind: 'invalidDefinition', index: 0 });
  });
});
