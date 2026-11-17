import { useCallback, useSyncExternalStore } from 'react';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';

interface ProcessDisclosure {
  readonly open: boolean;
  readonly manualOpen?: boolean;
}

const disclosures = new Map<string, ProcessDisclosure>();
const listeners = new Map<string, Set<() => void>>();
const members = new Map<string, Set<HTMLElement>>();
const DISCLOSURE_LIMIT = 512;

export function processDisclosureKey(node: AiConversationNodeOf<'turnProcess'>): string {
  return JSON.stringify([node.sessionId, node.key]);
}

export function processFoldsOnCompletion(node: AiConversationNodeOf<'turnProcess'>): boolean {
  return node.status === 'completed' && node.hasEndBoundary
    && node.hasInterleavedInput !== true && node.hasFinalAnswer !== false;
}

export function storeProcessDisclosure(key: string, value: ProcessDisclosure): void {
  const previous = disclosures.get(key);
  if (previous?.open === value.open && previous.manualOpen === value.manualOpen) return;
  disclosures.delete(key);
  disclosures.set(key, value);
  for (const listener of listeners.get(key) ?? []) listener();
  if (disclosures.size > DISCLOSURE_LIMIT) {
    const oldest = [...disclosures.keys()].find(candidate => !listeners.has(candidate));
    if (oldest !== undefined) disclosures.delete(oldest);
  }
}

export function useProcessDisclosure(node?: AiConversationNodeOf<'turnProcess'>) {
  const key = node && processDisclosureKey(node);
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    const group = listeners.get(key) ?? new Set<() => void>();
    group.add(listener);
    listeners.set(key, group);
    return () => {
      group.delete(listener);
      if (group.size === 0) listeners.delete(key);
    };
  }, [key]);
  const snapshot = useCallback(() => key ? disclosures.get(key) : undefined, [key]);
  const stored = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { open: stored?.open ?? (node ? !processFoldsOnCompletion(node) : true), stored };
}

export function registerProcessMember(node: AiConversationNodeOf<'turnProcess'>, element: HTMLElement): () => void {
  const key = processDisclosureKey(node);
  const group = members.get(key) ?? new Set<HTMLElement>();
  group.add(element);
  members.set(key, group);
  return () => {
    group.delete(element);
    if (group.size === 0) members.delete(key);
  };
}

export function setProcessPanelHeightTiming(panelIds: string, opening: boolean): void {
  const panels = panelIds.split(' ').flatMap(id => {
    const panel = document.getElementById(id);
    const height = panel?.firstElementChild?.getBoundingClientRect().height ?? 0;
    return panel && height > 0 ? [{ panel, height }] : [];
  });
  const totalHeight = panels.reduce((total, { height }) => total + height, 0);
  let offset = 0;
  // The scroll items stay mounted in their original seats. Each row moves only
  // for the part of the group's height transition that crosses that row.
  for (const { panel, height } of opening ? panels : panels.reverse()) {
    panel.style.setProperty('--ai-process-height-start', `${100 * offset / totalHeight}%`);
    offset += height;
    panel.style.setProperty('--ai-process-height-end', `${100 * offset / totalHeight}%`);
  }
}

export function isReadingProcess(node: AiConversationNodeOf<'turnProcess'>, body: HTMLElement | null): boolean {
  const selection = window.getSelection();
  const elements = [...(members.get(processDisclosureKey(node)) ?? []), ...(body ? [body] : [])];
  return elements.some(element => element.contains(document.activeElement)
    || (selection && !selection.isCollapsed
      && Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
        .some(range => range.intersectsNode(element))));
}
