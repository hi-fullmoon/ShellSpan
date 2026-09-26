import { create } from 'zustand';
import type { LogCursor, LogFileInfo, LogSource } from '@/types';
import { invokeListLogFiles, invokeReadLogChunk } from '@/lib/ipc/tauri';

function getLatestFileForSource(
  files: LogFileInfo[],
  source: LogSource,
): LogFileInfo | undefined {
  return files.find((file) => file.name === `${source}.log`)
    ?? files.find((file) => file.name.startsWith(source));
}

interface LogState {
  files: LogFileInfo[];
  activeFileName?: string;
  activeSource: LogSource;
  content: string;
  loading: boolean;
  error?: string;
  cursor?: LogCursor;
  generation: number;
  reading: boolean;
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
  generation: 0,
  reading: false,
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
    get().setActiveFile(name);
    set({ loading: true, error: undefined });
    await get().refreshActiveFile();
  },
  refreshActiveFile: async () => {
    const { activeFileName: name, cursor, generation, reading } = get();
    if (!name || reading) return;
    set({ reading: true });
    try {
      const chunk = await invokeReadLogChunk(name, cursor);
      if (get().generation !== generation) return;
      set((state) => ({
        content: chunk.reset ? chunk.content : state.content + chunk.content,
        cursor: chunk.cursor,
        loading: false,
        error: undefined,
        files: state.files.map((file) => file.name === name && file.size !== chunk.size
          ? { ...file, size: chunk.size } : file),
      }));
    } catch (error) {
      if (get().generation !== generation) return;
      set({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    } finally {
      if (get().generation === generation) set({ reading: false });
    }
  },
  setActiveFile: (name) => set((state) => ({
    activeFileName: name,
    content: '',
    cursor: undefined,
    generation: state.generation + 1,
    reading: false,
    loading: false,
  })),
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
      get().setActiveFile();
    }
  },
}));
