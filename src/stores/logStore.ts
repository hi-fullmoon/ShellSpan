import { create } from 'zustand';
import type { LogFileInfo, LogSource } from '@/types';
import { invokeListLogFiles, invokeReadLogFile } from '@/lib/tauri';

function getLatestFileForSource(
  files: LogFileInfo[],
  source: LogSource,
): LogFileInfo | undefined {
  return files.find((file) => file.name.startsWith(source));
}

interface LogState {
  files: LogFileInfo[];
  activeFileName?: string;
  activeSource: LogSource;
  content: string;
  loading: boolean;
  error?: string;
  loadFiles: () => Promise<void>;
  loadFile: (name: string) => Promise<void>;
  refreshActiveFile: () => Promise<void>;
  setActiveFile: (name?: string) => void;
  setActiveSource: (source: LogSource) => void;
}

export const useLogStore = create<LogState>()((set, get) => ({
  files: [],
  activeSource: 'frontend',
  content: '',
  loading: false,
  loadFiles: async () => {
    set({ loading: true, error: undefined });
    try {
      const files = await invokeListLogFiles();
      const sortedFiles = files.sort((a, b) => b.modifiedAt - a.modifiedAt);
      const { activeSource, activeFileName } = get();
      const currentFile = sortedFiles.find(
        (file) => file.name === activeFileName,
      );
      const sourceFile = getLatestFileForSource(sortedFiles, activeSource);
      set({ files: sortedFiles, loading: false });
      if (!currentFile && sourceFile) {
        await get().loadFile(sourceFile.name);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  },
  loadFile: async (name) => {
    set({ loading: true, error: undefined, activeFileName: name });
    try {
      const content = await invokeReadLogFile(name);
      set({ content, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  },
  refreshActiveFile: async () => {
    const name = get().activeFileName;
    if (!name) return;
    try {
      const content = await invokeReadLogFile(name);
      set({ content });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  setActiveFile: (name) => set({ activeFileName: name, content: '' }),
  setActiveSource: (source) => {
    const { files } = get();
    const sourceFile = getLatestFileForSource(files, source);
    set({
      activeSource: source,
      activeFileName: sourceFile?.name,
      error: undefined,
    });
    if (sourceFile) {
      void get().loadFile(sourceFile.name);
    } else {
      // No file to load for this source; drop stale content right away.
      set({ content: '' });
    }
  },
}));
