import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';

export function TerminalPastePreview({
  text,
  target,
  broadcastTargets,
}: {
  text: string;
  target: string;
  broadcastTargets?: readonly string[];
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3" data-terminal-paste-preview>
      {broadcastTargets && broadcastTargets.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-medium text-foreground">{t('terminal.broadcast.pasteTargetList')}</p>
          <ul className="m-0 flex max-h-24 list-none flex-col gap-0.5 overflow-y-auto p-0 text-xs text-app-text-soft">
            {broadcastTargets.map((item, index) => (
              <li key={`${index}:${item}`} className="break-all">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="break-all text-sm">{t('terminal.pasteWarning.target', { target })}</p>
      )}
      <p className="text-xs text-app-text-soft">
        {t(/[\r\n]$/.test(text) ? 'terminal.pasteWarning.trailingNewline' : 'terminal.pasteWarning.noTrailingNewline')}
      </p>
      <ScrollArea className="h-40 min-h-0" aria-label={t('terminal.pasteWarning.preview')}>
        <pre className="whitespace-pre-wrap break-all pr-3 font-mono text-xs">{text}</pre>
      </ScrollArea>
    </div>
  );
}
