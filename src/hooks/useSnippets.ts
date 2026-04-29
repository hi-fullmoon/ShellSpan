import { useCallback, useState } from 'react';
import { useLocalStorage } from './useLocalStorage';
import type { Snippet } from '../types';

function generateId(): string {
  return `snippet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useSnippets() {
  const [snippets, setSnippets] = useLocalStorage<Snippet[]>('termbridge.snippets', []);
  const [editingId, setEditingId] = useState<string | null>(null);

  const addSnippet = useCallback((name: string, command: string) => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName || !trimmedCommand) return;
    setSnippets((prev) => [...prev, { id: generateId(), name: trimmedName, command: trimmedCommand }]);
  }, [setSnippets]);

  const updateSnippet = useCallback((id: string, name: string, command: string) => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName || !trimmedCommand) return;
    setSnippets((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name: trimmedName, command: trimmedCommand } : s)),
    );
    setEditingId(null);
  }, [setSnippets]);

  const deleteSnippet = useCallback((id: string) => {
    setSnippets((prev) => prev.filter((s) => s.id !== id));
    setEditingId((current) => (current === id ? null : current));
  }, [setSnippets]);

  const moveSnippet = useCallback((id: string, direction: 'up' | 'down') => {
    setSnippets((prev) => {
      const index = prev.findIndex((s) => s.id === id);
      if (index === -1) return prev;
      const next = [...prev];
      if (direction === 'up' && index > 0) {
        [next[index], next[index - 1]] = [next[index - 1], next[index]];
      } else if (direction === 'down' && index < next.length - 1) {
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
      }
      return next;
    });
  }, [setSnippets]);

  const refreshSnippets = useCallback(() => {
    try {
      const raw = window.localStorage.getItem('termbridge.snippets');
      if (raw) {
        setSnippets(JSON.parse(raw));
      }
    } catch {
      // ignore parse errors
    }
  }, [setSnippets]);

  return {
    snippets,
    editingId,
    setEditingId,
    addSnippet,
    updateSnippet,
    deleteSnippet,
    moveSnippet,
    refreshSnippets,
  };
}
