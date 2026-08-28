import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { SquareTerminalIcon } from 'lucide-react';
import { SplitPane } from '@/components/ui/split-pane';
import { useConnectSession } from '@/hooks/useConnectSession';
import { serializeTerminalWorkspace } from '@/lib/terminal-workspace';
import {
  clearTerminalWorkspace,
  flushTerminalWorkspace,
  stageTerminalWorkspace,
} from '@/lib/terminal-workspace-persistence';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { terminalRegistry } from './registry/terminal-registry';
import { TerminalControllerLayer } from './terminal-controller-layer';
import { TerminalTabBar } from './terminal-tab-bar';
import { TerminalTabSwitcher } from './terminal-tab-switcher';
import { TerminalPane } from './terminal-pane';
import { TerminalCarousel } from './terminal-carousel';
import { NewSessionDialog } from './new-session-dialog';
import { TerminalContextMenu } from './terminal-context-menu';
import {
  findAdjacentTerminalGroup,
  findTerminalGroup,
  ensureUniqueTerminalGroupIds,
  getTerminalGroups,
  getTerminalSplitDirection,
  partitionSessionIdsPinnedFirst,
  pruneEmptyTerminalGroups,
  repartitionTerminalLayoutPinnedFirst,
  replaceTerminalGroup,
  replaceTerminalSessionId,
  updateTerminalGroup,
  updateTerminalSplitAtPath,
  type TerminalGroupSlot,
  type TerminalGroupState,
  type TerminalLayoutPath,
  type TerminalLayoutNode,
  type TerminalSplitDirection,
  type TerminalSplitState,
} from './terminal-split';

const logger = createLogger('terminalWorkspace');

type DropPreview =
  | { kind: 'split'; direction: TerminalSplitDirection; slot: TerminalGroupSlot | null }
  | { kind: 'move'; slot: TerminalGroupSlot }
  | { kind: 'tab-bar'; slot: TerminalGroupSlot; insertIndex: number };

const TERMINAL_MIN_PANE_SIZE = 120;
const SINGLE_TERMINAL_CAROUSEL_KEY = 'single';

