import { useState } from 'react';
import { BookOpenIcon, FilePlusIcon, FolderPlusIcon, PlusIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { InputGroupButton } from '@/components/ui/input-group';
import { useI18n } from '@/hooks/useI18n';
import { builtinSkills } from '@/lib/ai/builtin-skills';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import { cn } from '@/lib/utils';

export interface ComposerHistoryProps {
  readonly sessions?: readonly AiSessionSummary[];
  readonly sessionsLoading?: boolean;
  readonly sessionsError?: string | null;
  readonly currentSessionId?: string | null;
  readonly onRefreshSessions?: () => void;
  readonly onReadSession?: (summary: AiSessionSummary, signal: AbortSignal) => Promise<File>;
}

export function AiComposerAddMenu({ disabled, agent, anchor, onAddFile, onAddFolder, onSkill,
}: {
  readonly disabled: boolean;
  readonly agent: boolean;
  readonly anchor: React.RefObject<HTMLDivElement | null>;
  readonly onAddFile: () => void;
  readonly onAddFolder: () => void;
  readonly onSkill: (name: string) => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  return <DropdownMenu open={open && !disabled} onOpenChange={setOpen}>
    <DropdownMenuTrigger render={<InputGroupButton variant="ghost" size="icon-sm" className="ai-composer-add size-7 shrink-0 rounded-full" aria-label={t('ai.workspace.attachments.add')} disabled={disabled} />}>
      <PlusIcon />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" sideOffset={8} align="start"
      anchor={anchor} positionMethod="fixed" collisionPadding={8}
      collisionAvoidance={{ side: 'none', align: 'shift', fallbackAxisSide: 'none' }}
      className={cn('ai-composer-add-menu flex max-h-(--available-height) min-h-0 w-(--anchor-width) max-w-(--available-width) flex-col overflow-hidden p-0 text-muted-foreground', agent && 'h-[360px]')}>
      <div className="min-h-0 flex-1 overflow-y-auto" data-composer-menu-scroll="">
        <div className="flex flex-col gap-1 p-2">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="py-0.5">{t('ai.workspace.addMenu.add')}</DropdownMenuLabel>
            <DropdownMenuItem className="min-h-7 gap-1.5" onClick={onAddFile} aria-label={t('ai.workspace.attachments.file')}
              title={`${t('ai.workspace.documents.hint')} ${t('ai.workspace.documents.limits')} ${t('ai.workspace.documents.imageHint')}`}>
              <FilePlusIcon /><span className="shrink-0">{t('ai.workspace.attachments.file')}</span>
              <span className="truncate text-xs text-muted-foreground">{t('ai.workspace.addMenu.fileHint')}</span>
            </DropdownMenuItem>
            {agent && <DropdownMenuItem className="min-h-7 gap-1.5" onClick={onAddFolder} aria-label={t('ai.workspace.attachments.folder')}
              aria-description={t('ai.workspace.attachments.projectHint')}>
              <FolderPlusIcon /><span className="shrink-0">{t('ai.workspace.attachments.folder')}</span>
              <span className="truncate text-xs text-muted-foreground">{t('ai.workspace.addMenu.folderHint')}</span>
            </DropdownMenuItem>}
          </DropdownMenuGroup>
          {agent && <DropdownMenuGroup>
            <DropdownMenuLabel className="py-0.5">{t('ai.workspace.skills.title')}</DropdownMenuLabel>
            {builtinSkills.map(skill => <DropdownMenuItem key={skill.name} className="min-h-7 gap-1.5"
              aria-label={`/${skill.name}`} aria-description={locale === 'zh-CN' ? skill.descriptionZh : skill.description}
              onClick={() => onSkill(skill.name)}>
              <BookOpenIcon />
              <span className="min-w-0 flex-1 truncate">{locale === 'zh-CN' ? skill.descriptionZh : skill.description}</span>
              <span className="shrink-0 text-xs text-muted-foreground">/{skill.name}</span>
            </DropdownMenuItem>)}
          </DropdownMenuGroup>}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="py-0.5">{t('ai.workspace.addMenu.history')}</DropdownMenuLabel>
            <p className="px-1.5 py-1 text-xs text-muted-foreground">{t(agent ? 'ai.workspace.addMenu.mentionSearchHint' : 'ai.workspace.addMenu.searchHistoryHint')}</p>
          </DropdownMenuGroup>
        </div>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}
