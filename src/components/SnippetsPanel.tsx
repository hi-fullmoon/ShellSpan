import { createPortal } from "react-dom";
import { useState, useRef, useEffect } from "react";
import { useSnippetsStore } from "../stores/snippetsStore";
import { Input } from "@chakra-ui/react";
import { t } from "../lib/i18n";
import { cn } from "../lib/ui";
import type { CommandSnippet } from "../types";
import {
  ScrollArea,
  SnippetsIcon,
  PlusIcon,
  SearchIcon,
  LayoutGridIcon,
  LayoutListIcon,
  ClockIcon,
  SendIcon,
  EditIcon,
  TrashIcon,
  Tooltip,
} from './ui';

interface SnippetsPanelProps {
  onSendCommand: (command: string) => void;
}

function SnippetDialog({
  open,
  snippet,
  onClose,
  onSave,
}: {
  open: boolean;
  snippet?: CommandSnippet;
  onClose: () => void;
  onSave: (name: string, command: string) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(snippet?.name ?? "");
      setCommand(snippet?.command ?? "");
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [open, snippet]);

  if (!open) return null;

  return createPortal(
    <div className="app-overlay" role="presentation">
      <div
        className="surface rounded-lg w-full max-w-sm p-3"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={snippet ? t("snippets.dialog.editTitle") : t("snippets.dialog.title")}
      >
        <div className="flex flex-col gap-1">
          <p className="label">{snippet ? t("snippets.dialog.editKicker") : t("snippets.dialog.kicker")}</p>
          <h3 className="themed-heading text-sm font-semibold">
            {snippet ? t("snippets.dialog.editTitle") : t("snippets.dialog.title")}
          </h3>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Input
            ref={nameRef}
            className="themed-input w-full text-sm outline-none transition focus:border-cyan-400/60"
            placeholder={t("snippets.dialog.namePlaceholder")}
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter" && name.trim() && command.trim()) {
                onSave(name.trim(), command.trim());
                onClose();
              }
              if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <textarea
            className="themed-input w-full px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60 resize-none"
            rows={3}
            placeholder={t("snippets.dialog.commandPlaceholder")}
            value={command}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCommand(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Escape") {
                onClose();
              }
            }}
          />
        </div>

        <div className="mt-3 flex justify-end gap-1">
          <button className="btn-cancel" onClick={onClose} type="button">
            {t("snippets.dialog.cancel")}
          </button>
          <button
            className="btn-primary"
            disabled={!name.trim() || !command.trim()}
            onClick={() => {
              onSave(name.trim(), command.trim());
              onClose();
            }}
            type="button"
          >
            {t("snippets.dialog.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SnippetsPanel({ onSendCommand }: SnippetsPanelProps) {
  const snippets = useSnippetsStore((s) => s.snippets);
  const addSnippet = useSnippetsStore((s) => s.addSnippet);
  const updateSnippet = useSnippetsStore((s) => s.updateSnippet);
  const deleteSnippet = useSnippetsStore((s) => s.deleteSnippet);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<CommandSnippet | undefined>();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const handleSave = (name: string, command: string) => {
    if (editingSnippet) {
      updateSnippet(editingSnippet.id, { name, command });
    } else {
      addSnippet(name, command);
    }
  };

  const handleEdit = (snippet: CommandSnippet) => {
    setEditingSnippet(snippet);
    setDialogOpen(true);
  };

  const handleAdd = () => {
    setEditingSnippet(undefined);
    setDialogOpen(true);
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-2">
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={handleAdd} type="button">
            <PlusIcon className="h-4 w-4" />
            {t('snippets.newSnippet')}
          </button>
          <div className="h-4 w-px bg-[var(--app-border)]" />
          <button className="btn-ghost text-[var(--app-text-soft)]" type="button">
            <ClockIcon className="mr-1.5 h-4 w-4" />
            {t('snippets.shellHistory')}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button className="icon-btn h-7 w-7" type="button">
            <SearchIcon className="h-4 w-4" />
          </button>
          <button
            className={cn('icon-btn h-7 w-7', viewMode === 'grid' && 'bg-[var(--app-surface-active)]')}
            onClick={() => setViewMode('grid')}
            type="button"
          >
            <LayoutGridIcon className="h-4 w-4" />
          </button>
          <button
            className={cn('icon-btn h-7 w-7', viewMode === 'list' && 'bg-[var(--app-surface-active)]')}
            onClick={() => setViewMode('list')}
            type="button"
          >
            <LayoutListIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4">
        {snippets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center pb-12 text-center">
            <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]">
              <SnippetsIcon className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold text-[var(--app-text)]">{t('snippets.empty.title')}</h3>
            <p className="mt-1 max-w-sm text-sm text-[var(--app-text-soft)]">{t('snippets.empty.description')}</p>
          </div>
        ) : (
          <>
            <h2 className="mb-3 text-sm font-semibold text-[var(--app-text)]">{t('snippets.title')}</h2>
            <div
              className={cn(
                'gap-3',
                viewMode === 'grid'
                  ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                  : 'flex flex-col',
              )}
            >
              {snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="group relative rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3 transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-surface-hover)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium text-[var(--app-text)]">{snippet.name}</strong>
                      <span className="text-subtle block truncate text-xs">{snippet.command}</span>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        className="icon-btn h-6 w-6"
                        onClick={() => onSendCommand(snippet.command)}
                        title={t('snippets.send')}
                        type="button"
                      >
                        <Tooltip content={t('snippets.send')}>
                          <SendIcon className="h-3.5 w-3.5" />
                        </Tooltip>
                      </button>
                      <button
                        className="icon-btn h-6 w-6"
                        onClick={() => handleEdit(snippet)}
                        title={t('snippets.edit')}
                        type="button"
                      >
                        <Tooltip content={t('snippets.edit')}>
                          <EditIcon className="h-3.5 w-3.5" />
                        </Tooltip>
                      </button>
                      <button
                        className="icon-btn h-6 w-6 text-rose-400"
                        onClick={() => deleteSnippet(snippet.id)}
                        title={t('snippets.delete')}
                        type="button"
                      >
                        <Tooltip content={t('snippets.delete')}>
                          <TrashIcon className="h-3.5 w-3.5" />
                        </Tooltip>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </ScrollArea>

      <SnippetDialog
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        open={dialogOpen}
        snippet={editingSnippet}
      />
    </section>
  );
}
