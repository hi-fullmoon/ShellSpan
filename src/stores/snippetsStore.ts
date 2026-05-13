import { create } from "zustand";
import type { CommandSnippet } from "../types";

interface SnippetsStoreState {
  snippets: CommandSnippet[];
  addSnippet: (name: string, command: string) => void;
  updateSnippet: (id: string, patch: Partial<Pick<CommandSnippet, "name" | "command">>) => void;
  deleteSnippet: (id: string) => void;
}

const STORAGE_KEY = "termbridge.snippets";

function readStoredSnippets(): CommandSnippet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as CommandSnippet[];
  } catch {
    // ignore
  }
  return [];
}

function writeStoredSnippets(snippets: CommandSnippet[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets));
  } catch {
    // ignore
  }
}

export const useSnippetsStore = create<SnippetsStoreState>((set) => ({
  snippets: readStoredSnippets(),
  addSnippet: (name, command) =>
    set((state) => {
      const next: CommandSnippet = {
        id: crypto.randomUUID(),
        name: name.trim(),
        command: command.trim(),
      };
      const snippets = [...state.snippets, next];
      writeStoredSnippets(snippets);
      return { snippets };
    }),
  updateSnippet: (id, patch) =>
    set((state) => {
      const snippets = state.snippets.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      );
      writeStoredSnippets(snippets);
      return { snippets };
    }),
  deleteSnippet: (id) =>
    set((state) => {
      const snippets = state.snippets.filter((s) => s.id !== id);
      writeStoredSnippets(snippets);
      return { snippets };
    }),
}));
