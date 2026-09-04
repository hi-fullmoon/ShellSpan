import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group';
import { useI18n } from '@/hooks/useI18n';

/** Explicit project-root selection shared by target-scoped context entry points. */
export function AiProjectDirectoryInput({ targetLabel, value, onChange, onConfirm, loading, actionLabel }: {
  targetLabel?: string;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  loading: boolean;
  actionLabel?: string;
}): React.ReactNode {
  const { t } = useI18n();
  return <div className="flex flex-col gap-2 p-2">
    {targetLabel && <p className="text-sm font-medium">{targetLabel}</p>}
    <p className="text-xs text-muted-foreground">{t('ai.workspace.skills.rootHint')}</p>
    <InputGroup>
      <InputGroupInput aria-label={t('ai.workspace.skills.root')} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); onConfirm(); } }} />
      <InputGroupAddon align="block-end"><InputGroupButton disabled={loading || !value.trim()} onClick={onConfirm}>{actionLabel ?? t('ai.workspace.skills.load')}</InputGroupButton></InputGroupAddon>
    </InputGroup>
  </div>;
}
