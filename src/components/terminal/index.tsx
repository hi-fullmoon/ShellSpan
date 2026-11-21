import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import { useToast } from '@/hooks/useToast';
import { useTerminalFileDrop } from '@/hooks/useTerminalFileDrop';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { SquareTerminalIcon } from 'lucide-react';
import { SplitPane } from '@/components/ui/split-pane';
import { useConnectSession } from '@/hooks/useConnectSession';
import { serializeTerminalWorkspace } from '@/lib/terminal/terminal-workspace';
import {
  clearTerminalWorkspace,
  flushTerminalWorkspace,
  stageTerminalWorkspace,
} from '@/lib/terminal/terminal-workspace-persistence';
import { createLogger } from '@/lib/logger';
import { invokeGetLocalTerminalOptions, isTauriRuntime } from '@/lib/ipc/tauri';
import type { LocalTerminalOptions } from '@/types';
import { cn } from '@/lib/utils';
import { getShortcutKeys } from '@/lib/shortcuts';
import { getTerminalMenuDirectory, isAbsoluteTerminalPath, openTerminalSftpPath } from '@/lib/terminal/terminal-current-directory';
import { quoteTerminalDropPaths } from '@/lib/terminal/terminal-file-drop';
import { sshRouteKey } from '@/lib/connections/ssh-route';
import { terminalRegistry } from './registry/terminal-registry';
import { TerminalControllerLayer } from './terminal-controller-layer';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import { TerminalTabBar } from './terminal-tab-bar';
import { TerminalTabSwitcher } from './terminal-tab-switcher';
import { TerminalPane } from './terminal-pane';
import { NewSessionDialog } from './new-session-dialog';
import { TerminalContextMenu } from './terminal-context-menu';
import { TerminalBroadcastControls } from './terminal-broadcast-controls';
import { TerminalCommandActivity } from './terminal-command-activity';
import {
  canSplitTerminalPane,
  equalizeTerminalPanes,
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
  swapTerminalPane,
  TERMINAL_MIN_PANE_SIZE,
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

function resolveCurrentSessionId(
  sessions: readonly TerminalSession[],
  sessionId: string,
): string | null {
  if (sessions.some((session) => session.sessionId === sessionId)) return sessionId;
  const replacement = sessions.find(
    (session) => session.replacesSessionId === sessionId || session.replacedSessionIds?.includes(sessionId),
  );
  return replacement?.sessionId ?? null;
}

const Terminal: React.FC = () => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const platform = usePlatform();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const workspace = useTerminalStore((state) => state.workspace);
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const restoreWorkspace = useAppStore((state) => state.restoreWorkspace);
  const activeSection = useAppStore((state) => state.activeSection);
  const { connect, openLocal } = useConnectSession();

  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [localTerminalOptions, setLocalTerminalOptions] = useState<LocalTerminalOptions>();
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    session: TerminalSession;
    x: number;
    y: number;
    slot: TerminalGroupSlot | null;
  } | null>(null);
  const split = useTerminalStore(state => state.workspaceSplit);
  const setSplit = useTerminalStore(state => state.setWorkspaceSplit);
  const zoomedSlot = useTerminalStore(state => state.zoomedGroupSlot);
  const zoomLeader = useAppStore(state => state.shortcuts.terminalLeader ?? DEFAULT_SHORTCUTS.terminalLeader);
  const zoomKey = useAppStore(state => state.shortcuts.terminalZoomPane ?? DEFAULT_SHORTCUTS.terminalZoomPane);
  const companionRequests = useRef(new Set<string>());
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [remoteFileDrop, setRemoteFileDrop] = useState<{ sessionId: string; paths: string[] } | null>(null);
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const focusedSlot = useTerminalStore(state => state.workspaceFocusedSlot);
  const focusedGroupRef = useRef<TerminalGroupSlot>(focusedSlot);
  focusedGroupRef.current = focusedSlot;
  // Group focus belongs to the workspace; the ref is used by event callbacks.
  const setFocusedSlot = useTerminalStore(state => state.setWorkspaceFocusedSlot);
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
  const restoredLayoutAppliedRef = useRef(false);
  const pinnedSessionKey = useMemo(
    () => sessions.filter((session) => session.pinned).map((session) => session.sessionId).join('\0'),
    [sessions],
  );
  const splitEnabled = split !== null;
  const terminalVisible = activeSection === 'terminal';
  const configureBroadcast = sessions.filter((session) => session.status === 'connected' && !session.pendingConnection).length >= 2
    ? () => document.dispatchEvent(new Event('shellspan:configure-terminal-broadcast')) : undefined;

  const focusGroup = useCallback((slot: TerminalGroupSlot): void => {
    focusedGroupRef.current = slot;
    setFocusedSlot(slot);
  }, []);

  const createGroupId = useCallback((): TerminalGroupSlot => {
    const current = useTerminalStore.getState().workspaceSplit;
    if (current) for (const group of getTerminalGroups(current)) usedGroupIdsRef.current.add(group.id);
    let id = `group-${nextGroupIdRef.current}`;
    while (usedGroupIdsRef.current.has(id)) {
      nextGroupIdRef.current += 1;
      id = `group-${nextGroupIdRef.current}`;
    }
    usedGroupIdsRef.current.add(id);
    nextGroupIdRef.current += 1;
    return id;
  }, []);

  const pendingFocusFrameRef = useRef<number | null>(null);
  const focusSession = useCallback((sessionId: string, automatic = false): void => {
    if (pendingFocusFrameRef.current !== null) cancelAnimationFrame(pendingFocusFrameRef.current);
    pendingFocusFrameRef.current = null;
    if (automatic && agentTerminalLeaseState.blocksUserInput(sessionId)) return;
    const controller = terminalRegistry.get(sessionId);
    const requestedWorkspace = useTerminalStore.getState().workspace;
    pendingFocusFrameRef.current = requestAnimationFrame(() => {
      pendingFocusFrameRef.current = null;
      if (useAppStore.getState().activeSection !== 'terminal'
        || useTerminalStore.getState().workspace !== requestedWorkspace
        || useTerminalStore.getState().activeSessionId !== sessionId
        || (automatic && agentTerminalLeaseState.blocksUserInput(sessionId))
        || !controller || controller.sessionId !== sessionId
        || terminalRegistry.get(sessionId) !== controller) return;
      controller.focus();
    });
  }, []);

  useEffect(() => () => {
    if (pendingFocusFrameRef.current !== null) cancelAnimationFrame(pendingFocusFrameRef.current);
  }, []);

  // The selected session takes precedence over the previously focused group
  // when an Agent switches the section and its target in the same UI commit.
  const prevSectionRef = useRef(activeSection);
  useEffect(() => {
    const prevSection = prevSectionRef.current;
    prevSectionRef.current = activeSection;
    if (prevSection === 'terminal' || activeSection !== 'terminal') return;
    const focusedGroup = split ? findTerminalGroup(split, focusedGroupRef.current) : null;
    const sessionId = activeSessionId || focusedGroup?.activeSessionId;
    if (sessionId) focusSession(sessionId, true);
  }, [activeSection, activeSessionId, split, focusSession]);

  useEffect(() => {
    if (restoredLayoutAppliedRef.current) return;
    restoredLayoutAppliedRef.current = true;
    const state = useTerminalStore.getState();
    const restored = state.restoredLayout;
    if (restored?.kind === 'split') {
      const restoredSplit = ensureUniqueTerminalGroupIds(restored) as TerminalSplitState;
      if (state.workspace === 'terminal') setSplit(restoredSplit);
      else useTerminalStore.setState({ workspaceViews: { ...state.workspaceViews,
        terminal: { activeSessionId: state.workspaceViews.terminal?.activeSessionId ?? state.activeSessionId,
          order: state.workspaceViews.terminal?.order ?? sessions.map(session => session.sessionId),
          split: restoredSplit, focusedSlot: 'first' } } });
    }
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
    setNewSessionDialogOpen(false);
    setTabSwitcherOpen(false);
    setContextMenu(null);
    setDropPreview(null);
    setRemoteFileDrop(null);
    if (activeSessionId) focusSession(activeSessionId, true);
  }, [workspace]);

  useEffect(() => {
    if (!restoreWorkspace || sessions.some((session) => session.pendingConnection)) return;
    const normal = useTerminalStore.getState().workspaceViews.terminal;
    const savedSplit = workspace === 'focus' ? normal?.split ?? null : split;
    const savedSessions = workspace === 'focus' && normal
      ? normal.order.flatMap(id => sessions.filter(session => session.sessionId === id)) : sessions;
    stageTerminalWorkspace(serializeTerminalWorkspace(savedSessions, savedSplit));
    const timer = window.setTimeout(() => {
      void flushTerminalWorkspace().catch((error) => {
        logger.error('failed to save terminal workspace', error);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [restoreWorkspace, sessions, split, workspace]);

  useEffect(() => {
    const handleNewTabRequest = (): void => setNewSessionDialogOpen((previous) => !previous);
    document.addEventListener('shellspan:new-terminal-tab', handleNewTabRequest);
    return () => document.removeEventListener('shellspan:new-terminal-tab', handleNewTabRequest);
  }, []);

  const shouldLoadLocalTerminalOptions = platform !== 'windows' || newSessionDialogOpen;
  useEffect(() => {
    if (!shouldLoadLocalTerminalOptions || !isTauriRuntime()) return;
    let mounted = true;
    void invokeGetLocalTerminalOptions().then((options) => {
      if (mounted) setLocalTerminalOptions(options);
    }).catch((error: unknown) => logger.warn('Failed to load local terminal options', error));
    return () => { mounted = false; };
  }, [shouldLoadLocalTerminalOptions]);

  useEffect(() => {
    const handleTabSwitcherRequest = (): void => {
      if (useTerminalStore.getState().sessions.length > 0) setTabSwitcherOpen(true);
    };
    document.addEventListener('shellspan:switch-terminal-tab', handleTabSwitcherRequest);
    return () => document.removeEventListener('shellspan:switch-terminal-tab', handleTabSwitcherRequest);
  }, []);

  // Keep terminal groups in sync when sessions are opened or closed elsewhere.
  useEffect(() => {
    // The restore effect can populate the split during this same commit.
    const {
      workspaceSplit: currentSplit, sessions: currentSessions,
      activeSessionId: currentActiveId, workspaceFocusedSlot, setActiveSession,
    } = useTerminalStore.getState();
    if (!currentSplit) return;
    let nextLayout: TerminalLayoutNode = currentSplit;

    // Connection replacements carry their predecessor id while replacing sessionId.
    // Apply those replacements before filtering unavailable ids so the tab
    // stays in the same terminal group, including during automatic reconnect.
    for (const session of currentSessions) {
      if (session.replacesSessionId) {
        nextLayout = replaceTerminalSessionId(nextLayout, session.replacesSessionId, session.sessionId);
      }
      if (session.replacedSessionIds) {
        for (const previousId of session.replacedSessionIds) {
          nextLayout = replaceTerminalSessionId(nextLayout, previousId, session.sessionId);
        }
      }
    }

    const availableIds = new Set(currentSessions.map((session) => session.sessionId));
    const syncNode = (node: TerminalLayoutNode): TerminalLayoutNode => {
      if (node.kind === 'split') {
        const first = syncNode(node.first);
        const second = syncNode(node.second);
        return first === node.first && second === node.second ? node : { ...node, first, second };
      }
      const ids = node.sessionIds.filter((id) => availableIds.has(id));
      const nextActiveSessionId =
        node.id === workspaceFocusedSlot && currentActiveId && ids.includes(currentActiveId)
          ? currentActiveId
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
    const missingIds = currentSessions
      .map((session) => session.sessionId)
      .filter((id) => !assignedIds.has(id));

    if (missingIds.length > 0) {
      const focusedGroup = findTerminalGroup(nextLayout, workspaceFocusedSlot)
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
      const nextActiveId = pruned?.activeSessionId || currentSessions[0]?.sessionId;
      if (nextActiveId) setActiveSession(nextActiveId);
      return;
    }
    // Skip the state update (and the re-renders, pin repartition and workspace
    // save it would trigger) when the layout is referentially unchanged.
    if (pruned !== currentSplit) setSplit(pruned);
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
    return canSplitTerminalPane(direction, content);
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
    const { sessions, activeSessionId, workspaceSplit: split } = useTerminalStore.getState();
    const resolvedSessionId = resolveCurrentSessionId(sessions, sessionId);
    if (!resolvedSessionId) {
      setDropPreview(null);
      return false;
    }
    const incomingFirst = direction === 'left' || direction === 'top';
    const orientation = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';

    if (split) {
      const sourceGroup = getTerminalGroups(split).find((group) => group.sessionIds.includes(resolvedSessionId));
      const targetGroup = targetGroupId
        ? findTerminalGroup(split, targetGroupId)
        : sourceGroup;
      if (!sourceGroup || !targetGroup) return false;
      if (!canCreateSplitAt(direction, targetGroup.id)) return false;

      let nextLayout: TerminalLayoutNode = split;
      if (sourceGroup.id === targetGroup.id) {
        const remainingIds = sourceGroup.sessionIds.filter((id) => id !== resolvedSessionId);
        if (remainingIds.length === 0) return false;
        const newGroup: TerminalGroupState = {
          kind: 'group',
          id: createGroupId(),
          sessionIds: [resolvedSessionId],
          activeSessionId: resolvedSessionId,
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
          sessionIds: group.sessionIds.filter((id) => id !== resolvedSessionId),
          activeSessionId: group.activeSessionId === resolvedSessionId
            ? group.sessionIds.filter((id) => id !== resolvedSessionId).slice(-1)[0] ?? ''
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
          sessionIds: [resolvedSessionId],
          activeSessionId: resolvedSessionId,
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
      useTerminalStore.getState().setActiveSession(resolvedSessionId);
      setDropPreview(null);
      return true;
    }

    if (sessions.length < 2) return false;
    if (!canCreateSplitAt(direction)) return false;
    const remainingIds = sessions
      .map((session) => session.sessionId)
      .filter((id) => id !== resolvedSessionId);
    if (remainingIds.length === 0) return false;
    const baseActiveId = activeSessionId && remainingIds.includes(activeSessionId)
      ? activeSessionId
      : remainingIds[remainingIds.length - 1];
    const targetGroup: TerminalGroupState = {
      kind: 'group', id: incomingFirst ? 'first' : 'second', sessionIds: [resolvedSessionId], activeSessionId: resolvedSessionId,
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
    useTerminalStore.getState().setActiveSession(resolvedSessionId);
    setDropPreview(null);
    return true;
  }, [canCreateSplitAt, createGroupId, focusGroup, setSplit]);

  const canSplitTab = useCallback((sessionId: string, direction: TerminalSplitDirection): boolean => {
    const state = useTerminalStore.getState();
    const source = state.sessions.find((session) => session.sessionId === sessionId);
    if (!source || source.pendingConnection) return false;
    const group = state.workspaceSplit
      && getTerminalGroups(state.workspaceSplit).find((item) => item.sessionIds.includes(sessionId));
    const count = group ? group.sessionIds.length : state.sessions.length;
    return canCreateSplitAt(direction, group ? group.id : undefined)
      && (count > 1 || (source.host === 'local' && source.port === 0)
        || Boolean(source.profileId && useProfileStore.getState().getProfile(source.profileId)));
  }, [canCreateSplitAt]);

  const splitTab = useCallback((sessionId: string, direction: TerminalSplitDirection): void => {
    if (!canSplitTab(sessionId, direction) || companionRequests.current.has(sessionId)) return;
    const state = useTerminalStore.getState();
    const source = state.sessions.find((session) => session.sessionId === sessionId);
    if (!source) return;
    const group = state.workspaceSplit
      && getTerminalGroups(state.workspaceSplit).find((item) => item.sessionIds.includes(sessionId));
    if ((group ? group.sessionIds.length : state.sessions.length) > 1) {
      createOrArrangeSplit(sessionId, direction);
      return;
    }
    if (direction !== 'right' && direction !== 'bottom') return;
    const profile = source.profileId ? useProfileStore.getState().getProfile(source.profileId) : undefined;
    if (!profile && (source.host !== 'local' || source.port !== 0)) return;

    const onAttemptStarted = (attemptId: string): void => {
      const current = useTerminalStore.getState();
      if (current.workspace !== state.workspace
        || !current.sessions.some((session) => session.sessionId === sessionId)) return;
      const layout = current.workspaceSplit;
      const groups = layout ? getTerminalGroups(layout) : [];
      if (groups.some((item) => item.sessionIds.includes(attemptId))) return;
      const original = groups.find((item) => item.sessionIds.includes(sessionId));
      if ((layout && !original) || !canCreateSplitAt(direction, original?.id)) return;
      const first: TerminalGroupState = original ?? {
        kind: 'group',
        id: 'first',
        sessionIds: current.sessions.map((session) => session.sessionId).filter((id) => id !== attemptId),
        activeSessionId: sessionId,
      };
      const second: TerminalGroupState = {
        kind: 'group', id: createGroupId(), sessionIds: [attemptId], activeSessionId: attemptId,
      };
      const branch: TerminalSplitState = {
        kind: 'split', first, second, orientation: direction === 'right' ? 'horizontal' : 'vertical', split: 0.5,
      };
      focusGroup(second.id);
      setSplit(layout ? replaceTerminalGroup(layout, first.id, branch) as TerminalSplitState : branch);
    };
    companionRequests.current.add(sessionId);
    const options = { insertAfterId: sessionId, onAttemptStarted };
    const openCompanion = async (): Promise<void> => {
      if (!profile) {
        await openLocal(source.ptyInfo?.localProfile, options);
        return;
      }
      const initialDirectory = source.sshRouteKey === sshRouteKey(profile)
        ? await getTerminalMenuDirectory(source.sessionId, false) : null;
      const current = useTerminalStore.getState();
      if (current.workspace !== state.workspace || !canSplitTab(sessionId, direction)) return;
      await connect(profile, { ...options, initialDirectory: initialDirectory ?? undefined });
    };
    void openCompanion().catch((error: unknown) => logger.error('Could not open companion terminal', error))
      .finally(() => companionRequests.current.delete(sessionId));
  }, [canCreateSplitAt, canSplitTab, connect, createGroupId, focusGroup, openLocal, setSplit]);

  const arrangePanes = useCallback((action: string): void => {
    const state = useTerminalStore.getState();
    if (!state.workspaceSplit) return;
    const slot = state.workspaceFocusedSlot;
    if (action === 'terminalZoomPane') state.toggleWorkspaceZoom(slot);
    else if (action === 'terminalEqualizePanes') setSplit(equalizeTerminalPanes(state.workspaceSplit));
    else if (action === 'terminalSwapPane') setSplit(swapTerminalPane(state.workspaceSplit, slot));
    if (state.activeSessionId) focusSession(state.activeSessionId);
  }, [focusSession, setSplit]);

  useEffect(() => {
    const handleArrange = (event: Event): void => {
      arrangePanes((event as CustomEvent<string>).detail);
    };
    document.addEventListener('shellspan:arrange-terminal-panes', handleArrange);
    return () => document.removeEventListener('shellspan:arrange-terminal-panes', handleArrange);
  }, [arrangePanes]);

  const activateTab = useCallback((slot: TerminalGroupSlot | null, sessionId: string): void => {
    if (slot !== null) {
      focusGroup(slot);
      setSplit((current) => current
        ? updateTerminalGroup(current, slot, (group) => ({ ...group, activeSessionId: sessionId })) as TerminalSplitState
        : current);
    }
    useTerminalStore.getState().setActiveSession(sessionId);
    focusSession(sessionId);
  }, [focusGroup, focusSession]);

  const activateSwitcherTab = useCallback((sessionId: string): void => {
    const group = split
      ? getTerminalGroups(split).find((candidate) => candidate.sessionIds.includes(sessionId))
      : null;
    activateTab(group?.id ?? null, sessionId);
  }, [activateTab, split]);

  const droppedPathText = (session: TerminalSession, paths: string[]): string | null =>
    quoteTerminalDropPaths(paths, session.ptyInfo?.transportKind === 'windowsConPty');

  const insertDroppedPaths = (sessionId: string, paths: string[]): void => {
    const target = useTerminalStore.getState().sessions.find((session) => session.sessionId === sessionId);
    const controller = terminalRegistry.get(sessionId);
    const text = target && droppedPathText(target, paths);
    if (!controller || !text || !target || target.readOnly || agentTerminalLeaseState.blocksUserInput(sessionId)) {
      showError(t('terminal.drop.unavailable'));
      return;
    }
    void controller.writeUserInput(text).then((written) => {
      if (written) activateSwitcherTab(sessionId);
      else showError(t('terminal.drop.unavailable'));
    }).catch(() => showError(t('terminal.notice.writeFailedLabel')));
  };

  useTerminalFileDrop(terminalAreaRef, terminalVisible, (sessionId, paths) => {
    const target = useTerminalStore.getState().sessions.find((session) => session.sessionId === sessionId);
    if (!target || target.status !== 'connected' || target.readOnly
      || !paths.length || paths.some((path) => !isAbsoluteTerminalPath({ host: 'local', port: 0 }, path))) {
      showError(t('terminal.drop.unavailable'));
      return;
    }
    if (target.host === 'local' && target.port === 0) insertDroppedPaths(sessionId, paths);
    else setRemoteFileDrop({ sessionId, paths });
  });

  const uploadDroppedFiles = (sessionId: string, paths: string[]): void => {
    setRemoteFileDrop(null);
    void getTerminalMenuDirectory(sessionId).then((path) => {
      const target = useTerminalStore.getState().sessions.find((session) => session.sessionId === sessionId);
      if (!path || !target || target.status !== 'connected'
        || !openTerminalSftpPath(target, path, { uploadPaths: paths })) {
        showError(t('terminal.drop.uploadUnavailable'));
      }
    });
  };

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
      activateTab(target.id, target.activeSessionId);
    };
    document.addEventListener('shellspan:navigate-terminal-pane', handlePaneNavigate);
    return () => document.removeEventListener('shellspan:navigate-terminal-pane', handlePaneNavigate);
  }, [split, activateTab]);

  const reorderGroupTabs = useCallback((slot: TerminalGroupSlot, sessionId: string, insertIndex: number): void => {
    setSplit((current) => {
      if (!current) return current;
      const group = findTerminalGroup(current, slot);
      if (!group) return current;
      const currentSessions = useTerminalStore.getState().sessions;
      const resolvedSessionId = resolveCurrentSessionId(currentSessions, sessionId);
      if (!resolvedSessionId || !group.sessionIds.includes(resolvedSessionId)) return current;
      const pinnedIds = new Set(
        currentSessions
          .filter((session) => session.pinned)
          .map((session) => session.sessionId),
      );
      const ids = group.sessionIds.filter((id) => id !== resolvedSessionId);
      ids.splice(Math.max(0, Math.min(insertIndex, ids.length)), 0, resolvedSessionId);
      const ordered = partitionSessionIdsPinnedFirst(ids, (id) => pinnedIds.has(id));
      return updateTerminalGroup(current, slot, (value) => ({ ...value, sessionIds: ordered })) as TerminalSplitState;
    });
  }, []);

  const moveTabToGroup = useCallback((sessionId: string, source: TerminalGroupSlot, target: TerminalGroupSlot, insertIndex: number): boolean => {
    if (source === target) return false;
    const { sessions: currentSessions, workspaceSplit: current } = useTerminalStore.getState();
    const resolvedSessionId = resolveCurrentSessionId(currentSessions, sessionId);
    if (!resolvedSessionId) {
      setDropPreview(null);
      return false;
    }
    const sourceGroup = current ? findTerminalGroup(current, source) : null;
    const targetGroup = current ? findTerminalGroup(current, target) : null;
    if (!current || !sourceGroup?.sessionIds.includes(resolvedSessionId) || !targetGroup) return false;
    const sourceIds = sourceGroup.sessionIds.filter((id) => id !== resolvedSessionId);
    const targetIds = targetGroup.sessionIds.filter((id) => id !== resolvedSessionId);
    targetIds.splice(Math.max(0, Math.min(insertIndex, targetIds.length)), 0, resolvedSessionId);
    const orderedTargetIds = partitionSessionIdsPinnedFirst(
      targetIds,
      (id) => Boolean(currentSessions.find((session) => session.sessionId === id)?.pinned),
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
      activeSessionId: resolvedSessionId,
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
    useTerminalStore.getState().setActiveSession(resolvedSessionId);
    setDropPreview(null);
    return true;
  }, [focusGroup, setSplit]);

  const handleTabDragMove = useCallback((sessionId: string, source: TerminalGroupSlot | null, x: number, y: number): void => {
    const resolvedSessionId = resolveCurrentSessionId(sessions, sessionId);
    if (!resolvedSessionId) {
      setDropPreview(null);
      return;
    }
    if (split && source) {
      const target = getGroupRegionAtPoint(x, y);
      if (!target) {
        setDropPreview(null);
        return;
      }
      if (target.region === 'tab-bar') {
        setDropPreview(target.slot !== source
          ? { kind: 'tab-bar', slot: target.slot, insertIndex: getCrossGroupInsertIndex(resolvedSessionId, target.slot, target.element, x) }
          : null);
        return;
      }
      const direction = getTerminalSplitDirection(target.element.getBoundingClientRect(), x, y);
      if (direction) {
        // Splitting its own pane only works while the source group keeps at
        // least one tab behind; a pane's only tab has nowhere to go, and the
        // drop would be a guaranteed no-op, so don't preview it.
        const targetGroup = findTerminalGroup(split, target.slot);
        const splittable = targetGroup !== null
          && canCreateSplitAt(direction, target.slot)
          && (target.slot !== source || targetGroup.sessionIds.some((id) => id !== resolvedSessionId));
        setDropPreview(splittable
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
  }, [canCreateSplitAt, getCrossGroupInsertIndex, getGroupRegionAtPoint, sessions, split]);

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
      splitTab(sessionId, detail.direction);
    };
    document.addEventListener('shellspan:split-terminal-pane', handlePaneSplit);
    return () => document.removeEventListener('shellspan:split-terminal-pane', handlePaneSplit);
  }, [activeSessionId, splitTab, split]);

  const renderTerminalPane = (session: TerminalSession | null, isActive: boolean): React.ReactNode => (
    <TerminalPane
      key={session?.sessionId}
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
    const groups = getTerminalGroups(split);
    const paneIndex = Math.max(1, groups.findIndex((item) => item.id === slot) + 1);
    const isZoomed = zoomedSlot === slot;
    const zoomShortcut = zoomLeader && zoomKey
      ? `${getShortcutKeys(zoomLeader, platform).join('+')} ${getShortcutKeys(zoomKey, platform).join('+')}`
      : undefined;
    let hiddenActivity: 'error' | 'unread' | null = null;
    if (isZoomed) {
      const hiddenIds = new Set(groups.filter((item) => item.id !== slot).flatMap((item) => item.sessionIds));
      for (const session of sessions) {
        if (!hiddenIds.has(session.sessionId)) continue;
        if (session.unreadCommand === 'failed' || session.status === 'error') {
          hiddenActivity = 'error';
          break;
        }
        if (session.unreadCommand === 'completed') hiddenActivity = 'unread';
      }
    }
    const focused = focusedSlot === slot;
    return (
      <div
        data-terminal-group={slot}
        className={cn(
          '@container/tabbar isolate relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg',
          focused && !isZoomed && 'ring-1 ring-inset ring-app-primary/70',
        )}
        onPointerDownCapture={(e) => {
          // macOS tap-to-click: the tap that focuses an inactive group would
          // otherwise reach xterm as mousedown, so the continued touchpad
          // motion is treated as a drag and starts a selection. Swallow
          // pointerdowns landing on the terminal screen of an inactive group
          // and just focus the group; tab bar presses are left untouched.
          if (focused) return;
          if ((e.target as HTMLElement).closest('.agent-terminal-takeover')) return;
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
          // group via activateTab. Handling them here as well would
          // re-activate the render-time groupActiveSession, clobbering a
          // same-press tab switch with the stale session.
          if ((e.target as HTMLElement).closest('[data-session-tab], .agent-terminal-takeover')) return;
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
          paneZoom={{
            zoomed: isZoomed,
            paneIndex,
            paneCount: groups.length,
            hiddenActivity,
            shortcut: zoomShortcut,
          }}
          onNewTabClick={() => {
            focusGroup(slot);
            setNewSessionDialogOpen(true);
          }}
          onSwitchTab={() => setTabSwitcherOpen(true)}
          onConfigureBroadcast={configureBroadcast}
          canSplitTab={(direction) => Boolean(groupActiveSession && canSplitTab(groupActiveSession.sessionId, direction))}
          onSplitTab={splitTab}
          onArrangePanes={(action) => {
            if (!focused && groupActiveSession) activateTab(slot, groupActiveSession.sessionId);
            arrangePanes(action);
          }}
          onUnsplit={() => setSplit(null)}
          onTabContextMenu={(session, x, y) => setContextMenu({ session, x, y, slot })}
          onTabActivate={(sessionId) => activateTab(slot, sessionId)}
          onTabReorder={(sessionId, index) => reorderGroupTabs(slot, sessionId, index)}
          onTabDragMove={(sessionId, x, y) => handleTabDragMove(sessionId, slot, x, y)}
          onTabDragEnd={(sessionId, x, y) => handleTabDragEnd(sessionId, slot, x, y)}
          onTabDragCancel={() => setDropPreview(null)}
          externalInsertIndex={dropPreview?.kind === 'tab-bar' && dropPreview.slot === slot
            ? dropPreview.insertIndex
            : null}
        />
        <div data-terminal-content className="relative min-h-0 flex-1">
          {renderTerminalPane(
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
      />
    );
  };

  return (
    <div
      data-terminal-workspace
      className="isolate flex h-full flex-col bg-app-bg"
    >
      <TerminalControllerLayer />
      <TerminalCommandActivity />
      <TerminalBroadcastControls visible={terminalVisible} onSelectSession={activateSwitcherTab} />
      {sessions.length > 0 && !split && (
        <TerminalTabBar
          onNewTabClick={() => setNewSessionDialogOpen(true)}
          onSwitchTab={() => setTabSwitcherOpen(true)}
          onConfigureBroadcast={configureBroadcast}
          canSplitTab={(direction) => Boolean(activeSession && canSplitTab(activeSession.sessionId, direction))}
          onSplitTab={splitTab}
          onTabContextMenu={(session, x, y) => setContextMenu({ session, x, y, slot: null })}
          onTabActivate={(sessionId) => activateTab(null, sessionId)}
          onTabDragMove={(sessionId, x, y) => handleTabDragMove(sessionId, null, x, y)}
          onTabDragEnd={(sessionId, x, y) => handleTabDragEnd(sessionId, null, x, y)}
          onTabDragCancel={() => setDropPreview(null)}
        />
      )}
      <div key={workspace} ref={terminalAreaRef} data-terminal-workspace-area className="relative min-h-0 flex-1">
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
          zoomedSlot ? renderGroup(zoomedSlot) : renderLayout(split)
        ) : (
          <div data-terminal-content className="relative h-full w-full">
            {renderTerminalPane(activeSession, true)}
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
          defaultShellKind={localTerminalOptions?.defaultShellKind}
          defaultShellPath={localTerminalOptions?.defaultShellPath}
          supportsShellSpanBash={localTerminalOptions?.supportsShellSpanBash}
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
        canSplit={Boolean(contextMenu)}
        canSplitDirection={(direction) => Boolean(contextMenu && canSplitTab(contextMenu.session.sessionId, direction))}
        isSplit={Boolean(split)}
        onSplit={splitTab}
        onUnsplit={() => setSplit(null)}
      />
      <Dialog open={remoteFileDrop !== null} onOpenChange={(open) => { if (!open) setRemoteFileDrop(null); }}>
        {remoteFileDrop && <CompactDialogContent className="max-w-md">
          <CompactDialogHeader title={t('terminal.drop.title')} description={t('terminal.drop.description', {
            count: remoteFileDrop.paths.length,
            target: sessions.find((session) => session.sessionId === remoteFileDrop.sessionId)?.title ?? '',
          })} />
          <CompactDialogBody>
            <ul className="flex flex-col gap-1 rounded-md border border-app-border/60 bg-muted/50 px-3 py-2 text-xs text-app-text">
              {remoteFileDrop.paths.slice(0, 5).map((path, index) => (
                <li key={`${index}:${path}`} className="truncate font-mono" title={path}>
                  {path.split(/[\\/]/).pop() || path}
                </li>
              ))}
              {remoteFileDrop.paths.length > 5 && (
                <li className="text-muted-foreground">+{remoteFileDrop.paths.length - 5}</li>
              )}
            </ul>
          </CompactDialogBody>
          <CompactDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoteFileDrop(null)}>{t('common.cancel')}</Button>
            <Button variant="outline" size="sm" onClick={() => {
              insertDroppedPaths(remoteFileDrop.sessionId, remoteFileDrop.paths);
              setRemoteFileDrop(null);
            }}>{t('terminal.drop.insert')}</Button>
            <Button size="sm" onClick={() => uploadDroppedFiles(remoteFileDrop.sessionId, remoteFileDrop.paths)}>
              {t('terminal.drop.upload')}
            </Button>
          </CompactDialogFooter>
        </CompactDialogContent>}
      </Dialog>
    </div>
  );
};

export default Terminal;
