import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';

export function TerminalPastePreview({ text, target }: { text: string; target: string }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3" data-terminal-paste-preview>
      <p className="break-all text-sm">{t('terminal.pasteWarning.target', { target })}</p>
      <p className="text-xs text-app-text-soft">
        {t(/[\r\n]$/.test(text) ? 'terminal.pasteWarning.trailingNewline' : 'terminal.pasteWarning.noTrailingNewline')}
      </p>
      <ScrollArea className="h-40 min-h-0" aria-label={t('terminal.pasteWarning.preview')}>
        <pre className="whitespace-pre-wrap break-all pr-3 font-mono text-xs">{text}</pre>
      </ScrollArea>
    </div>
  );
}
