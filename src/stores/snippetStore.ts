import { create } from 'zustand';
import { invokeDeleteCommandSnippet, invokeListCommandSnippets, invokeSaveCommandSnippet } from '@/lib/ipc/tauri';
import type { CommandSnippet, SnippetInput } from '@/lib/terminal/snippet-template';

interface SnippetState {
  snippets: CommandSnippet[];
  loading: boolean;
  load: () => Promise<void>;
  save: (id: string | undefined, input: SnippetInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

let pendingLoad: Promise<void> | undefined;
let revision = 0;

export const useSnippetStore = create<SnippetState>((set) => ({
  snippets: [],
  loading: false,
  load: () => {
    if (pendingLoad) return pendingLoad;
    set({ loading: true });
    const requested = revision;
    pendingLoad = invokeListCommandSnippets().then((snippets) => {
      if (revision === requested) set({ snippets });
    }).finally(() => {
      pendingLoad = undefined;
      set({ loading: false });
    });
    return pendingLoad;
  },
  save: async (id, input) => {
    const saved = await invokeSaveCommandSnippet(id, input);
    revision++;
    set((state) => ({
      snippets: [...state.snippets.filter((snippet) => snippet.id !== saved.id), saved]
        .sort((a, b) => a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name)),
    }));
  },
  remove: async (id) => {
    await invokeDeleteCommandSnippet(id);
    revision++;
    set((state) => ({ snippets: state.snippets.filter((snippet) => snippet.id !== id) }));
  },
}));
