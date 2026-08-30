import React, { useMemo, useState } from 'react';
import {
  HistoryIcon,
  SearchIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import type { AiConversation } from '@/types/ai';

interface CurrentConversationItem {
  id: string;
  title: string;
  updatedAt?: string;
}

interface ConversationHistoryDialogProps {
  currentConversation?: CurrentConversationItem;
  conversations: AiConversation[];
  selectedConversationId: string | null;
  onSelectCurrent: () => void;
  onSelectConversation: (conversation: AiConversation) => void;
  onDeleteConversations: (conversations: AiConversation[]) => Promise<number>;
}

interface DeleteTarget {
  conversations: AiConversation[];
}

function conversationSearchText(conversation: AiConversation): string {
  return [
    conversation.title,
    conversation.host,
    conversation.username,
    new Date(conversation.updatedAt).toLocaleString(),
  ].join(' ').toLocaleLowerCase();
}

export const ConversationHistoryDialog: React.FC<ConversationHistoryDialogProps> = ({
  currentConversation,
  conversations,
  selectedConversationId,
  onSelectCurrent,
  onSelectConversation,
  onDeleteConversations,
}) => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [deleting, setDeleting] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredConversations = useMemo(() => (
    normalizedQuery
      ? conversations.filter((conversation) => (
        conversationSearchText(conversation).includes(normalizedQuery)
      ))
      : conversations
  ), [conversations, normalizedQuery]);

  const selectCurrent = (): void => {
    onSelectCurrent();
    setOpen(false);
  };

  const selectConversation = (conversation: AiConversation): void => {
    onSelectConversation(conversation);
    setOpen(false);
  };

  const confirmDelete = (): void => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleteTarget(undefined);
    setDeleting(true);
    void onDeleteConversations(target.conversations)
      .then((count) => {
        showSuccess(t('ai.history.deleted', { count }));
      })
      .catch(() => {
        showError(t('ai.history.deleteFailed'));
      })
      .finally(() => setDeleting(false));
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery('');
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={(
              <DialogTrigger
                render={(
                  <Button
                    variant={selectedConversationId ? 'secondary' : 'ghost'}
                    size="sm"
                    className="size-8 p-0"
                    aria-label={t('ai.history')}
                  />
                )}
              />
            )}
          >
            <HistoryIcon />
          </TooltipTrigger>
          <TooltipContent>{t('ai.history')}</TooltipContent>
        </Tooltip>
        <CompactDialogContent className="h-[min(640px,calc(100vh-2rem))] max-w-md">
          <CompactDialogHeader
            title={t('ai.history')}
            description={t('ai.history.description', { count: conversations.length })}
          />
          <div className="shrink-0 px-4 pt-3">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                aria-label={t('ai.history.search')}
                placeholder={t('ai.history.searchPlaceholder')}
              />
            </div>
          </div>
          <CompactDialogBody className="flex-1 gap-4">
            {currentConversation && !normalizedQuery && (
              <section className="flex flex-col gap-1">
                <span className="px-2 text-xs font-medium text-muted-foreground">
                  {t('ai.history.current')}
                </span>
                <Button
                  variant={selectedConversationId ? 'ghost' : 'secondary'}
                  className="h-auto w-full justify-start px-2 py-2 text-left"
                  onClick={selectCurrent}
                >
                  <SquareTerminalIcon data-icon="inline-start" />
                  <span className="min-w-0 truncate">{currentConversation.title}</span>
                </Button>
              </section>
            )}
            <section className="flex min-h-0 flex-col gap-1">
              <span className="px-2 text-xs font-medium text-muted-foreground">
                {t('ai.history.archived')}
              </span>
              {filteredConversations.length === 0 ? (
                <EmptyState
                  className="min-h-48"
                  icon={<HistoryIcon />}
                  title={normalizedQuery ? t('ai.history.noResults') : t('ai.history.empty')}
                />
              ) : (
                filteredConversations.map((conversation) => (
                  <div key={conversation.id} className="flex min-w-0 items-center gap-1">
                    <Button
                      variant={selectedConversationId === conversation.id ? 'secondary' : 'ghost'}
                      className="h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left"
                      onClick={() => selectConversation(conversation)}
                      disabled={deleting}
                    >
                      <HistoryIcon data-icon="inline-start" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{conversation.title}</span>
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          {new Date(conversation.updatedAt).toLocaleString()}
                        </span>
                      </span>
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={(
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0"
                            disabled={deleting}
                            onClick={() => setDeleteTarget({
                              conversations: [conversation],
                            })}
                            aria-label={t('ai.history.deleteLabel', {
                              title: conversation.title,
                            })}
                          />
                        )}
                      >
                        <Trash2Icon />
                      </TooltipTrigger>
                      <TooltipContent>{t('common.delete')}</TooltipContent>
                    </Tooltip>
                  </div>
                ))
              )}
            </section>
          </CompactDialogBody>
          <CompactDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
          </CompactDialogFooter>
        </CompactDialogContent>
      </Dialog>
      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(undefined);
        }}
        title={t('ai.history.deleteConfirmTitle')}
        description={t('ai.history.deleteConfirmDescription', {
          title: deleteTarget?.conversations[0]?.title ?? '',
        })}
        onConfirm={confirmDelete}
      />
    </>
  );
};
