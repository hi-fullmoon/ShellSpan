import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SftpFileList } from '../sftp-file-list';
import type { FileEntry } from '../utils';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';

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
  createRoot(document.getElementById('root')!).render(<List />);
}
