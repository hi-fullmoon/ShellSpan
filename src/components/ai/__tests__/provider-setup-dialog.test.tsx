vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.resolveModel }));
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderRequestEndpoint,
  ProviderSetupDialog,
} from '../provider-setup-dialog';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import { DEFAULT_RETRY_POLICY } from '@/lib/ai/retry-policy';

const mocks = vi.hoisted(() => ({
  native: false,
  resolveModel: vi.fn(),
  invokeDeleteAiApiKey: vi.fn(),
  invokeHasAiApiKey: vi.fn(),
  invokeListAiModels: vi.fn(),
  invokeStoreAiApiKey: vi.fn(),
  invokeLoadPreferences: vi.fn(),
  invokeSavePreferences: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', () => ({
  isTauriRuntime: () => mocks.native,
  invokeDeleteAiApiKey: mocks.invokeDeleteAiApiKey,
  invokeHasAiApiKey: mocks.invokeHasAiApiKey,
  invokeListAiModels: mocks.invokeListAiModels,
  invokeStoreAiApiKey: mocks.invokeStoreAiApiKey,
  invokeLoadPreferences: mocks.invokeLoadPreferences,
  invokeSavePreferences: mocks.invokeSavePreferences,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => variables
      ? `${key}:${Object.values(variables).join(':')}`
      : key,
  }),
}));

