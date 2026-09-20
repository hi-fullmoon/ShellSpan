import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { ComposerHistoryProps } from './ai-composer-add-menu';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';

export interface MentionContext extends Omit<ComposerHistoryProps, 'onReadSession'> {
  readonly agent: boolean;
  readonly onUpload: () => void;
  readonly onSession?: (summary: AiSessionSummary) => void;
}
export interface MentionOption {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly icon: ReactNode;
  readonly choose: () => void;
}
export interface MentionGroup {
  readonly label: string;
  readonly options: readonly MentionOption[];
  readonly notice?: ReactNode;
}

export function AiMentionPanel({ id, groups, index, empty }: {
  readonly id: string; readonly groups: readonly MentionGroup[]; readonly index: number;
  readonly empty: boolean;
}) {
  const { t } = useI18n();
  let offset = 0;
  return <div data-mention-completion="" className="flex h-full min-h-0 flex-col text-muted-foreground">
    <div id={id} role="listbox" aria-label={t('ai.workspace.mentions.title')} className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-1 p-2">
      {groups.map(group => group.options.length === 0
        ? group.notice && <div key={group.label} role="status" className="px-1.5 py-1 text-xs text-muted-foreground">{group.notice}</div>
        : <div key={group.label} role="group" aria-label={group.label} className="mb-0.5">
        <p className="px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{group.label}</p>
        {group.options.map(option => {
          const position = offset++;
          return <Button key={option.key} id={`${id}-${position}`} type="button" role="option" tabIndex={-1}
            aria-label={option.label} aria-description={option.detail} aria-selected={position === index}
            variant={position === index ? 'secondary' : 'ghost'} size="sm"
            className="h-7 w-full min-w-0 justify-start gap-1.5 px-1.5"
            onMouseDown={event => event.preventDefault()} onClick={option.choose}>
            {option.icon}<span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
            {option.detail && <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs font-normal text-muted-foreground">{option.detail}</span>}
          </Button>;
        })}
        {group.notice && <div role="status" className="px-1.5 py-1 text-xs text-muted-foreground">{group.notice}</div>}
      </div>)}
      {empty && <EmptyState title={t('ai.workspace.addMenu.noMatch')} />}
      </div>
    </div>
  </div>;
}
