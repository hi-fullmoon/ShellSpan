import { t } from '../../lib/i18n';
import { ScrollArea } from '../ScrollArea';
import { CloseIcon } from '../Icons';
import { formatSize } from './lib/formatters';
import type { RemoteFileContent } from '../../types';

interface PreviewPanelProps {
  preview: RemoteFileContent;
  onClose: () => void;
  onCopyContent: () => void;
}

export function PreviewPanel({ preview, onClose, onCopyContent }: PreviewPanelProps) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center p-2 backdrop-blur-[14px]" style={{ background: 'var(--app-overlay)' }}>
      <div className="surface flex h-[70vh] w-[80vw] max-w-3xl flex-col gap-2 rounded-[4px] p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.preview.title')}</p>
            <h4 className="themed-heading mt-1 text-[15px] font-semibold tracking-[0.01em]">{preview.name}</h4>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-subtle text-xs">
              {t('fileManager.preview.size')}: {formatSize(preview.size)}
            </span>
            {preview.isText ? (
              <button className="icon-btn h-7 px-2 text-xs" onClick={onCopyContent} type="button">
                {t('fileManager.preview.copy')}
              </button>
            ) : null}
            <button aria-label={t('fileManager.preview.close')} className="icon-btn" onClick={onClose} type="button">
              <CloseIcon />
            </button>
          </div>
        </div>
        <ScrollArea className="mt-2 min-h-0 flex-1">
          {preview.isText ? (
            <pre className="whitespace-pre-wrap break-all rounded-[4px] bg-[var(--app-surface-muted)] p-2 font-mono text-[12px] leading-relaxed">
              {preview.content}
            </pre>
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-xs text-[var(--fm-text-muted)]">
              {t('fileManager.preview.binary')}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
