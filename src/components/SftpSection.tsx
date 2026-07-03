import { LocalFileManager } from './LocalFileManager';
import { RemoteFileManagerTabs } from './RemoteFileManagerTabs';
import type { SessionState } from '../types';

interface SftpSectionProps {
  sessions: SessionState[];
  bookmarksByProfileId?: Record<string, string[]>;
  onNewConnection: () => void;
  onAddBookmark?: (profileId: string, path: string) => void;
  onRemoveBookmark?: (profileId: string, path: string) => void;
}

export function SftpSection({ sessions, bookmarksByProfileId, onNewConnection, onAddBookmark, onRemoveBookmark }: SftpSectionProps) {
  return (
    <section className="flex h-full min-h-0 flex-1 bg-[var(--app-bg)]">
      <LocalFileManager className="flex-1 min-w-0" />
      <div className="w-px shrink-0 bg-[var(--app-border)]" />
      <RemoteFileManagerTabs
        bookmarksByProfileId={bookmarksByProfileId}
        className="flex-1 min-w-0"
        onNewConnection={onNewConnection}
        sessions={sessions}
        onAddBookmark={onAddBookmark}
        onRemoveBookmark={onRemoveBookmark}
      />
    </section>
  );
}
