import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import type { SessionState } from '../../types';

function StateBox({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      {icon ? <span className="text-2xl text-[var(--fm-text-muted)]">{icon}</span> : null}
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

export function NoSessionState() {
  return (
    <StateBox icon="📁">
      <span className="text-[13px] font-medium text-[var(--fm-text)]">{t('fileManager.empty.noSessionTitle')}</span>
      <span className="text-xs text-[var(--fm-text-soft)]">{t('fileManager.empty.noSession')}</span>
    </StateBox>
  );
}

export function LoadingState() {
  return (
    <StateBox>
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--fm-border)] border-t-[var(--fm-primary)]" />
      <span className="text-xs text-[var(--fm-text-soft)]">{t('fileManager.loading')}</span>
    </StateBox>
  );
}

export function EmptyDirectoryState({
  onNewFile,
  onNewFolder,
  onUpload,
}: {
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
}) {
  return (
    <StateBox icon="🗂️">
      <span className="text-[13px] font-medium text-[var(--fm-text)]">{t('fileManager.emptyDirectoryTitle')}</span>
      <span className="text-xs text-[var(--fm-text-soft)]">{t('fileManager.emptyDirectory')}</span>
      <div className="mt-1 flex items-center gap-1">
        {onNewFile ? (
          <button className="icon-btn h-7 px-2 text-[11px]" onClick={onNewFile} type="button">
            {t('fileManager.menu.newFile')}
          </button>
        ) : null}
        {onNewFolder ? (
          <button className="icon-btn h-7 px-2 text-[11px]" onClick={onNewFolder} type="button">
            {t('fileManager.menu.newDirectory')}
          </button>
        ) : null}
        {onUpload ? (
          <button className="icon-btn h-7 px-2 text-[11px]" onClick={onUpload} type="button">
            {t('fileManager.menu.uploadFile')}
          </button>
        ) : null}
      </div>
    </StateBox>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="m-2 flex flex-col gap-2 rounded-[4px] border border-rose-900/60 bg-rose-950/30 p-3">
      <span className="text-xs leading-5 text-rose-300">{error}</span>
      {onRetry ? (
        <div className="flex justify-end">
          <button className="btn-cancel h-6 px-2 text-[11px]" onClick={onRetry} type="button">
            {t('fileManager.actions.retry')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ReadOnlyState() {
  return (
    <div className="m-2 rounded-[4px] border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
      {t('fileManager.readOnly')}
    </div>
  );
}

export interface EmptyStatesProps {
  session?: SessionState;
  loading: boolean;
  listing?: { entries: unknown[] };
  error?: string;
  readOnly: boolean;
  onRetry?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
}

export function EmptyStates({
  session,
  loading,
  listing,
  error,
  readOnly,
  onRetry,
  onNewFile,
  onNewFolder,
  onUpload,
}: EmptyStatesProps) {
  if (!session) return <NoSessionState />;
  if (loading && !listing) return <LoadingState />;
  if (error && !listing) return <ErrorState error={error} onRetry={onRetry} />;
  if (listing && listing.entries.length === 0 && !loading) {
    return <EmptyDirectoryState onNewFile={onNewFile} onNewFolder={onNewFolder} onUpload={onUpload} />;
  }
  if (readOnly && listing) return <ReadOnlyState />;
  return null;
}
