import { create } from "zustand";
import type { LogEntry } from "../types";

const MAX_LOG_ENTRIES = 800;

interface LogStoreState {
  entries: LogEntry[];
  append: (entry: LogEntry) => void;
  clear: () => void;
}

export const useLogStore = create<LogStoreState>((set) => ({
  entries: [],
  append: (entry) =>
    set((state) => {
      const nextEntries = [...state.entries, entry];
      if (nextEntries.length <= MAX_LOG_ENTRIES) {
        return { entries: nextEntries };
      }

      return {
        entries: nextEntries.slice(nextEntries.length - MAX_LOG_ENTRIES),
      };
    }),
  clear: () => set({ entries: [] }),
}));
