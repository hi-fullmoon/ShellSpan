import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDownIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Dialog } from '@/components/ui/dialog';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import type { DiscoveredModel, ModelDefinition } from '@/lib/ai/provider-contract';

export interface ProviderModelDraft {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  definition?: ModelDefinition;
}

export type ModelCatalogFailure =
  | { kind: 'empty' }
  | { kind: 'missingId'; index: number }
  | { kind: 'duplicateId'; index: number }
  | { kind: 'invalidDefinition'; index: number };

export function validateProviderModels(models: readonly ProviderModelDraft[]): ModelCatalogFailure | undefined {
  if (models.length === 0) return { kind: 'empty' };
  const ids = new Set<string>();
  for (const [index, model] of models.entries()) {
    const id = model.id.trim();
    if (!id) return { kind: 'missingId', index };
    if (ids.has(id)) return { kind: 'duplicateId', index };
    ids.add(id);
    const definition = model.definition;
    const contextWindow = model.contextWindow ?? definition?.contextWindow;
    const maxOutputTokens = model.maxOutputTokens ?? definition?.maxOutputTokens;
    if (
      (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0))
      || (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0))
      || (contextWindow !== undefined && maxOutputTokens !== undefined && maxOutputTokens > contextWindow)
      || (definition?.vision !== undefined && (
        definition.imageInput !== 'supported'
        || !Number.isSafeInteger(definition.vision.maxRequestImages)
        || definition.vision.maxRequestImages <= 0
        || definition.vision.maxRequestImages > 20
        || !Number.isSafeInteger(definition.vision.maxRequestImageBytes)
        || definition.vision.maxRequestImageBytes <= 0
        || definition.vision.maxRequestImageBytes > 20_971_520
        || !Number.isSafeInteger(definition.vision.reservedTokensPerImage)
        || definition.vision.reservedTokensPerImage <= 0
        || (contextWindow !== undefined && definition.vision.reservedTokensPerImage > contextWindow)
        || !definition.vision.imageTokenBudgetPolicy.trim()
      ))
      || (definition !== undefined
        && (definition.imageInput === 'supported') !== Boolean(definition.vision))
    ) return { kind: 'invalidDefinition', index };
  }
  return undefined;
}

interface ProviderModelCatalogEditorProps {
  models: readonly ProviderModelDraft[];
  defaultModelId: string;
  inherited: boolean;
  canReset: boolean;
  disabled: boolean;
  discovering: boolean;
  discoveryError?: string;
  onChange: (models: ProviderModelDraft[]) => void;
  onDefaultChange: (modelId: string) => void;
  onDiscover: () => Promise<DiscoveredModel[] | undefined>;
  onDeclare: (index: number) => Promise<void>;
  onReset: () => void;
}

