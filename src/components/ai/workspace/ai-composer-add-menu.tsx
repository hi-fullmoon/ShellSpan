import { useRef, useState } from 'react';
import { PlusIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroupButton } from '@/components/ui/input-group';
import { useI18n } from '@/hooks/useI18n';
import { AiComposerMenuRow, useComposerMenuGroups } from './ai-composer-menu-content';
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

export function AiComposerAddMenu({
  disabled,
  agent,
  anchor,
  onAddFile,
  onAddFolder,
  onSkill,
}: {
  readonly disabled: boolean;
  readonly agent: boolean;
  readonly anchor: React.RefObject<HTMLDivElement | null>;
  readonly onAddFile: () => void;
  readonly onAddFolder: () => void;
  readonly onSkill: (name: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pendingFolder = useRef(false);
  const groups = useComposerMenuGroups({ agent, onAddFile, onSkill,
    onAddFolder: () => { pendingFolder.current = true; setOpen(false); },
  });
  return (
    <DropdownMenu open={open && !disabled} onOpenChange={setOpen}
      onOpenChangeComplete={value => {
        if (!value && pendingFolder.current) {
          pendingFolder.current = false;
          if (!disabled) onAddFolder();
        }
      }}>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            variant="ghost"
            size="icon-sm"
            className="ai-composer-add size-7 shrink-0 rounded-full"
            aria-label={t('ai.workspace.attachments.add')}
            disabled={disabled}
          />
        }
      >
        <PlusIcon nonScalingStroke strokeWidth={1.2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        finalFocus={() => !pendingFolder.current}
        side="top"
        sideOffset={8}
        align="start"
        anchor={anchor}
        positionMethod="fixed"
        collisionPadding={8}
        collisionAvoidance={{ side: 'none', align: 'shift', fallbackAxisSide: 'none' }}
        className={cn(
          'ai-composer-add-menu flex max-h-(--available-height) min-h-0 w-(--anchor-width) max-w-(--available-width) flex-col overflow-hidden p-0 text-muted-foreground',
          agent && 'h-[360px]',
        )}
      >
        <div className="min-h-0 flex-1 overflow-y-auto" data-composer-menu-scroll="">
          <div className="flex flex-col gap-1 p-2">
            {groups.map(group => <DropdownMenuGroup key={group.label}>
              <DropdownMenuLabel className="py-0.5">{group.label}</DropdownMenuLabel>
              {group.options.map(option => <DropdownMenuItem key={option.key} className="min-h-7 gap-1"
                onClick={option.choose}
                aria-label={option.key.startsWith('skill:') ? option.detail : option.label}
                aria-description={option.key === 'upload'
                  ? `${t('ai.workspace.documents.hint')} ${t('ai.workspace.documents.limits')} ${t('ai.workspace.documents.imageHint')}`
                  : option.key === 'project' ? t('ai.workspace.attachments.projectHint') : option.label}>
                <AiComposerMenuRow option={option} />
              </DropdownMenuItem>)}
              {group.notice && <p className="px-1.5 py-1 text-xs text-muted-foreground">{group.notice}</p>}
            </DropdownMenuGroup>)}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
