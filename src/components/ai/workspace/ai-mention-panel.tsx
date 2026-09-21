import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import type { ComposerHistoryProps } from './ai-composer-add-menu';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import { AiComposerMenuRow } from './ai-composer-menu-content';

export interface MentionContext extends Omit<ComposerHistoryProps, 'onReadSession'> {
  readonly agent: boolean;
  readonly onUpload: () => void;
  readonly onSession?: (summary: AiSessionSummary) => void;
}
export interface MentionOption {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly inlineDetail?: boolean;
  readonly searchText?: string;
  readonly icon: ReactNode;
  readonly choose: () => void;
  readonly enterDirectory?: () => void;
}
export interface MentionGroup {
  readonly label: string;
  readonly options: readonly MentionOption[];
  readonly notice?: ReactNode;
  readonly showEmptyLabel?: boolean;
}

export function AiMentionPanel({ id, groups, index, onIndexChange, empty, header }: {
  readonly id: string; readonly groups: readonly MentionGroup[]; readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly empty: boolean;
  readonly header?: ReactNode;
}) {
  const { t } = useI18n();
  let offset = 0;
  return <div data-mention-completion="" className="flex h-full min-h-0 flex-col text-muted-foreground">
    {header && <div className="shrink-0 px-3.5 pt-3 pb-1 text-xs text-muted-foreground">{header}</div>}
    <div id={id} role="listbox" aria-label={t('ai.workspace.mentions.title')} className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-1 p-2">
      {groups.map(group => group.options.length === 0 && !group.showEmptyLabel
        ? group.notice && <div key={group.label} role="status" className="px-1.5 py-1 text-xs text-muted-foreground">{group.notice}</div>
        : <div key={group.label} role="group" aria-label={group.label}>
        <p className="px-1.5 py-0.5 text-xs font-medium">{group.label}</p>
        {group.options.map(option => {
          const position = offset++;
          return <Button key={option.key} id={`${id}-${position}`} type="button" role="option" tabIndex={-1}
            aria-label={option.label} aria-description={option.detail} aria-selected={position === index}
            variant={position === index ? 'secondary' : 'ghost'} size="sm"
            className="h-auto min-h-7 w-full min-w-0 justify-start gap-1 px-1.5 py-1 text-sm leading-5 font-normal"
            onMouseEnter={() => onIndexChange(position)}
            onMouseDown={event => event.preventDefault()} onClick={option.choose}>
            <AiComposerMenuRow option={option} />
          </Button>;
        })}
        {group.notice && <div role="status" className="px-1.5 py-1 text-xs text-muted-foreground">{group.notice}</div>}
      </div>)}
      {empty && <EmptyState title={t('ai.workspace.addMenu.noMatch')} />}
      </div>
    </div>
  </div>;
}