const initialState = useAiSettingsStore.getState();
const initialRoutesState = useLlmRoutesStore.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ProviderSetupDialog', () => {
  beforeEach(() => {
    mocks.native=false;
    vi.clearAllMocks();
    mocks.resolveModel.mockImplementation(async (command, args) => (await import('@/test/llm-resolver-fixture')).fixtureResolve(command, args));
    mocks.invokeDeleteAiApiKey.mockResolvedValue(undefined);
    mocks.invokeHasAiApiKey.mockResolvedValue(false);
    mocks.invokeListAiModels.mockResolvedValue([]);
    mocks.invokeStoreAiApiKey.mockResolvedValue(undefined);
    mocks.invokeLoadPreferences.mockResolvedValue([]);
    mocks.invokeSavePreferences.mockResolvedValue(undefined);
    useAiSettingsStore.setState({ ...initialState, initialized: false }, true);
    useLlmRoutesStore.setState({...initialRoutesState,snapshot:undefined,status:'idle',error:undefined,modelsByRoute:{}},true);
  });

  it('saves a disabled retry policy and blocks invalid values before connection testing', async () => {
    const user = userEvent.setup();
    const provider = useAiSettingsStore.getState().providers[0];
    const onSaved = vi.fn();
    render(<ProviderSetupDialog open provider={provider} onOpenChange={vi.fn()} onSaved={onSaved} />);
    const attempts = screen.getByRole('spinbutton', { name: 'settings.ai.retry.maxAttempts' });
    await user.clear(attempts);
    await user.type(attempts, '9');
    expect(attempts).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'settings.ai.verifyConnection' })).toBeDisabled();
    expect(mocks.invokeListAiModels).not.toHaveBeenCalled();
    await user.clear(attempts);
    await user.type(attempts, '1');
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(provider.id));
    expect(useAiSettingsStore.getState().getProviderConfig(provider.id).retryPolicy).toEqual({ ...DEFAULT_RETRY_POLICY, maxAttempts: 1 });
  });

  it('persists an explicit high-output declaration in the existing provider settings', async () => {
    const user = userEvent.setup();
    const provider = useAiSettingsStore.getState().providers[0];
    const onSaved = vi.fn();
    render(<ProviderSetupDialog open provider={provider} onOpenChange={vi.fn()} onSaved={onSaved} />);
    await screen.findByText(/settings.ai.profileLimits/);
    await user.click(screen.getByRole('button', { name: 'settings.ai.declareModel' }));
    const output = await screen.findByLabelText('settings.ai.maxOutput');
    await user.clear(output); await user.type(output, '16384');
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(provider.id));
    expect(useAiSettingsStore.getState().getProviderConfig(provider.id).modelDefinition).toMatchObject({ contextWindow: 32768, maxOutputTokens: 16384 });
    const call = mocks.resolveModel.mock.calls[mocks.resolveModel.mock.calls.length - 1][1].provider;
    expect(call).not.toHaveProperty('apiKey');
  });

  it('rejects an unsupported saved reasoning selection before writing credentials or preferences', async () => {
    const user = userEvent.setup();
    const provider = { ...useAiSettingsStore.getState().providers[0], reasoningEffort: 'max' as const };
    const onSaved = vi.fn();
    render(<ProviderSetupDialog open provider={provider} onOpenChange={vi.fn()} onSaved={onSaved} />);
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.resolveModel).toHaveBeenCalledWith('ai_resolve_model', expect.objectContaining({ provider: expect.objectContaining({ reasoningEffort: 'max' }) })));
    await screen.findByRole('alert');
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.invokeStoreAiApiKey).not.toHaveBeenCalled();
    expect(mocks.invokeDeleteAiApiKey).not.toHaveBeenCalled();
  });

  it('uses the shared compact shell and grouped responsive form layout', () => {
    render(
      <ProviderSetupDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog');
    const scrollArea = dialog.querySelector('[data-slot="provider-dialog-scroll-area"]');
    const providerControl = screen.getByRole('combobox', {
      name: 'settings.ai.chooseProvider',
    }).closest('[data-slot="input-group"]');
    const inputs = dialog.querySelectorAll('[data-slot="input"]');
    const inputGroups = dialog.querySelectorAll('[data-slot="input-group"]');
    const fieldGroups = scrollArea?.querySelectorAll('[data-slot="field-group"]');
    expect(dialog).toHaveClass('max-w-2xl', 'gap-0', 'p-0');
    expect(scrollArea).toHaveClass('overflow-y-auto', 'px-4', 'py-3', 'gap-5');
    expect(scrollArea).not.toHaveClass('pr-1');
    expect(fieldGroups).toHaveLength(3);
    expect(screen.queryByText('settings.ai.provider', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.connectionDetails', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.credentials', { exact: true })).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('settings.ai.addProviderDescription');
    expect(dialog).not.toHaveTextContent('settings.ai.connectionDetailsHint');
    expect(dialog).not.toHaveTextContent('settings.ai.credentialsHint');
    expect(dialog).toHaveClass('[&_[data-slot=dialog-close]]:size-6');
    expect(screen.getByRole('button', { name: 'common.cancel' })).toHaveClass('h-6');
    expect(screen.getByRole('button', { name: 'common.save' })).toHaveClass('h-6');
    expect(fieldGroups?.[0]).toHaveClass(
      '@min-[30rem]:grid',
      '@min-[30rem]:grid-cols-2',
    );
    expect(providerControl).toHaveClass(
      'has-[[data-slot=input-group-control]:focus-visible]:border-input',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-1',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-ring',
    );
    expect(providerControl).not.toHaveClass(
      'has-[[data-slot=input-group-control]:focus-visible]:border-ring',
      'has-[[data-slot=input-group-control]:focus-visible]:ring-3',
    );
    expect(inputGroups).toHaveLength(4);
    inputGroups.forEach((inputGroup) => {
      expect(inputGroup).toHaveClass(
        'h-9',
        'bg-transparent',
        'has-[[data-slot=input-group-control]:disabled]:bg-transparent',
        'has-[[data-slot=input-group-control]:focus-visible]:border-input',
        'has-[[data-slot=input-group-control]:focus-visible]:ring-1',
      );
      expect(inputGroup).not.toHaveClass(
        'has-[[data-slot=input-group-control]:disabled]:bg-input/50',
        'has-[[data-slot=input-group-control]:focus-visible]:border-ring',
        'has-[[data-slot=input-group-control]:focus-visible]:ring-3',
      );
    });
    inputs.forEach((input) => {
      expect(input).toHaveClass('bg-transparent');
      expect(input).not.toHaveClass('bg-background');
    });
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
    const ollamaOption = await screen.findByRole('option', { name: /Ollama/ });
    expect(ollamaOption).toHaveClass('py-1.5', '[&>svg]:size-4!');
    expect(ollamaOption).not.toHaveClass('py-1');
    expect(within(ollamaOption).getByText('ai.local')).toHaveClass('bg-secondary');
    await user.type(providerInput, 'DeepSeek');
    const deepSeekOption = await screen.findByRole('option', { name: /DeepSeek/ });
    const providerPopup = document.querySelector('[data-slot="combobox-content"]');
    expect(providerPopup).toHaveClass('min-w-[calc(var(--anchor-width)+--spacing(7))]');
    expect(deepSeekOption).toHaveClass('pr-1.5');
    expect(deepSeekOption).not.toHaveClass('pr-8');
    expect(within(deepSeekOption).getByText('ai.cloud')).toHaveClass('ml-auto', 'border-border');
    await user.click(deepSeekOption);

    expect(useAiSettingsStore.getState().providers).toHaveLength(originalCount);
    expect(providerInput).toHaveValue('DeepSeek');
    expect(screen.getByLabelText('settings.ai.providerName')).toHaveValue('DeepSeek');
    expect(screen.getByLabelText('settings.ai.baseUrl')).toHaveValue('https://api.deepseek.com');
    expect(screen.getByLabelText('settings.ai.model')).toHaveValue('deepseek-v4-flash');
    const endpointLabel = 'settings.ai.requestEndpoint:https://api.deepseek.com/chat/completions';
    const endpointButton = screen.getByRole('button', { name: endpointLabel });
    expect(endpointButton).toHaveClass(
      'relative',
      'size-4',
      'p-0',
      'after:absolute',
      'after:-inset-1',
    );
    expect(endpointButton).not.toHaveClass('size-5');
    expect(screen.queryByText(endpointLabel)).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.protocolHint')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.modelHint')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.ai.keyHint')).not.toBeInTheDocument();

    await user.hover(endpointButton);
    expect(await screen.findByText(endpointLabel)).toHaveAttribute('data-slot', 'tooltip-content');
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();

    await user.type(screen.getByLabelText(/settings\.ai\.apiKey/), 'secret-key');
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(useAiSettingsStore.getState().providers).toHaveLength(originalCount + 1));
    const savedProviders = useAiSettingsStore.getState().providers;
    const saved = savedProviders[savedProviders.length - 1];
    expect(saved).toEqual(expect.objectContaining({
      name: 'DeepSeek',
      preset: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    }));
    expect(saved).not.toHaveProperty('apiKey');
    expect(mocks.invokeStoreAiApiKey).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(saved?.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps custom providers on the preset API key policy without an extra switch', async () => {
    const user = userEvent.setup();
    render(
      <ProviderSetupDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />,
    );

    const providerInput = screen.getByRole('combobox', { name: 'settings.ai.chooseProvider' });
    await user.click(providerInput);
    await user.type(providerInput, 'Custom Provider');
    await user.click(await screen.findByRole('option', { name: /Custom Provider/ }));

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/settings\.ai\.apiKey/)).toBeEnabled();
  });

  it('does not call the retired provider-key command while editing a browser draft', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mocks.invokeStoreAiApiKey.mockRejectedValueOnce(new Error('keychain unavailable'));
    render(
      <ProviderSetupDialog open onOpenChange={vi.fn()} onSaved={onSaved} />,
    );

    const providerInput = screen.getByRole('combobox', { name: 'settings.ai.chooseProvider' });
    await user.click(providerInput);
    await user.type(providerInput, 'DeepSeek');
    await user.click(await screen.findByRole('option', { name: /DeepSeek/ }));
    await user.type(screen.getByLabelText(/settings\.ai\.apiKey/), 'secret-key');
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(()=>expect(onSaved).toHaveBeenCalled());
    expect(mocks.invokeStoreAiApiKey).not.toHaveBeenCalled();
  });

  it('does not consult the retired provider-key command for an existing browser draft', async () => {
    const provider = useAiSettingsStore.getState().providers[1];
    mocks.invokeHasAiApiKey.mockResolvedValueOnce(true);
    render(
      <ProviderSetupDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
    expect(mocks.invokeHasAiApiKey).not.toHaveBeenCalled();
    expect(mocks.invokeStoreAiApiKey).not.toHaveBeenCalled();
    expect(useAiSettingsStore.getState().providers[1]).not.toHaveProperty('apiKey');
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
      retryPolicy: DEFAULT_RETRY_POLICY,
      profile: 'ollama',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3',
      requiresApiKey: false,
    }));
    expect(useAiSettingsStore.getState().providers).toHaveLength(originalCount);
    const feedback = await screen.findByRole('status');
    const dialog = screen.getByRole('dialog');
    const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    const scrollArea = dialog.querySelector<HTMLElement>('[data-slot="provider-dialog-scroll-area"]');
    expect(feedback).toHaveTextContent('settings.ai.ready');
    expect(feedback).not.toHaveTextContent('settings.ai.connectionSuccess:2');
    expect(footer).toContainElement(feedback);
    expect(scrollArea).not.toContainElement(feedback);

    const detailsButton = within(feedback).getByRole('button', {
      name: /settings\.ai\.ready: settings\.ai\.connectionSuccess:2/,
    });
    expect(detailsButton).toHaveClass('size-4', 'shrink-0', 'p-0');
    await user.hover(detailsButton);
    expect(await screen.findByText('settings.ai.connectionSuccess:2')).toHaveAttribute(
      'data-slot',
      'tooltip-content',
    );
  });

  it('shows a short failure status and reveals the provider error from its icon', async () => {
    const user = userEvent.setup();
    mocks.invokeListAiModels.mockRejectedValueOnce(new Error('provider rejected API key'));
    render(
      <ProviderSetupDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />,
    );

    const providerInput = screen.getByRole('combobox', { name: 'settings.ai.chooseProvider' });
    await user.click(providerInput);
    await user.type(providerInput, 'Ollama');
    await user.click(await screen.findByRole('option', { name: /Ollama/ }));
    await user.click(screen.getByRole('button', { name: 'settings.ai.verifyConnection' }));

    const feedback = await screen.findByRole('alert');
    expect(feedback).toHaveTextContent('settings.ai.connectionFailed');
    expect(feedback).not.toHaveTextContent('provider rejected API key');

    const detailsButton = within(feedback).getByRole('button', {
      name: 'settings.ai.connectionFailed: provider rejected API key',
    });
    await user.hover(detailsButton);
    expect(await screen.findByText('provider rejected API key')).toHaveAttribute(
      'data-slot',
      'tooltip-content',
    );
  });

  it('ignores a model response after switching presets', async () => {
    const user = userEvent.setup();
    const pendingModels = deferred<string[]>();
    mocks.invokeListAiModels.mockReturnValueOnce(pendingModels.promise);
    render(
      <ProviderSetupDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />,
    );

    const providerInput = screen.getByRole('combobox', { name: 'settings.ai.chooseProvider' });
    await user.click(providerInput);
    await user.type(providerInput, 'Ollama');
    await user.click(await screen.findByRole('option', { name: /Ollama/ }));
    await user.click(screen.getByRole('button', { name: 'settings.ai.loadModels' }));
    await waitFor(() => expect(mocks.invokeListAiModels).toHaveBeenCalledTimes(1));

    await user.click(providerInput);
    await user.clear(providerInput);
    await user.type(providerInput, 'DeepSeek');
    await user.click(await screen.findByRole('option', { name: /DeepSeek/ }));
    await act(async () => {
      pendingModels.resolve(['stale-ollama-model']);
      await pendingModels.promise;
    });

    expect(screen.getByLabelText('settings.ai.baseUrl')).toHaveValue('https://api.deepseek.com');
    expect(screen.getByLabelText('settings.ai.model')).toHaveValue('deepseek-v4-flash');
    expect(screen.queryByText('settings.ai.connectionSuccess:1')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('settings.ai.model'));
    expect(screen.queryByRole('option', { name: 'stale-ollama-model' })).not.toBeInTheDocument();
  });

  it('ignores a model response from before the dialog was closed and reopened', async () => {
    const user = userEvent.setup();
    const pendingModels = deferred<string[]>();
    mocks.invokeListAiModels.mockReturnValueOnce(pendingModels.promise);
    const provider = { ...useAiSettingsStore.getState().providers[0], model: '' };
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const { rerender } = render(
      <ProviderSetupDialog
        open
        provider={provider}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'settings.ai.loadModels' }));
    await waitFor(() => expect(mocks.invokeListAiModels).toHaveBeenCalledTimes(1));
    rerender(
      <ProviderSetupDialog
        open={false}
        provider={provider}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    );
    rerender(
      <ProviderSetupDialog
        open
        provider={provider}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    );
    await act(async () => {
      pendingModels.resolve(['stale-model']);
      await pendingModels.promise;
    });

    expect(screen.getByLabelText('settings.ai.model')).toHaveValue('');
    expect(screen.queryByText('settings.ai.connectionSuccess:1')).not.toBeInTheDocument();
  });

  it('ignores a model response after changing the provider being edited', async () => {
    const user = userEvent.setup();
    const pendingModels = deferred<string[]>();
    mocks.invokeListAiModels.mockReturnValueOnce(pendingModels.promise);
    const [firstProvider, secondProvider] = useAiSettingsStore.getState().providers;
    const providerA = { ...firstProvider, model: '' };
    const providerB = { ...secondProvider, model: '' };
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const { rerender } = render(
      <ProviderSetupDialog
        open
        provider={providerA}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'settings.ai.loadModels' }));
    await waitFor(() => expect(mocks.invokeListAiModels).toHaveBeenCalledTimes(1));
    rerender(
      <ProviderSetupDialog
        open
        provider={providerB}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    );
    await act(async () => {
      pendingModels.resolve(['provider-a-model']);
      await pendingModels.promise;
    });

    expect(screen.getByLabelText('settings.ai.providerName')).toHaveValue(providerB.name);
    expect(screen.getByLabelText('settings.ai.baseUrl')).toHaveValue(providerB.baseUrl);
    expect(screen.getByLabelText('settings.ai.model')).toHaveValue('');
    expect(screen.queryByText('settings.ai.connectionSuccess:1')).not.toBeInTheDocument();
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
    const provider = useAiSettingsStore.getState().providers[0];
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
    await user.type(screen.getByLabelText('settings.ai.model'), 'qwen3:8b');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(useAiSettingsStore.getState().providers).toHaveLength(1));
    expect(useAiSettingsStore.getState().providers[0]).toEqual(expect.objectContaining({
      id: provider.id,
      name: 'Renamed provider',
      model: 'qwen3:8b',
    }));
    expect(onSaved).toHaveBeenCalledWith(provider.id);
  });

  it('adds a model to an existing native route without writing legacy settings', async () => {
    mocks.native = true;
    const user = userEvent.setup();
    const provider = useAiSettingsStore.getState().providers[0];
    const resolved = await (await import('@/test/llm-resolver-fixture')).fixtureResolve(
      'ai_resolve_model', { provider },
    ) as import('@/lib/ai/provider-contract').ResolvedModel;
    const routeSave = vi.fn().mockResolvedValue(undefined);
    const route = {
      id: provider.id,
      revision: 2,
      displayName: provider.name,
      adapterId: 'ollama' as const,
      baseUrl: provider.baseUrl,
      auth: { kind: 'none' as const },
      replayDomainId: 'domain',
      presetId: provider.preset,
      models: {
        [provider.model]: {
          contextWindow: resolved.contextWindow,
          maxOutputTokens: resolved.maxOutputTokens,
          toolCalling: resolved.toolCalling,
          textInput: resolved.textInput,
          imageInput: resolved.imageInput,
          reasoning: resolved.reasoning,
          compat: resolved.compat,
          vision: resolved.vision,
        },
      },
      defaults: { routeId: provider.id, modelId: provider.model },
      retryPolicy: DEFAULT_RETRY_POLICY,
      timeouts: { requestHeadersMs: 30_000, firstByteMs: 30_000, streamIdleMs: 300_000 },
    };
    useLlmRoutesStore.setState({
      ...initialRoutesState,
      snapshot: {
        schemaVersion: 1,
        revision: 3,
        migrationComplete: true,
        migrationIssues: [],
        defaultSelection: route.defaults,
        routes: [route],
      },
      modelsByRoute: { [provider.id]: [resolved] },
      status: 'ready',
      save: routeSave,
    }, true);
    const legacyBefore = structuredClone(useAiSettingsStore.getState().providers);

    render(<ProviderSetupDialog open provider={provider} addingModel onOpenChange={vi.fn()} onSaved={vi.fn()} />);
    const model = screen.getByLabelText('settings.ai.model');
    await user.type(model, 'qwen3:8b');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(routeSave).toHaveBeenCalledTimes(1));
    const [routes] = routeSave.mock.calls[0];
    expect(Object.keys(routes[0].models)).toEqual([provider.model, 'qwen3:8b']);
    expect(routes[0].defaults).toEqual({ routeId: provider.id, modelId: 'qwen3:8b' });
    expect(useAiSettingsStore.getState().providers).toEqual(legacyBefore);
    expect(mocks.invokeSavePreferences).not.toHaveBeenCalled();
  });

  it('keeps RouteStore as the sole persisted state when a native save fails', async () => {
    mocks.native=true;
    const provider=useAiSettingsStore.getState().providers[0];
    const resolved=await (await import('@/test/llm-resolver-fixture')).fixtureResolve('ai_resolve_model',{provider}) as import('@/lib/ai/provider-contract').ResolvedModel;
    const routeSave=vi.fn().mockRejectedValue(new Error('REVISION_CONFLICT'));
    useLlmRoutesStore.setState({
      ...initialRoutesState,
      snapshot:{schemaVersion:1,revision:3,migrationComplete:true,migrationIssues:[],defaultSelection:{routeId:provider.id,modelId:provider.model},routes:[{
        id:provider.id,revision:2,displayName:provider.name,adapterId:provider.kind==='ollama'?'ollama':'chat-completions',baseUrl:provider.baseUrl,auth:{kind:'none'},replayDomainId:'domain',presetId:provider.preset,
        models:{[provider.model]:{contextWindow:resolved.contextWindow,maxOutputTokens:resolved.maxOutputTokens,toolCalling:resolved.toolCalling,textInput:resolved.textInput,imageInput:resolved.imageInput,reasoning:resolved.reasoning,compat:resolved.compat,vision:resolved.vision}},
        defaults:{routeId:provider.id,modelId:provider.model},retryPolicy:provider.retryPolicy!,timeouts:{requestHeadersMs:30000,firstByteMs:30000,streamIdleMs:300000},
      }]},
      modelsByRoute:{[provider.id]:[resolved]},status:'ready',save:routeSave,
    },true);
    const before=structuredClone(useAiSettingsStore.getState().providers);
    render(<ProviderSetupDialog open provider={provider} onOpenChange={vi.fn()} onSaved={vi.fn()}/>);
    await userEvent.setup().click(screen.getByRole('button',{name:'common.save'}));
    await waitFor(()=>expect(routeSave).toHaveBeenCalledTimes(1));
    expect(useAiSettingsStore.getState().providers).toEqual(before);
    expect(mocks.invokeSavePreferences).not.toHaveBeenCalled();
    const feedback=await screen.findByRole('alert');
    expect(within(feedback).getByRole('button',{name:/REVISION_CONFLICT/})).toBeVisible();
  });
});

