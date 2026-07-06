import { create } from 'zustand';
import type { LogFileInfo } from '@/types';
import { invokeListLogFiles, invokeReadLogFile } from '@/lib/tauri';

interface LogState {
  files: LogFileInfo[];
  activeFileName?: string;
  content: string;
  loading: boolean;
  error?: string;
  loadFiles: () => Promise<void>;
  loadFile: (name: string) => Promise<void>;
  refreshActiveFile: () => Promise<void>;
  setActiveFile: (name?: string) => void;
}

export const useLogStore = create<LogState>()((set, get) => ({
  files: [],
  content: '',
  loading: false,
  loadFiles: async () => {
    set({ loading: true, error: undefined });
    try {
      const files = await invokeListLogFiles();
      set({ files, loading: false });
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
}));
