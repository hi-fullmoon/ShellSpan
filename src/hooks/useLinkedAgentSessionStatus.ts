import { useEffect, useState } from 'react';
import {
  invokeGetAgentRuntimeSession,
  isTauriRuntime,
  subscribeAgentRuntimeSessionEvents,
} from '@/lib/ipc/tauri';
import type { AgentSessionRuntimeStatus } from '@/types/agent-session';

export function useLinkedAgentSessionStatus(
  sessionId: string | null,
  initialStatus: AgentSessionRuntimeStatus | null = null,
): AgentSessionRuntimeStatus | null {
  const [status, setStatus] = useState<AgentSessionRuntimeStatus | null>(initialStatus);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus, sessionId]);

  useEffect(() => {
    if (!sessionId || !isTauriRuntime()) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    void invokeGetAgentRuntimeSession({ sessionId })
      .then((snapshot) => {
        if (active) setStatus(snapshot.status);
      })
      .catch(() => undefined);

    void subscribeAgentRuntimeSessionEvents(sessionId, (event) => {
      if (!active) return;
      if (event.type === 'agent/status') {
        setStatus(event.data.status);
      } else if (event.type === 'session/ended') {
        setStatus(event.data.status);
      }
    }).then((dispose) => {
      if (!active) {
        dispose();
      } else {
        unlisten = dispose;
      }
    }).catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [sessionId]);

  return status;
}
