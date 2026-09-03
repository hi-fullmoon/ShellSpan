import { useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/hooks/useI18n';
import {
  effectiveReasoningEffort,
  reasoningEffortOptions,
} from '@/lib/ai-reasoning';
import type { LocaleKey } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import type { AiProviderProfile, AiReasoningOption } from '@/types/ai';

type ModelMenuPane = 'root' | 'model' | 'reasoning';

const REASONING_LABEL_KEYS: Record<AiReasoningOption, LocaleKey> = {
  off: 'ai.reasoningEffort.off',
  on: 'ai.reasoningEffort.on',
  none: 'ai.reasoningEffort.off',
  minimal: 'ai.reasoningEffort.minimal',
  low: 'ai.reasoningEffort.low',
  medium: 'ai.reasoningEffort.medium',
  high: 'ai.reasoningEffort.high',
  xhigh: 'ai.reasoningEffort.xhigh',
  max: 'ai.reasoningEffort.max',
};

interface ProviderGroup {
  readonly id: string;
  readonly label: string;
  readonly providers: readonly AiProviderProfile[];
}

function groupProviders(providers: readonly AiProviderProfile[]): readonly ProviderGroup[] {
  const groups = new Map<string, AiProviderProfile[]>();
  for (const provider of providers) {
    if (!provider.model.trim()) continue;
    const key = `${provider.preset}:${provider.name}`;
    const group = groups.get(key) ?? [];
    group.push(provider);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    label: items[0]?.name ?? id,
    providers: items,
  }));
}

export interface AiComposerModelSelectorProps {
  readonly disabled?: boolean;
}

/** Provider-backed model and reasoning selector using the current persisted AI configuration. */
export function AiComposerModelSelector({
  disabled = false,
}: AiComposerModelSelectorProps): React.ReactNode {
  const { t } = useI18n();
  const providers = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const setDefaultProvider = useAiSettingsStore((state) => state.setDefaultProvider);
  const updateProvider = useAiSettingsStore((state) => state.updateProvider);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<ModelMenuPane>('root');
  const groups = useMemo(() => groupProviders(providers), [providers]);
  const current = providers.find((provider) => provider.id === defaultProviderId)
    ?? providers[0];
  const reasoningOptions = current ? reasoningEffortOptions(current) : [];
  const reasoning = current ? effectiveReasoningEffort(current) : undefined;
  const modelLabel = current?.model.trim() || t('ai.modelMissing');
  const reasoningLabel = reasoning
    ? t(REASONING_LABEL_KEYS[reasoning])
    : t('ai.reasoningEffort.default');
  const hasReasoning = reasoningOptions.length > 0;
  const triggerLabel = hasReasoning
    ? `${modelLabel} · ${reasoningLabel}`
    : modelLabel;

  const close = (): void => {
    setOpen(false);
    setPane('root');
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setPane('root');
      }}
    >
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="xs"
            className="ai-model-trigger"
            disabled={disabled || current === undefined || groups.length === 0}
            aria-label={t('ai.workspace.model.trigger', { selection: triggerLabel })}
            title={triggerLabel}
          />
        )}
      >
        <span className="ai-model-trigger-name">{modelLabel}</span>
        {hasReasoning && (
          <span className="ai-model-trigger-reasoning">{reasoningLabel}</span>
        )}
        <ChevronDownIcon
          data-icon="inline-end"
          data-open={open ? '' : undefined}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        sideOffset={8}
        align="end"
        className="ai-model-menu"
        aria-label={t('ai.workspace.model.menu')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || pane === 'root') return;
          event.preventDefault();
          event.stopPropagation();
          setPane('root');
        }}
      >
        {pane === 'root' && (
          <DropdownMenuGroup>
            <DropdownMenuItem
              closeOnClick={false}
              className="ai-model-menu-cell"
              onClick={() => setPane('model')}
            >
              <span>{t('ai.workspace.model.model')}</span>
              <span data-slot="ai-model-menu-value">{modelLabel}</span>
              <ChevronRightIcon />
            </DropdownMenuItem>
            {hasReasoning && (
              <DropdownMenuItem
                closeOnClick={false}
                className="ai-model-menu-cell"
                onClick={() => setPane('reasoning')}
              >
                <span>{t('ai.workspace.model.reasoning')}</span>
                <span data-slot="ai-model-menu-value">{reasoningLabel}</span>
                <ChevronRightIcon />
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        )}

        {pane === 'model' && groups.map((group) => (
          <DropdownMenuGroup key={group.id}>
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={defaultProviderId}
              onValueChange={(providerId) => {
                setDefaultProvider(providerId);
                close();
              }}
            >
              {group.providers.map((provider) => (
                <DropdownMenuRadioItem
                  key={provider.id}
                  value={provider.id}
                  closeOnClick
                  className="ai-model-menu-option"
                >
                  <span className="truncate">{provider.model}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        ))}

        {pane === 'reasoning' && current && (
          <DropdownMenuGroup>
            <DropdownMenuRadioGroup
              value={reasoning ?? 'provider-default'}
              onValueChange={(value) => {
                updateProvider(current.id, {
                  reasoningEffort: value === 'provider-default'
                    ? undefined
                    : value as AiReasoningOption,
                });
                close();
              }}
            >
              <DropdownMenuRadioItem
                value="provider-default"
                closeOnClick
                className="ai-model-menu-option"
              >
                <span>{t('ai.reasoningEffort.default')}</span>
              </DropdownMenuRadioItem>
              {reasoningOptions.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  closeOnClick
                  className="ai-model-menu-option"
                >
                  <span>{t(REASONING_LABEL_KEYS[option])}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
