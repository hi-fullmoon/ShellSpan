import React, { useEffect, useState } from 'react';
import { CheckCircle2Icon, KeyRoundIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import {
  invokeDeleteAiApiKey,
  invokeHasAiApiKey,
  invokeListAiModels,
  invokeStoreAiApiKey,
} from '@/lib/tauri';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import type { AiProviderKind } from '@/types/ai';

export const AiSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const providerKind = useAiSettingsStore((state) => state.providerKind);
  const setProviderKind = useAiSettingsStore((state) => state.setProviderKind);
  const setBaseUrl = useAiSettingsStore((state) => state.setBaseUrl);
  const setModel = useAiSettingsStore((state) => state.setModel);
  const contextLines = useAiSettingsStore((state) => state.contextLines);
  const setContextLines = useAiSettingsStore((state) => state.setContextLines);
  const baseUrl = useAiSettingsStore((state) =>
    state.providerKind === 'ollama' ? state.ollamaBaseUrl : state.openAiBaseUrl,
  );
  const model = useAiSettingsStore((state) =>
    state.providerKind === 'ollama' ? state.ollamaModel : state.openAiModel,
  );
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setError(undefined);
    setSuccess(undefined);
    if (providerKind === 'ollama') {
      setHasApiKey(false);
      return;
    }
    void invokeHasAiApiKey('openai')
      .then((value) => {
        if (!cancelled) setHasApiKey(value);
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerKind]);

  const handleSaveKey = async (): Promise<void> => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await invokeStoreAiApiKey('openai', apiKey);
      setApiKey('');
      setHasApiKey(true);
      setSuccess(t('settings.ai.keySaved'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteKey = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await invokeDeleteAiApiKey('openai');
      setHasApiKey(false);
      setSuccess(t('settings.ai.keyDeleted'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const found = await invokeListAiModels(useAiSettingsStore.getState().getProviderConfig());
      setModels(found);
      setSuccess(t('settings.ai.connectionSuccess', { count: found.length }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('settings.ai.title')}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('settings.ai.description')}</p>
      </div>

      <FieldGroup>
        <Field>
          <FieldLabel>{t('settings.ai.provider')}</FieldLabel>
          <ToggleGroup
            value={[providerKind]}
            onValueChange={(values) => {
              const value = values[0] as AiProviderKind | undefined;
              if (value) setProviderKind(value);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label={t('settings.ai.provider')}
          >
            <ToggleGroupItem value="ollama">Ollama</ToggleGroupItem>
            <ToggleGroupItem value="openAi">OpenAI</ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>
            {providerKind === 'ollama' ? t('settings.ai.ollamaHint') : t('settings.ai.openAiHint')}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="ai-base-url">{t('settings.ai.baseUrl')}</FieldLabel>
          <Input
            id="ai-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="ai-model">{t('settings.ai.model')}</FieldLabel>
          <Input
            id="ai-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            list="ai-model-options"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <datalist id="ai-model-options">
            {models.map((model) => <option key={model} value={model} />)}
          </datalist>
          <FieldDescription>{t('settings.ai.modelHint')}</FieldDescription>
        </Field>

        {providerKind === 'openAi' && (
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="ai-api-key">{t('settings.ai.apiKey')}</FieldLabel>
              <Badge variant={hasApiKey ? 'secondary' : 'outline'}>
                {hasApiKey ? t('settings.ai.keyStored') : t('settings.ai.keyMissing')}
              </Badge>
            </div>
            <div className="flex gap-2">
              <Input
                id="ai-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={hasApiKey ? t('settings.ai.keyReplacePlaceholder') : 'sk-...'}
                autoComplete="off"
              />
              <Button onClick={() => void handleSaveKey()} disabled={busy || !apiKey.trim()}>
                <KeyRoundIcon data-icon="inline-start" />
                {t('common.save')}
              </Button>
              {hasApiKey && (
                <Button variant="outline" size="icon" onClick={() => void handleDeleteKey()} disabled={busy} aria-label={t('settings.ai.deleteKey')}>
                  <Trash2Icon />
                </Button>
              )}
            </div>
            <FieldDescription>{t('settings.ai.keyHint')}</FieldDescription>
          </Field>
        )}

        <Field>
          <FieldLabel>{t('settings.ai.contextLines')}</FieldLabel>
          <Select value={String(contextLines)} onValueChange={(value) => setContextLines(Number(value))}>
            <SelectTrigger aria-label={t('settings.ai.contextLines')}>
              <SelectValue>{t('settings.ai.contextLinesValue', { count: contextLines })}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[50, 100, 200, 500].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {t('settings.ai.contextLinesValue', { count })}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>{t('settings.ai.contextHint')}</FieldDescription>
        </Field>

        <Field data-invalid={Boolean(error)}>
          <Button variant="outline" onClick={() => void handleTest()} disabled={busy || !baseUrl.trim()}>
            {busy ? <Spinner /> : <RefreshCwIcon data-icon="inline-start" />}
            {t('settings.ai.testConnection')}
          </Button>
          <FieldError>{error}</FieldError>
        </Field>
      </FieldGroup>

      {success && (
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>{t('settings.ai.ready')}</AlertTitle>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}
    </div>
  );
};