function failureMessage(
  failure: ModelCatalogFailure | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string | undefined {
  if (!failure) return undefined;
  if (failure.kind === 'empty') return t('settings.ai.modelsRequired');
  const number = failure.index + 1;
  if (failure.kind === 'missingId') return t('settings.ai.modelIdRequired', { number });
  if (failure.kind === 'duplicateId') return t('settings.ai.modelIdDuplicate', { number });
  return t('settings.ai.modelDefinitionInvalid', { number });
}

export const ProviderModelCatalogEditor: React.FC<ProviderModelCatalogEditorProps> = ({
  models,
  defaultModelId,
  inherited,
  canReset,
  disabled,
  discovering,
  discoveryError,
  onChange,
  onDefaultChange,
  onDiscover,
  onDeclare,
  onReset,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [candidates, setCandidates] = useState<readonly DiscoveredModel[]>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [pickerError, setPickerError] = useState<string>();
  useEffect(() => { setPickerError(undefined); }, [models, discoveryError]);
  const failure = validateProviderModels(models);
  const visibleCandidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return candidates ?? [];
    return (candidates ?? []).filter((model) => model.id.toLowerCase().includes(normalized)
      || model.name?.toLowerCase().includes(normalized) === true);
  }, [candidates, query]);
  const allVisibleSelected = visibleCandidates.length > 0
    && visibleCandidates.every((model) => selected.has(model.id));

  const patchModel = (index: number, patch: Partial<ProviderModelDraft>): void => {
    onChange(models.map((model, at) => at === index ? { ...model, ...patch } : model));
  };

  const removeModel = (index: number): void => {
    onChange(models.filter((_model, at) => at !== index));
    setExpanded((current) => {
      const next = new Set<number>();
      for (const at of current) {
        if (at < index) next.add(at);
        if (at > index) next.add(at - 1);
      }
      return next;
    });
  };

  const openPicker = async (): Promise<void> => {
    setPickerError(undefined);
    try {
      const found = await onDiscover();
      if (found === undefined) return;
      const unique = [...new Map(found.map((model) => [model.id, model])).values()];
      if (unique.length === 0) {
        setPickerError(t('settings.ai.modelsDiscoveryEmpty'));
        return;
      }
      const known = new Set(models.map((model) => model.id));
      setCandidates(unique);
      setSelected(new Set(unique.filter((model) => !known.has(model.id)).map((model) => model.id)));
      setQuery('');
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
    }
  };

  const closePicker = (): void => {
    setCandidates(undefined);
    setSelected(new Set());
    setQuery('');
  };

  const adoptSelected = (): void => {
    const byId = new Map(models.map((model) => [model.id, model]));
    for (const candidate of candidates ?? []) {
      if (!selected.has(candidate.id) || byId.has(candidate.id)) continue;
      byId.set(candidate.id, {
        id: candidate.id,
        ...(candidate.name ? { displayName: candidate.name } : {}),
        ...(candidate.contextWindow ? { contextWindow: candidate.contextWindow } : {}),
        ...(candidate.maxOutputTokens ? { maxOutputTokens: candidate.maxOutputTokens } : {}),
      });
    }
    onChange([...byId.values()]);
    closePicker();
  };

  const toggleVisible = (): void => {
    setSelected((current) => {
      if (visibleCandidates.every((model) => current.has(model.id))) return new Set();
      const next = new Set(current);
      for (const model of visibleCandidates) next.add(model.id);
      return next;
    });
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t('settings.ai.modelCatalog')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">{t('settings.ai.modelCatalog')}</span>
            <span className="text-xs text-muted-foreground">
              {t(inherited ? 'settings.ai.modelsInherited' : 'settings.ai.modelsCustomized')}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">{t('settings.ai.modelCatalogDescription')}</span>
        </div>
        <div className="flex items-center gap-1">
          {!inherited && canReset && (
            <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onReset}>
              {t('settings.ai.resetModels')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled || discovering}
            onClick={() => void openPicker()}
          >
            {discovering
              ? <Spinner data-icon="inline-start" />
              : <RefreshCwIcon data-icon="inline-start" />}
            {t(discovering ? 'settings.ai.loadingModels' : 'settings.ai.loadModels')}
          </Button>
        </div>
      </div>

      <Field>
        <FieldLabel htmlFor="ai-provider-default-model">{t('settings.ai.defaultModel')}</FieldLabel>
        <Select value={defaultModelId || null} onValueChange={(value) => value && onDefaultChange(value)}>
          <SelectTrigger id="ai-provider-default-model" size="sm" disabled={disabled || models.length === 0}>
            <SelectValue placeholder={t('settings.ai.chooseDefaultModel')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {models.filter((model) => model.id.trim()).map((model) => (
                <SelectItem key={model.id} value={model.id}>{model.id}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <div className="flex flex-col gap-2">
        {models.map((model, index) => {
          const open = expanded.has(index);
          const idInvalid = failure?.kind !== 'empty' && failure?.index === index
            && (failure.kind === 'missingId' || failure.kind === 'duplicateId');
          const definitionInvalid = failure?.kind === 'invalidDefinition' && failure.index === index;
          return (
            <Collapsible
              key={index}
              open={open}
              onOpenChange={(nextOpen) => setExpanded((current) => {
                const next = new Set(current);
                if (nextOpen) next.add(index);
                else next.delete(index);
                return next;
              })}
              className="rounded-lg border bg-background"
            >
              <FieldGroup className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] items-end gap-1 p-2">
                <Field data-invalid={idInvalid || undefined}>
                  <FieldLabel className="sr-only" htmlFor={`ai-model-id-${index}`}>
                    {t('settings.ai.modelIdNumber', { number: index + 1 })}
                  </FieldLabel>
                  <Input
                    id={`ai-model-id-${index}`}
                    value={model.id}
                    aria-invalid={idInvalid || undefined}
                    placeholder={t('settings.ai.modelId')}
                    disabled={disabled}
                    className="h-8 bg-transparent"
                    autoCapitalize="none"
                    autoCorrect="off"
                    onChange={(event) => patchModel(index, { id: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel className="sr-only" htmlFor={`ai-model-name-${index}`}>
                    {t('settings.ai.modelNameNumber', { number: index + 1 })}
                  </FieldLabel>
                  <Input
                    id={`ai-model-name-${index}`}
                    value={model.displayName ?? ''}
                    placeholder={t('settings.ai.modelName')}
                    disabled={disabled}
                    className="h-8 bg-transparent"
                    onChange={(event) => patchModel(index, {
                      displayName: event.target.value,
                    })}
                  />
                </Field>
                <div className="flex items-center gap-1 pb-0.5">
                <CollapsibleTrigger
                  render={(
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('settings.ai.modelAdvancedNumber', { number: index + 1 })}
                    />
                  )}
                >
                  <ChevronDownIcon className={cn('transition-transform', open && 'rotate-180')} />
                </CollapsibleTrigger>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings.ai.removeModelNumber', { number: index + 1 })}
                  disabled={disabled}
                  onClick={() => removeModel(index)}
                >
                  <Trash2Icon />
                </Button>
                </div>
              </FieldGroup>
              <CollapsibleContent>
                <FieldGroup className="border-t p-3 @container/model-row @min-[28rem]/model-row:grid @min-[28rem]/model-row:grid-cols-2">
                  <Field data-invalid={definitionInvalid || undefined}>
                    <FieldLabel htmlFor={`ai-model-context-${index}`}>{t('settings.ai.contextWindow')}</FieldLabel>
                    <Input
                      id={`ai-model-context-${index}`}
                      type="number"
                      min={1}
                      step={1}
                      value={model.contextWindow ?? model.definition?.contextWindow ?? ''}
                      aria-invalid={definitionInvalid || undefined}
                      disabled={disabled}
                      onChange={(event) => patchModel(index, {
                        contextWindow: event.target.value ? Number(event.target.value) : undefined,
                      })}
                    />
                  </Field>
                  <Field data-invalid={definitionInvalid || undefined}>
                    <FieldLabel htmlFor={`ai-model-output-${index}`}>{t('settings.ai.maxOutput')}</FieldLabel>
                    <Input
                      id={`ai-model-output-${index}`}
                      type="number"
                      min={1}
                      step={1}
                      value={model.maxOutputTokens ?? model.definition?.maxOutputTokens ?? ''}
                      aria-invalid={definitionInvalid || undefined}
                      disabled={disabled}
                      onChange={(event) => patchModel(index, {
                        maxOutputTokens: event.target.value ? Number(event.target.value) : undefined,
                      })}
                    />
                  </Field>
                  {!model.definition && (
                    <Field className="@min-[28rem]/model-row:col-span-2">
                      <FieldDescription>{t('settings.ai.modelUsesCatalog')}</FieldDescription>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={disabled || !model.id.trim()}
                        onClick={() => void onDeclare(index)}
                      >
                        {t('settings.ai.declareModel')}
                      </Button>
                    </Field>
                  )}
                </FieldGroup>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full border-dashed"
        disabled={disabled}
        onClick={() => {
          onChange([...models, { id: '' }]);
          setExpanded((current) => new Set(current).add(models.length));
        }}
      >
        <PlusIcon data-icon="inline-start" />
        {t('settings.ai.addModel')}
      </Button>
      <FieldError>{failureMessage(failure, t)}</FieldError>
      {(pickerError ?? discoveryError) && <FieldError>{pickerError ?? discoveryError}</FieldError>}

      <Dialog open={candidates !== undefined} onOpenChange={(open) => { if (!open) closePicker(); }}>
        <CompactDialogContent className="max-w-lg" showCloseButton={false}>
          <CompactDialogHeader
            title={t('settings.ai.chooseModelsTitle')}
            description={t('settings.ai.chooseModelsDescription')}
          />
          <CompactDialogBody className="gap-3">
            <div className="flex items-center gap-2">
              <InputGroup className="flex-1">
                <InputGroupAddon><SearchIcon /></InputGroupAddon>
                <InputGroupInput
                  type="search"
                  value={query}
                  aria-label={t('settings.ai.searchModels')}
                  placeholder={t('settings.ai.searchModels')}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </InputGroup>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={visibleCandidates.length === 0}
                onClick={toggleVisible}
              >
                {t(allVisibleSelected ? 'settings.ai.deselectAll' : 'settings.ai.selectAll')}
              </Button>
            </div>
            {visibleCandidates.length === 0 ? (
              <p role="status" className="py-6 text-center text-xs text-muted-foreground">
                {t('settings.ai.modelNoResults')}
              </p>
            ) : (
              <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {visibleCandidates.map((model) => (
                  <Field
                    key={model.id}
                    className="flex-row items-center rounded-md px-2 py-2 hover:bg-muted/60"
                  >
                    <Checkbox
                      id={`ai-model-candidate-${model.id}`}
                      checked={selected.has(model.id)}
                      onCheckedChange={() => setSelected((current) => {
                        const next = new Set(current);
                        if (!next.delete(model.id)) next.add(model.id);
                        return next;
                      })}
                    />
                    <FieldLabel
                      htmlFor={`ai-model-candidate-${model.id}`}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-foreground"
                    >
                      <span className="truncate">{model.id}</span>
                      {model.name && <span className="truncate text-muted-foreground">{model.name}</span>}
                    </FieldLabel>
                  </Field>
                ))}
              </div>
            )}
          </CompactDialogBody>
          <CompactDialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={closePicker}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" onClick={adoptSelected}>
              {t('settings.ai.addSelectedModels')}
            </Button>
          </CompactDialogFooter>
        </CompactDialogContent>
      </Dialog>
    </section>
  );
};
