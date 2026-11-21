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

// Closed-form cubic-bezier(0.4, 0, 0.2, 1) matching --ai-ease-in-out (y1=0, y2=1 => By(u) = u^2 * (3 - 2u)).
function easeInOutParamForY(y: number): number {
  const clampedY = Math.max(0, Math.min(1, y));
  const sinArg = Math.max(-1, Math.min(1, 1 - 2 * clampedY));
  return 0.5 - Math.sin(Math.asin(sinArg) / 3);
}

function easeInOutX(u: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * u * 0.4 + 3 * inv * u * u * 0.2 + u * u * u;
}

function easeInOutY(u: number): number {
  return u * u * (3 - 2 * u);
}

function formatPercent(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const formatted = (clamped * 100).toFixed(3).replace(/\.?0+$/, '');
  return `${formatted === '-0' ? '0' : formatted}%`;
}

function panelLinearTiming(
  start: number,
  end: number,
  uStart: number,
  uEnd: number,
  tStartPct: string,
  tEndPct: string,
): string {
  const steps = tStartPct === tEndPct ? 1 : Math.max(2, Math.ceil((uEnd - uStart) * 16));
  const span = end - start;
  const stops: string[] = [];
  if (tStartPct !== '0%') stops.push('0 0%');
  stops.push(`0 ${tStartPct}`);
  let previousPct = tStartPct;
  for (let i = 1; i < steps; i += 1) {
    const u = uStart + (uEnd - uStart) * (i / steps);
    const p = span > 0 ? Math.max(0, Math.min(1, (easeInOutY(u) - start) / span)) : 0;
    const tPct = formatPercent(easeInOutX(u));
    if (tPct === tStartPct || tPct === tEndPct || tPct === previousPct) continue;
    stops.push(`${Number(p.toFixed(4))} ${tPct}`);
    previousPct = tPct;
  }
  stops.push(`1 ${tEndPct}`);
  if (tEndPct !== '100%') stops.push('1 100%');
  return `linear(${stops.join(', ')})`;
}

export function setProcessPanelHeightTiming(panelIds: string, opening: boolean): void {
  const panels = panelIds.split(' ').flatMap(id => {
    const panel = document.getElementById(id);
    const height = panel?.firstElementChild?.getBoundingClientRect().height ?? 0;
    return panel && height > 0 ? [{ panel, height }] : [];
  });
  if (panels.length === 0) return;
  if (panels.length === 1) {
    panels[0].panel.style.removeProperty('--ai-process-height-timing');
    return;
  }
  const totalHeight = panels.reduce((total, { height }) => total + height, 0);
  const ordered = opening ? panels : [...panels].reverse();
  let offset = 0;
  let uStart = 0;
  let tStartPct = '0%';
  // The scroll items stay mounted in their original seats. Each row moves only
  // for the part of the group's eased height transition that crosses that row.
  for (const [index, { panel, height }] of ordered.entries()) {
    const start = offset / totalHeight;
    offset += height;
    const isLast = index === ordered.length - 1;
    const end = isLast ? 1 : offset / totalHeight;
    const uEnd = isLast ? 1 : easeInOutParamForY(end);
    const tEndPct = isLast ? '100%' : formatPercent(easeInOutX(uEnd));
    panel.style.setProperty(
      '--ai-process-height-timing',
      panelLinearTiming(start, end, uStart, uEnd, tStartPct, tEndPct),
    );
    uStart = uEnd;
    tStartPct = tEndPct;
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
