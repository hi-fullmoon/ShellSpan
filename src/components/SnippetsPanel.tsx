import { createPortal } from "react-dom";
import { useState, useRef, useEffect } from "react";
import { useSnippetsStore } from "../stores/snippetsStore";
import { Input } from "@chakra-ui/react";
import { t } from "../lib/i18n";
import type { CommandSnippet } from "../types";
import { ScrollArea, Tooltip } from './ui';

interface SnippetsPanelProps {
  onSendCommand: (command: string) => void;
}

function SendIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
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
    <section className="surface flex min-h-0 flex-col overflow-hidden">
      <div className="surface-header">
        <div>
          <p className="label">{t("snippets.subtitle")}</p>
          <h2 className="text-sm font-semibold">{t("snippets.title")}</h2>
        </div>
        <button
          className="icon-btn h-6 w-6 px-0"
          onClick={handleAdd}
          title={t("snippets.add")}
          type="button"
        >
          <Tooltip content={t("snippets.add")}>
            <PlusIcon />
          </Tooltip>
        </button>
      </div>

      <ScrollArea className="flex-1 p-1">
        {snippets.length === 0 ? (
          <div className="text-subtle px-1 py-2 text-xs leading-relaxed">{t("snippets.empty")}</div>
        ) : (
          <div className="flex flex-col gap-1">
            {snippets.map((snippet) => (
              <div
                key={snippet.id}
                className="group surface-muted rounded-sm flex select-none items-center gap-1 px-1.5 py-1 text-left transition"
              >
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-xs">{snippet.name}</strong>
                  <span className="text-subtle block truncate text-[11px]">{snippet.command}</span>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    className="icon-btn h-5 w-5 px-0 text-xs"
                    onClick={() => onSendCommand(snippet.command)}
                    title={t("snippets.send")}
                    type="button"
                  >
                    <Tooltip content={t("snippets.send")}>
                      <SendIcon />
                    </Tooltip>
                  </button>
                  <button
                    className="icon-btn h-5 w-5 px-0 text-xs"
                    onClick={() => handleEdit(snippet)}
                    title={t("snippets.edit")}
                    type="button"
                  >
                    <Tooltip content={t("snippets.edit")}>
                      <EditIcon />
                    </Tooltip>
                  </button>
                  <button
                    className="icon-btn h-5 w-5 px-0 text-xs text-rose-400"
                    onClick={() => deleteSnippet(snippet.id)}
                    title={t("snippets.delete")}
                    type="button"
                  >
                    <Tooltip content={t("snippets.delete")}>
                      <TrashIcon />
                    </Tooltip>
                  </button>
                </div>
              </div>
            ))}
          </div>
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
