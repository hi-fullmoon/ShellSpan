import { useCallback, useMemo, useState } from 'react';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { AiScrollAnchor } from '@/lib/ai/panel-route';
import { advancingConversationHistoryIndex, initialConversationHistoryIndex } from '@/lib/ai/conversation-history';

export function useConversationHistory(
  allNodes: readonly AiConversationNode[],
  pageSize: number,
  initialAnchor?: AiScrollAnchor,
  onAnchorChange?: (anchor: AiScrollAnchor) => void,
  onLoadOlder?: () => void,
) {
  const [history, setHistory] = useState(() => {
    const start = initialConversationHistoryIndex(allNodes, pageSize, initialAnchor);
    return {
      firstKey: start > 0 ? allNodes[start].key : null,
      following: !initialAnchor || initialAnchor.atBottom === true,
      expanded: false,
    };
  });
  const startIndex = advancingConversationHistoryIndex(
    allNodes, history.firstKey, pageSize, history.following && !history.expanded,
  );
  const firstKey = startIndex > 0 ? allNodes[startIndex].key : null;
  // Persist the derived boundary before rows commit. Detaching must not remount
  // the prefix just removed by a live append.
  if (history.firstKey !== firstKey) setHistory({ ...history, firstKey });
  const saveAnchor = useCallback((anchor: AiScrollAnchor) => {
    const following = anchor.atBottom === true;
    setHistory((current) => {
      const expanded = current.expanded && following;
      return current.following === following && current.expanded === expanded
        ? current : { ...current, following, expanded };
    });
    onAnchorChange?.(anchor);
  }, [onAnchorChange]);
  const resumeFollowing = useCallback(() => {
    setHistory((current) => current.following && !current.expanded
      ? current : { ...current, following: true, expanded: false });
  }, []);
  const nodes = useMemo(() => startIndex > 0 ? allNodes.slice(startIndex) : allNodes, [allNodes, startIndex]);
  const revealOlder = () => {
    const nextStart = Math.max(0, startIndex - pageSize);
    setHistory((current) => ({ ...current,
      firstKey: nextStart === 0 ? null : allNodes[nextStart].key,
      expanded: true,
    }));
    if (startIndex === 0) onLoadOlder?.();
  };
  return { nodes, startIndex, saveAnchor, revealOlder, resumeFollowing };
}