describe('buildProviderRequestEndpoint', () => {
  it('matches the backend endpoint normalization for cloud and local providers', () => {
    expect(buildProviderRequestEndpoint(
      'https://api.deepseek.com',
      'openAiCompatible',
    )).toBe('https://api.deepseek.com/chat/completions');
    expect(buildProviderRequestEndpoint(
      'https://api.minimaxi.com/v1/chat/completions',
      'openAiCompatible',
    )).toBe('https://api.minimaxi.com/v1/chat/completions');
    expect(buildProviderRequestEndpoint(
      'http://127.0.0.1:11434',
      'ollama',
    )).toBe('http://127.0.0.1:11434/api/chat');
    for (const baseUrl of [
      'https://api.anthropic.com',
      'https://api.anthropic.com/v1',
      'https://api.anthropic.com/v1/messages',
    ]) {
      expect(buildProviderRequestEndpoint(baseUrl, 'anthropicMessages'))
        .toBe('https://api.anthropic.com/v1/messages');
    }
  });

  it.each([
    'http://example.com/v1',
    'https://user@example.com/v1',
    'https://user:password@example.com/v1',
    'ftp://example.com/v1',
    'file:///tmp/provider',
  ])('rejects backend-invalid provider URL %s', (baseUrl) => {
    expect(buildProviderRequestEndpoint(baseUrl, 'openAiCompatible')).toBeUndefined();
  });

  it.each([
    ['http://localhost:11434', 'http://localhost:11434/api/chat'],
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/api/chat'],
    ['http://[::1]:11434', 'http://[::1]:11434/api/chat'],
  ])('keeps backend-approved loopback HTTP URL %s', (baseUrl, endpoint) => {
    expect(buildProviderRequestEndpoint(baseUrl, 'ollama')).toBe(endpoint);
  });
});
