import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderRequestEndpoint,
  ProviderSetupDialog,
} from '../provider-setup-dialog';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';

const mocks = vi.hoisted(() => ({
  invokeListAiModels: vi.fn(),
  invokeLoadPreferences: vi.fn(),
  invokeSavePreferences: vi.fn(),
  invokeSetAgentEnabled: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeListAiModels: mocks.invokeListAiModels,
  invokeLoadPreferences: mocks.invokeLoadPreferences,
  invokeSavePreferences: mocks.invokeSavePreferences,
  invokeSetAgentEnabled: mocks.invokeSetAgentEnabled,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => variables
      ? `${key}:${Object.values(variables).join(':')}`
      : key,
  }),
}));

const initialState = useAiSettingsStore.getState();

describe('ProviderSetupDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invokeListAiModels.mockResolvedValue([]);
    mocks.invokeLoadPreferences.mockResolvedValue([]);
    mocks.invokeSavePreferences.mockResolvedValue(undefined);
    mocks.invokeSetAgentEnabled.mockResolvedValue(true);
    useAiSettingsStore.setState({ ...initialState, initialized: false }, true);
  });

  it('uses a compact shell with an edge-aligned scroll area', () => {
    render(
      <ProviderSetupDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog');
    const scrollArea = dialog.querySelector('[data-slot="provider-dialog-scroll-area"]');
    const providerControl = screen.getByRole('combobox', {
      name: 'settings.ai.chooseProvider',
    }).closest('[data-slot="input-group"]');
    expect(dialog).toHaveClass('max-w-xl', 'gap-0', 'p-0');
    expect(dialog).not.toHaveClass('max-w-2xl');
    expect(scrollArea).toHaveClass('overflow-y-auto', 'px-4', 'py-4');
    expect(scrollArea).not.toHaveClass('pr-1');
    expect(providerControl).toHaveClass(
      'has-[[data-slot=input-group-control]:focus-visible]:ring-1',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-ring',
    );
    expect(providerControl).not.toHaveClass(
      'has-[[data-slot=input-group-control]:focus-visible]:ring-3',
    );
  });

  it('keeps the provider as a draft until every required field is complete and saved', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const originalCount = useAiSettingsStore.getState().providers.length;
    render(
      <ProviderSetupDialog open onOpenChange={onOpenChange} onSaved={onSaved} />,
    );

    const providerInput = screen.getByRole('combobox', { name: 'settings.ai.chooseProvider' });
    await user.click(providerInput);
    await user.type(providerInput, 'DeepSeek');
    await user.click(await screen.findByRole('option', { name: /DeepSeek/ }));

    expect(useAiSettingsStore.getState().providers).toHaveLength(originalCount);
    expect(providerInput).toHaveValue('DeepSeek');
    expect(screen.getByLabelText('settings.ai.providerName')).toHaveValue('DeepSeek');
    expect(screen.getByLabelText('settings.ai.baseUrl')).toHaveValue('https://api.deepseek.com');
    expect(screen.getByLabelText('settings.ai.model')).toHaveValue('deepseek-v4-flash');
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();

    await user.type(screen.getByLabelText(/settings\.ai\.apiKey/), 'secret-key');
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(useAiSettingsStore.getState().providers).toHaveLength(originalCount + 1);
    const savedProviders = useAiSettingsStore.getState().providers;
    const saved = savedProviders[savedProviders.length - 1];
    expect(saved).toEqual(expect.objectContaining({
      name: 'DeepSeek',
      preset: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'secret-key',
    }));
    expect(onSaved).toHaveBeenCalledWith(saved?.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('loads models from the draft without creating a provider', async () => {
    const user = userEvent.setup();
    const originalCount = useAiSettingsStore.getState().providers.length;
    mocks.invokeListAiModels.mockResolvedValue(['llama3.3', 'qwen3']);
    render(
      <ProviderSetupDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />,
    );

    const providerInput = screen.getByRole('combobox', { name: 'settings.ai.chooseProvider' });
    await user.click(providerInput);
    await user.type(providerInput, 'Ollama');
    await user.click(await screen.findByRole('option', { name: /Ollama/ }));
    await user.click(screen.getByRole('button', { name: 'settings.ai.loadModels' }));

    await waitFor(() => expect(mocks.invokeListAiModels).toHaveBeenCalledWith({
      id: 'provider-setup-draft',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3',
      requiresApiKey: false,
    }));
    expect(useAiSettingsStore.getState().providers).toHaveLength(originalCount);
    expect(await screen.findByText('settings.ai.connectionSuccess:2')).toBeInTheDocument();
  });

  it('cancels without creating a provider', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const originalProviders = useAiSettingsStore.getState().providers;
    render(
      <ProviderSetupDialog open onOpenChange={onOpenChange} onSaved={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'common.cancel' }));

    expect(useAiSettingsStore.getState().providers).toEqual(originalProviders);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('edits an existing provider without creating another profile', async () => {
    const user = userEvent.setup();
    const provider = {
      ...useAiSettingsStore.getState().providers[0],
      apiKey: 'existing-key',
    };
    useAiSettingsStore.setState({ providers: [provider], defaultProviderId: provider.id });
    const onSaved = vi.fn();
    render(
      <ProviderSetupDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSaved={onSaved}
      />,
    );

    expect(screen.getByText('settings.ai.editProviderTitle')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'settings.ai.chooseProvider' })).toBeDisabled();
    await user.clear(screen.getByLabelText('settings.ai.providerName'));
    await user.type(screen.getByLabelText('settings.ai.providerName'), 'Renamed provider');
    await user.clear(screen.getByLabelText('settings.ai.model'));
    await user.type(screen.getByLabelText('settings.ai.model'), 'updated-model');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(useAiSettingsStore.getState().providers).toHaveLength(1);
    expect(useAiSettingsStore.getState().providers[0]).toEqual(expect.objectContaining({
      id: provider.id,
      name: 'Renamed provider',
      model: 'updated-model',
    }));
    expect(onSaved).toHaveBeenCalledWith(provider.id);
  });
});

describe('buildProviderRequestEndpoint', () => {
  it('matches the backend endpoint normalization for cloud and local providers', () => {
    expect(buildProviderRequestEndpoint(
      'https://api.deepseek.com',
      'openAiCompatible',
    )).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(buildProviderRequestEndpoint(
      'https://api.minimaxi.com/v1/chat/completions',
      'openAiCompatible',
    )).toBe('https://api.minimaxi.com/v1/chat/completions');
    expect(buildProviderRequestEndpoint(
      'http://127.0.0.1:11434',
      'ollama',
    )).toBe('http://127.0.0.1:11434/api/chat');
  });
});
