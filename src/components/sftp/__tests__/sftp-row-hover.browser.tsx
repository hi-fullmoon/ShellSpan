import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SftpFileList } from '../sftp-file-list';
import { SftpPane } from '../sftp-pane';
import type { FileEntry } from '../utils';
import { useSftpPaneActions } from '@/hooks/useSftpPaneActions';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useSftpStore } from '@/stores/sftpStore';
import type { Locale } from '@/types';
import '@/styles/base.css';

const root = createRoot(document.getElementById('root')!);

export async function mountList(entries: FileEntry[], locale: Locale, currentPath: string) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  function List() {
    const [selectedPaths, onSelect] = useState(new Set([entries[1].path]));
    return (
      <SftpFileList
        entries={entries}
        side="local"
        selectedPaths={selectedPaths}
        onSelect={onSelect}
        filterQuery=""
        batchMode
        currentPath={currentPath}
        onDoubleClick={() => {}}
        onContextMenu={() => {}}
        onParentDirectory={() => {}}
      />
    );
  }
  root.render(<List />);
}

export function mountLocalPane(path: string) {
  const store = useSftpStore.getState();
  store.addLocalConnection();
  const id = useSftpStore.getState().activeConnectionId!;
  store.setPath(id, 'local', path);
  function LocalPane() {
    const connection = useSftpStore(state => state.connections.find(item => item.id === id)!);
    const actions = useSftpPaneActions(connection, 'local');
    const [selectedPaths, onSelectedPathsChange] = useState(new Set<string>());
    return <SftpPane connection={connection} side="local" actions={actions}
      selectedPaths={selectedPaths} onSelectedPathsChange={onSelectedPathsChange} />;
  }
  root.render(<LocalPane />);
}