const Terminal: React.FC = () => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const restoreWorkspace = useAppStore((state) => state.restoreWorkspace);
  const activeSection = useAppStore((state) => state.activeSection);
  const { connect, openLocal } = useConnectSession();

  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    session: TerminalSession;
    x: number;
    y: number;
    slot: TerminalGroupSlot | null;
  } | null>(null);
  const [split, setSplit] = useState<TerminalSplitState | null>(() => {
    const restored = useTerminalStore.getState().restoredLayout;
    return restored?.kind === 'split'
      ? ensureUniqueTerminalGroupIds(restored) as TerminalSplitState
      : null;
  });
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const focusedGroupRef = useRef<TerminalGroupSlot>('first');
  // Mirror of focusedGroupRef for rendering: mutating a ref does not trigger a
  // re-render, so the focus ring and activeGroup props read this state instead.
  const [focusedSlot, setFocusedSlot] = useState<TerminalGroupSlot>('first');
  const nextGroupIdRef = useRef(
    split
      ? Math.max(3, ...getTerminalGroups(split).map((group) => {
          const match = /^group-(\d+)$/.exec(group.id);
          return match ? Number(match[1]) + 1 : 3;
        }))
      : 3,
  );
  const usedGroupIdsRef = useRef(new Set(
    split ? getTerminalGroups(split).map((group) => group.id) : [],
  ));
  const previousSessionsRef = useRef(sessions);
  const restoredLayoutAppliedRef = useRef(false);
  const pinnedSessionKey = useMemo(
    () => sessions.filter((session) => session.pinned).map((session) => session.sessionId).join('\0'),
    [sessions],
  );
  const splitEnabled = split !== null;
  const terminalVisible = activeSection === 'terminal';

  const focusGroup = useCallback((slot: TerminalGroupSlot): void => {
    focusedGroupRef.current = slot;
    setFocusedSlot(slot);
  }, []);

  const createGroupId = useCallback((): TerminalGroupSlot => {
    let id = `group-${nextGroupIdRef.current}`;
    while (usedGroupIdsRef.current.has(id)) {
      nextGroupIdRef.current += 1;
      id = `group-${nextGroupIdRef.current}`;
    }
    usedGroupIdsRef.current.add(id);
    nextGroupIdRef.current += 1;
    return id;
  }, []);

  const focusSession = useCallback((sessionId: string): void => {
    requestAnimationFrame(() => {
      terminalRegistry.get(sessionId)?.focus();
    });
  }, []);

  // Switching back to the terminal section refocuses the terminal in the
  // group the user focused last (or the active session when not split).
  const prevSectionRef = useRef(activeSection);
  useEffect(() => {
    const prevSection = prevSectionRef.current;
    prevSectionRef.current = activeSection;
    if (prevSection === 'terminal' || activeSection !== 'terminal') return;
    const focusedGroup = split ? findTerminalGroup(split, focusedGroupRef.current) : null;
    const sessionId = focusedGroup?.activeSessionId || activeSessionId;
    if (sessionId) focusSession(sessionId);
  }, [activeSection, activeSessionId, split, focusSession]);

  useEffect(() => {
    if (restoredLayoutAppliedRef.current) return;
    restoredLayoutAppliedRef.current = true;
    useTerminalStore.getState().clearRestoredLayout();
  }, []);

  useEffect(() => {
    if (!restoreWorkspace) {
      void clearTerminalWorkspace().catch((error) => {
        logger.error('failed to clear terminal workspace', error);
      });
    }
  }, [restoreWorkspace]);

  useEffect(() => {
    if (!restoreWorkspace) return;
    stageTerminalWorkspace(serializeTerminalWorkspace(sessions, split));
    const timer = window.setTimeout(() => {
      void flushTerminalWorkspace().catch((error) => {
        logger.error('failed to save terminal workspace', error);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [restoreWorkspace, sessions, split]);

  useEffect(() => {
    const handleNewTabRequest = (): void => setNewSessionDialogOpen((previous) => !previous);
    document.addEventListener('termbridge:new-terminal-tab', handleNewTabRequest);
    return () => document.removeEventListener('termbridge:new-terminal-tab', handleNewTabRequest);
  }, []);

  useEffect(() => {
    const handleTabSwitcherRequest = (): void => {
      if (useTerminalStore.getState().sessions.length > 0) setTabSwitcherOpen(true);
    };
    document.addEventListener('termbridge:switch-terminal-tab', handleTabSwitcherRequest);
    return () => document.removeEventListener('termbridge:switch-terminal-tab', handleTabSwitcherRequest);
  }, []);

  // Keep terminal groups in sync when sessions are opened or closed elsewhere.
  useEffect(() => {
    const previousSessions = previousSessionsRef.current;
    previousSessionsRef.current = sessions;
    if (!split) return;
    let nextLayout: TerminalLayoutNode = split;

    // Reconnects preserve conversation identity while replacing sessionId.
    // Apply those replacements before filtering unavailable ids so the tab
    // stays in the same terminal group, including during automatic reconnect.
    for (const session of sessions) {
      if (!session.conversationId) continue;
      const previous = previousSessions.find(
        (candidate) => candidate.conversationId === session.conversationId,
      );
      if (previous && previous.sessionId !== session.sessionId) {
        nextLayout = replaceTerminalSessionId(
          nextLayout,
          previous.sessionId,
          session.sessionId,
        );
      }
    }

    const availableIds = new Set(sessions.map((session) => session.sessionId));
    const syncNode = (node: TerminalLayoutNode): TerminalLayoutNode => {
      if (node.kind === 'split') {
        const first = syncNode(node.first);
        const second = syncNode(node.second);
        return first === node.first && second === node.second ? node : { ...node, first, second };
      }
      const ids = node.sessionIds.filter((id) => availableIds.has(id));
      const nextActiveSessionId =
        node.id === focusedGroupRef.current && activeSessionId && ids.includes(activeSessionId)
          ? activeSessionId
          : ids.includes(node.activeSessionId)
            ? node.activeSessionId
            : ids[ids.length - 1] ?? '';
      // Return the original node when nothing changed so the layout keeps
      // referential equality and the setSplit below can be skipped.
      const unchanged =
        nextActiveSessionId === node.activeSessionId
        && ids.length === node.sessionIds.length
        && ids.every((id, index) => id === node.sessionIds[index]);
      return unchanged
        ? node
        : { ...node, sessionIds: ids, activeSessionId: nextActiveSessionId };
    };
    nextLayout = syncNode(nextLayout);
    const assignedIds = new Set(getTerminalGroups(nextLayout).flatMap((group) => group.sessionIds));
    const missingIds = sessions
      .map((session) => session.sessionId)
      .filter((id) => !assignedIds.has(id));

    if (missingIds.length > 0) {
      const focusedGroup = findTerminalGroup(nextLayout, focusedGroupRef.current)
        ?? getTerminalGroups(nextLayout)[0];
      if (focusedGroup) {
        nextLayout = updateTerminalGroup(nextLayout, focusedGroup.id, (group) => ({
          ...group,
          sessionIds: [...group.sessionIds, ...missingIds],
          activeSessionId: missingIds[missingIds.length - 1],
        }));
      }
    }

    const pruned = pruneEmptyTerminalGroups(nextLayout);
    if (!pruned || pruned.kind === 'group') {
      setSplit(null);
      const nextActiveId = pruned?.activeSessionId || sessions[0]?.sessionId;
      if (nextActiveId) useTerminalStore.getState().setActiveSession(nextActiveId);
      return;
    }
    // Skip the state update (and the re-renders, pin repartition and workspace
    // save it would trigger) when the layout is referentially unchanged.
    if (pruned !== split) setSplit(pruned);
  }, [sessions]);

  // The layout's sessionIds are the source of truth for tab order while split,
  // so pin toggles (which only reorder the global sessions array) are mirrored
  // into every group to keep pinned tabs at the front.
  useEffect(() => {
    const pinnedIds = new Set(pinnedSessionKey ? pinnedSessionKey.split('\0') : []);
    setSplit((current) => (current
      ? repartitionTerminalLayoutPinnedFirst(current, (id) => pinnedIds.has(id)) as TerminalSplitState
      : current));
  }, [pinnedSessionKey, splitEnabled]);

  // Shortcut-based tab changes target the active group, just like VS Code editor groups.
  useEffect(() => {
    if (!split || !activeSessionId) return;
    const group = getTerminalGroups(split).find((candidate) => candidate.sessionIds.includes(activeSessionId));
    if (!group) return;
    focusGroup(group.id);
    if (group.activeSessionId === activeSessionId) return;
    setSplit((current) => (current
      ? updateTerminalGroup(current, group.id, (currentGroup) => ({ ...currentGroup, activeSessionId })) as TerminalSplitState
      : current));
  }, [activeSessionId, focusGroup, split]);

  const getGroupRegionAtPoint = useCallback((x: number, y: number): {
    slot: TerminalGroupSlot;
    region: 'tab-bar' | 'content';
    element: HTMLElement;
  } | null => {
    const groups = terminalAreaRef.current?.querySelectorAll<HTMLElement>('[data-terminal-group]') ?? [];
    for (const group of groups) {
      const slot = group.dataset.terminalGroup;
      if (!slot) continue;
      for (const region of ['tab-bar', 'content'] as const) {
        const element = group?.querySelector<HTMLElement>(`[data-terminal-${region}]`);
        const rect = element?.getBoundingClientRect();
        if (element && rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return { slot, region, element };
        }
      }
    }
    return null;
  }, []);

  const canCreateSplitAt = useCallback((
    direction: TerminalSplitDirection,
    targetGroupId?: TerminalGroupSlot,
  ): boolean => {
    const group = targetGroupId
      ? Array.from(
          terminalAreaRef.current?.querySelectorAll<HTMLElement>('[data-terminal-group]') ?? [],
        ).find((element) => element.dataset.terminalGroup === targetGroupId)
      : null;
    const content = group?.querySelector<HTMLElement>('[data-terminal-content]')
      ?? terminalAreaRef.current?.querySelector<HTMLElement>('[data-terminal-content]');
    const rect = content?.getBoundingClientRect();
    if (!rect) return true;
    const size = direction === 'left' || direction === 'right' ? rect.width : rect.height;
    // JSDOM and temporarily hidden sections report zero; defer enforcement
    // until a real measurable region is available.
    return size <= 0 || size >= TERMINAL_MIN_PANE_SIZE * 2;
  }, []);

  const getTabInsertIndex = useCallback((element: HTMLElement, x: number): number => {
    const tabs = Array.from(element.querySelectorAll<HTMLElement>('[data-session-tab]'));
    for (let index = 0; index < tabs.length; index += 1) {
      const rect = tabs[index].getBoundingClientRect();
      if (x < rect.left + rect.width / 2) return index;
    }
    return tabs.length;
  }, []);

  // Cross-group drops keep the pinned-first invariant of the target group, so
  // the insert index (and its indicator) is clamped the same way the drop will
  // behave: pinned tabs land inside the pinned region, unpinned tabs after it.
  const getCrossGroupInsertIndex = useCallback((
    sessionId: string,
    targetSlot: TerminalGroupSlot,
    element: HTMLElement,
    x: number,
  ): number => {
    const rawIndex = getTabInsertIndex(element, x);
    const targetGroup = split ? findTerminalGroup(split, targetSlot) : null;
    if (!targetGroup) return rawIndex;
    const pinnedCount = targetGroup.sessionIds.filter(
      (id) => sessions.find((session) => session.sessionId === id)?.pinned,
    ).length;
    const draggedPinned = sessions.find((session) => session.sessionId === sessionId)?.pinned;
    return draggedPinned ? Math.min(rawIndex, pinnedCount) : Math.max(rawIndex, pinnedCount);
  }, [getTabInsertIndex, sessions, split]);

  const createOrArrangeSplit = useCallback((
    sessionId: string,
    direction: TerminalSplitDirection,
    targetGroupId?: TerminalGroupSlot,
  ): boolean => {
    const incomingFirst = direction === 'left' || direction === 'top';
    const orientation = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';

    if (split) {
      const sourceGroup = getTerminalGroups(split).find((group) => group.sessionIds.includes(sessionId));
      const targetGroup = targetGroupId
        ? findTerminalGroup(split, targetGroupId)
        : sourceGroup;
      if (!sourceGroup || !targetGroup) return false;
      if (!canCreateSplitAt(direction, targetGroup.id)) return false;

      let nextLayout: TerminalLayoutNode = split;
      if (sourceGroup.id === targetGroup.id) {
        const remainingIds = sourceGroup.sessionIds.filter((id) => id !== sessionId);
        if (remainingIds.length === 0) return false;
        const newGroup: TerminalGroupState = {
          kind: 'group',
          id: createGroupId(),
          sessionIds: [sessionId],
          activeSessionId: sessionId,
        };
        const remainingGroup: TerminalGroupState = {
          ...sourceGroup,
          sessionIds: remainingIds,
          activeSessionId: remainingIds.includes(sourceGroup.activeSessionId)
            ? sourceGroup.activeSessionId
            : remainingIds[remainingIds.length - 1],
        };
        const nestedSplit: TerminalSplitState = {
          kind: 'split',
          first: incomingFirst ? newGroup : remainingGroup,
          second: incomingFirst ? remainingGroup : newGroup,
          orientation,
          split: 0.5,
        };
        nextLayout = replaceTerminalGroup(nextLayout, sourceGroup.id, nestedSplit);
        focusGroup(newGroup.id);
      } else {
        nextLayout = updateTerminalGroup(nextLayout, sourceGroup.id, (group) => ({
          ...group,
          sessionIds: group.sessionIds.filter((id) => id !== sessionId),
          activeSessionId: group.activeSessionId === sessionId
            ? group.sessionIds.filter((id) => id !== sessionId).slice(-1)[0] ?? ''
            : group.activeSessionId,
        }));
        const pruned = pruneEmptyTerminalGroups(nextLayout);
        if (!pruned) return false;
        nextLayout = pruned;
        const currentTarget = findTerminalGroup(nextLayout, targetGroup.id);
        if (!currentTarget) return false;
        const newGroup: TerminalGroupState = {
          kind: 'group',
          id: createGroupId(),
          sessionIds: [sessionId],
          activeSessionId: sessionId,
        };
        const nestedSplit: TerminalSplitState = {
          kind: 'split',
          first: incomingFirst ? newGroup : currentTarget,
          second: incomingFirst ? currentTarget : newGroup,
          orientation,
          split: 0.5,
        };
        nextLayout = replaceTerminalGroup(nextLayout, currentTarget.id, nestedSplit);
        focusGroup(newGroup.id);
      }
      if (nextLayout.kind !== 'split') return false;
      setSplit(nextLayout);
      useTerminalStore.getState().setActiveSession(sessionId);
      setDropPreview(null);
      return true;
    }

    if (sessions.length < 2) return false;
    if (!canCreateSplitAt(direction)) return false;
    const remainingIds = sessions
      .map((session) => session.sessionId)
      .filter((id) => id !== sessionId);
    if (remainingIds.length === 0) return false;
    const baseActiveId = activeSessionId && remainingIds.includes(activeSessionId)
      ? activeSessionId
      : remainingIds[remainingIds.length - 1];
    const targetGroup: TerminalGroupState = {
      kind: 'group', id: incomingFirst ? 'first' : 'second', sessionIds: [sessionId], activeSessionId: sessionId,
    };
    const baseGroup: TerminalGroupState = {
      kind: 'group', id: incomingFirst ? 'second' : 'first', sessionIds: remainingIds, activeSessionId: baseActiveId,
    };

    focusGroup(targetGroup.id);
    setSplit({
      kind: 'split',
      first: incomingFirst ? targetGroup : baseGroup,
      second: incomingFirst ? baseGroup : targetGroup,
      orientation,
      split: 0.5,
    });
    useTerminalStore.getState().setActiveSession(sessionId);
    setDropPreview(null);
    return true;
  }, [activeSessionId, canCreateSplitAt, createGroupId, focusGroup, sessions, split]);

  const activateGroupTab = useCallback((slot: TerminalGroupSlot, sessionId: string): void => {
    focusGroup(slot);
    setSplit((current) => current
      ? updateTerminalGroup(current, slot, (group) => ({ ...group, activeSessionId: sessionId })) as TerminalSplitState
      : current);
    useTerminalStore.getState().setActiveSession(sessionId);
    focusSession(sessionId);
  }, [focusGroup, focusSession]);

  const activateSwitcherTab = useCallback((sessionId: string): void => {
    const group = split
      ? getTerminalGroups(split).find((candidate) => candidate.sessionIds.includes(sessionId))
      : null;
    if (group) {
      activateGroupTab(group.id, sessionId);
      return;
    }
    useTerminalStore.getState().setActiveSession(sessionId);
    focusSession(sessionId);
  }, [activateGroupTab, focusSession, split]);

  const activateCarouselTab = useCallback((
    key: string,
    sessionId: string,
  ): void => {
    if (key === SINGLE_TERMINAL_CAROUSEL_KEY) {
      useTerminalStore.getState().setActiveSession(sessionId);
      return;
    }
    focusGroup(key);
    setSplit((current) => current
      ? updateTerminalGroup(current, key, (group) => ({ ...group, activeSessionId: sessionId })) as TerminalSplitState
      : current);
    useTerminalStore.getState().setActiveSession(sessionId);
  }, [focusGroup]);

  // Leader-key pane navigation, dispatched from the xterm key handler in
  // TerminalPane (which already consumed the key, so nothing reaches the pty).
  useEffect(() => {
    const handlePaneNavigate = (event: Event): void => {
      const { detail } = event as CustomEvent<{ direction: TerminalSplitDirection }>;
      if (!split) return;
      const rects = new Map<TerminalGroupSlot, DOMRect>();
      terminalAreaRef.current
        ?.querySelectorAll<HTMLElement>('[data-terminal-group]')
        .forEach((element) => {
          const id = element.dataset.terminalGroup;
          if (id) rects.set(id, element.getBoundingClientRect());
        });
      const target = findAdjacentTerminalGroup(
        split,
        focusedGroupRef.current,
        detail.direction,
        (id) => rects.get(id) ?? null,
      );
      if (!target) return;
      activateGroupTab(target.id, target.activeSessionId);
    };
    document.addEventListener('termbridge:navigate-terminal-pane', handlePaneNavigate);
    return () => document.removeEventListener('termbridge:navigate-terminal-pane', handlePaneNavigate);
  }, [split, activateGroupTab]);

  const reorderGroupTabs = useCallback((slot: TerminalGroupSlot, sessionId: string, insertIndex: number): void => {
    setSplit((current) => {
      if (!current) return current;
      const group = findTerminalGroup(current, slot);
      if (!group) return current;
      const pinnedIds = new Set(
        useTerminalStore.getState().sessions
          .filter((session) => session.pinned)
          .map((session) => session.sessionId),
      );
      const ids = group.sessionIds.filter((id) => id !== sessionId);
      ids.splice(Math.max(0, Math.min(insertIndex, ids.length)), 0, sessionId);
      const ordered = partitionSessionIdsPinnedFirst(ids, (id) => pinnedIds.has(id));
      return updateTerminalGroup(current, slot, (value) => ({ ...value, sessionIds: ordered })) as TerminalSplitState;
    });
  }, []);

  const moveTabToGroup = useCallback((sessionId: string, source: TerminalGroupSlot, target: TerminalGroupSlot, insertIndex: number): boolean => {
    if (source === target) return false;
    const current = split;
    const sourceGroup = current ? findTerminalGroup(current, source) : null;
    const targetGroup = current ? findTerminalGroup(current, target) : null;
    if (!current || !sourceGroup?.sessionIds.includes(sessionId) || !targetGroup) return false;
    const sourceIds = sourceGroup.sessionIds.filter((id) => id !== sessionId);
    const targetIds = targetGroup.sessionIds.filter((id) => id !== sessionId);
    targetIds.splice(Math.max(0, Math.min(insertIndex, targetIds.length)), 0, sessionId);
    const orderedTargetIds = partitionSessionIdsPinnedFirst(
      targetIds,
      (id) => Boolean(sessions.find((session) => session.sessionId === id)?.pinned),
    );
    let nextLayout = updateTerminalGroup(current, source, (group) => ({
      ...group,
      sessionIds: sourceIds,
      activeSessionId: sourceIds.includes(group.activeSessionId)
        ? group.activeSessionId
        : sourceIds[sourceIds.length - 1] ?? '',
    }));
    nextLayout = updateTerminalGroup(nextLayout, target, (group) => ({
      ...group,
      sessionIds: orderedTargetIds,
      activeSessionId: sessionId,
    }));
    const pruned = pruneEmptyTerminalGroups(nextLayout);
    if (!pruned || pruned.kind === 'group') {
      setSplit(null);
      useTerminalStore.setState((state) => ({
        sessions: orderedTargetIds
          .map((id) => state.sessions.find((session) => session.sessionId === id))
          .filter((session): session is TerminalSession => Boolean(session)),
      }));
    } else {
      setSplit(pruned);
    }
    focusGroup(target);
    useTerminalStore.getState().setActiveSession(sessionId);
    setDropPreview(null);
    return true;
  }, [focusGroup, sessions, split]);

  const handleTabDragMove = useCallback((sessionId: string, source: TerminalGroupSlot | null, x: number, y: number): void => {
    if (split && source) {
      const target = getGroupRegionAtPoint(x, y);
      if (!target) {
        setDropPreview(null);
        return;
      }
      if (target.region === 'tab-bar') {
        setDropPreview(target.slot !== source
          ? { kind: 'tab-bar', slot: target.slot, insertIndex: getCrossGroupInsertIndex(sessionId, target.slot, target.element, x) }
          : null);
        return;
      }
      const direction = getTerminalSplitDirection(target.element.getBoundingClientRect(), x, y);
      if (direction) {
        setDropPreview(canCreateSplitAt(direction, target.slot)
          ? { kind: 'split', direction, slot: target.slot }
          : null);
      } else {
        setDropPreview(target.slot !== source ? { kind: 'move', slot: target.slot } : null);
      }
      return;
    }
    const content = terminalAreaRef.current?.querySelector<HTMLElement>('[data-terminal-content]');
    const direction = content
      ? getTerminalSplitDirection(content.getBoundingClientRect(), x, y)
      : null;
    setDropPreview(direction && sessions.length > 1 && canCreateSplitAt(direction)
      ? { kind: 'split', direction, slot: null }
      : null);
  }, [canCreateSplitAt, getCrossGroupInsertIndex, getGroupRegionAtPoint, sessions.length, split]);

  const handleTabDragEnd = useCallback((sessionId: string, source: TerminalGroupSlot | null, x: number, y: number): boolean => {
    if (split && source) {
      const target = getGroupRegionAtPoint(x, y);
      setDropPreview(null);
      if (!target) return false;
      if (target.region === 'tab-bar') {
        return target.slot !== source
          ? moveTabToGroup(sessionId, source, target.slot, getCrossGroupInsertIndex(sessionId, target.slot, target.element, x))
          : false;
      }
      const direction = getTerminalSplitDirection(target.element.getBoundingClientRect(), x, y);
      if (direction) return createOrArrangeSplit(sessionId, direction, target.slot);
      if (target.slot === source) return true;
      const targetGroup = findTerminalGroup(split, target.slot);
      return targetGroup
        ? moveTabToGroup(sessionId, source, target.slot, targetGroup.sessionIds.length)
        : false;
    }
    const content = terminalAreaRef.current?.querySelector<HTMLElement>('[data-terminal-content]');
    const direction = content
      ? getTerminalSplitDirection(content.getBoundingClientRect(), x, y)
      : null;
    setDropPreview(null);
    return direction ? createOrArrangeSplit(sessionId, direction) : false;
  }, [createOrArrangeSplit, getCrossGroupInsertIndex, getGroupRegionAtPoint, moveTabToGroup, split]);

  // Leader-key split commands (v/s): split the focused group's active tab.
  useEffect(() => {
    const handlePaneSplit = (event: Event): void => {
      const { detail } = event as CustomEvent<{ direction: TerminalSplitDirection }>;
      const focusedGroup = split ? findTerminalGroup(split, focusedGroupRef.current) : null;
      const sessionId = focusedGroup?.activeSessionId || activeSessionId;
      if (!sessionId) return;
      createOrArrangeSplit(sessionId, detail.direction);
    };
    document.addEventListener('termbridge:split-terminal-pane', handlePaneSplit);
    return () => document.removeEventListener('termbridge:split-terminal-pane', handlePaneSplit);
  }, [activeSessionId, createOrArrangeSplit, split]);

  const renderTerminalPane = (session: TerminalSession | null, isActive: boolean): React.ReactNode => (
    <TerminalPane
      activeSession={session}
      isActive={isActive}
      isVisible={terminalVisible}
    />
  );

  const renderGroup = (slot: TerminalGroupSlot): React.ReactNode => {
    if (!split) return null;
    const group = findTerminalGroup(split, slot);
    if (!group) return null;
    const groupSessions = group.sessionIds
      .map((id) => sessions.find((session) => session.sessionId === id))
      .filter((session): session is TerminalSession => Boolean(session));
    const groupActiveSession = groupSessions.find(
      (session) => session.sessionId === group.activeSessionId,
    ) ?? groupSessions[0] ?? null;
    const focused = focusedSlot === slot;

    return (
      <div
        data-terminal-group={slot}
        className={cn(
          'relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg',
          focused && 'ring-1 ring-inset ring-app-primary/70',
        )}
        onPointerDownCapture={(e) => {
          // macOS tap-to-click: the tap that focuses an inactive group would
          // otherwise reach xterm as mousedown, so the continued touchpad
          // motion is treated as a drag and starts a selection. Swallow
          // pointerdowns landing on the terminal screen of an inactive group
          // and just focus the group; tab bar presses are left untouched.
          if (focused) return;
          if (!(e.target as HTMLElement).closest('[data-terminal-content]')) return;
          e.preventDefault();
          e.stopPropagation();
          focusGroup(slot);
          if (groupActiveSession) {
            useTerminalStore.getState().setActiveSession(groupActiveSession.sessionId);
            focusSession(groupActiveSession.sessionId);
          }
        }}
        onPointerDown={(e) => {
          // Tab presses activate on pointerdown too and already focus the
          // group via activateGroupTab. Handling them here as well would
          // re-activate the render-time groupActiveSession, clobbering a
          // same-press tab switch with the stale session.
          if ((e.target as HTMLElement).closest('[data-session-tab]')) return;
          focusGroup(slot);
          if (groupActiveSession) {
            useTerminalStore.getState().setActiveSession(groupActiveSession.sessionId);
            focusSession(groupActiveSession.sessionId);
          }
        }}
      >
        <TerminalTabBar
          sessions={groupSessions}
          activeSessionId={groupActiveSession?.sessionId ?? null}
          forceVisible
          activeGroup={focused}
          onNewTabClick={() => {
            focusGroup(slot);
            setNewSessionDialogOpen(true);
          }}
          onTabContextMenu={(session, x, y) => setContextMenu({ session, x, y, slot })}
          onTabActivate={(sessionId) => activateGroupTab(slot, sessionId)}
          onTabReorder={(sessionId, index) => reorderGroupTabs(slot, sessionId, index)}
          onTabDragMove={(sessionId, x, y) => handleTabDragMove(sessionId, slot, x, y)}
          onTabDragEnd={(sessionId, x, y) => handleTabDragEnd(sessionId, slot, x, y)}
          onTabDragCancel={() => setDropPreview(null)}
          externalInsertIndex={dropPreview?.kind === 'tab-bar' && dropPreview.slot === slot
            ? dropPreview.insertIndex
            : null}
        />
        <div data-terminal-content className="relative min-h-0 flex-1">
          {groupSessions.length > 1 ? (
            <TerminalCarousel
              sessions={groupSessions}
              activeSessionId={groupActiveSession?.sessionId ?? null}
              isActive={focused && groupActiveSession?.sessionId === activeSessionId}
              isVisible={terminalVisible}
              onActivate={(sessionId) => activateCarouselTab(slot, sessionId)}
              onSettle={focusSession}
            />
          ) : renderTerminalPane(
            groupActiveSession,
            focused && groupActiveSession?.sessionId === activeSessionId,
          )}
          {(dropPreview?.kind === 'split' || dropPreview?.kind === 'move')
            && dropPreview.slot === slot && (
            <div
              data-testid="terminal-split-drop-preview"
              data-direction={dropPreview.kind === 'split' ? dropPreview.direction : 'center'}
              className={cn(
                'pointer-events-none absolute z-30 bg-app-primary/15',
                dropPreview.kind === 'move' && 'inset-0 ring-1 ring-inset ring-app-primary/60',
                dropPreview.kind === 'split' && dropPreview.direction === 'left' && 'inset-y-0 left-0 w-1/2',
                dropPreview.kind === 'split' && dropPreview.direction === 'right' && 'inset-y-0 right-0 w-1/2',
                dropPreview.kind === 'split' && dropPreview.direction === 'top' && 'inset-x-0 top-0 h-1/2',
                dropPreview.kind === 'split' && dropPreview.direction === 'bottom' && 'inset-x-0 bottom-0 h-1/2',
              )}
            />
          )}
        </div>
        {!focused && (
          // Mask marking this split group as inactive. Clicks pass through to
          // the wrapper's onPointerDown, which refocuses the group.
          <div className="pointer-events-none absolute inset-0 z-10 bg-app-bg/30" />
        )}
      </div>
    );
  };

  const renderLayout = (
    node: TerminalLayoutNode,
    path: TerminalLayoutPath = [],
  ): React.ReactNode => {
    if (node.kind === 'group') return renderGroup(node.id);
    const splitId = `terminal-split-${path.length > 0 ? path.join('-') : 'root'}`;
    return (
      <SplitPane
        id={splitId}
        left={renderLayout(node.first, [...path, 'first'])}
        right={renderLayout(node.second, [...path, 'second'])}
        direction={node.orientation}
        minWidth={TERMINAL_MIN_PANE_SIZE}
        split={node.split ?? 0.5}
        onSplitChange={(nextSplit) => {
          setSplit((current) => current
            ? updateTerminalSplitAtPath(current, path, nextSplit) as TerminalSplitState
            : current);
        }}
        dividerStyle="subtle"
      />
    );
  };

  return (
    <div className="flex h-full flex-col bg-app-bg">
      <TerminalControllerLayer />
      {sessions.length > 0 && !split && (
        <TerminalTabBar
          onNewTabClick={() => setNewSessionDialogOpen(true)}
          onTabContextMenu={(session, x, y) => setContextMenu({ session, x, y, slot: null })}
          onTabActivate={(sessionId) => {
            useTerminalStore.getState().setActiveSession(sessionId);
            focusSession(sessionId);
          }}
          onTabDragMove={(sessionId, x, y) => handleTabDragMove(sessionId, null, x, y)}
          onTabDragEnd={(sessionId, x, y) => handleTabDragEnd(sessionId, null, x, y)}
          onTabDragCancel={() => setDropPreview(null)}
        />
      )}
      <div ref={terminalAreaRef} className="relative min-h-0 flex-1">
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<SquareTerminalIcon />}
              title={t('terminal.empty')}
              description={t('terminal.openFromWorkbench')}
              action={(
                <Button variant="default" size="sm" onClick={() => setNewSessionDialogOpen(true)}>
                  {t('terminal.empty.open')}
                </Button>
              )}
            />
          </div>
        ) : split ? (
          renderLayout(split)
        ) : (
          <div data-terminal-content className="relative h-full w-full">
            {sessions.length > 1 ? (
              <TerminalCarousel
                sessions={sessions}
                activeSessionId={activeSessionId}
                isActive
                isVisible={terminalVisible}
                onActivate={(sessionId) => activateCarouselTab(
                  SINGLE_TERMINAL_CAROUSEL_KEY,
                  sessionId,
                )}
                onSettle={focusSession}
              />
            ) : renderTerminalPane(activeSession, true)}
          </div>
        )}
        {dropPreview?.kind === 'split' && dropPreview.slot === null && (
          <div
            data-testid="terminal-split-drop-preview"
            data-direction={dropPreview.direction}
            className={cn(
              'pointer-events-none absolute z-30 bg-app-primary/15',
              dropPreview.direction === 'left' && 'inset-y-0 left-0 w-1/2',
              dropPreview.direction === 'right' && 'inset-y-0 right-0 w-1/2',
              dropPreview.direction === 'top' && 'inset-x-0 top-0 h-1/2',
              dropPreview.direction === 'bottom' && 'inset-x-0 bottom-0 h-1/2',
            )}
          />
        )}
        <NewSessionDialog
          open={newSessionDialogOpen}
          onClose={() => setNewSessionDialogOpen(false)}
          onConnect={connect}
          onOpenLocal={openLocal}
        />
        <TerminalTabSwitcher
          sessions={sessions}
          activeSessionId={activeSessionId}
          open={tabSwitcherOpen}
          onOpenChange={setTabSwitcherOpen}
          onSelect={activateSwitcherTab}
        />
      </div>
      <TerminalContextMenu
        open={Boolean(contextMenu)}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        session={contextMenu?.session ?? null}
        orderedSessionIds={contextMenu?.slot && split
          ? findTerminalGroup(split, contextMenu.slot)?.sessionIds
          : undefined}
        onClose={() => setContextMenu(null)}
        canSplit={contextMenu?.slot && split
          ? (findTerminalGroup(split, contextMenu.slot)?.sessionIds.length ?? 0) > 1
          : sessions.length > 1}
        isSplit={Boolean(split)}
        onSplit={createOrArrangeSplit}
        onUnsplit={() => setSplit(null)}
      />
    </div>
  );
};

export default Terminal;
