export interface AgentLifecycleHandlers {
  readonly cancelForSession: (sessionId: string) => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

const NOOP_HANDLERS: AgentLifecycleHandlers = {
  cancelForSession: async () => {},
  shutdown: async () => {},
};

let handlers = NOOP_HANDLERS;

export function registerAgentLifecycleHandlers(next: AgentLifecycleHandlers): () => void {
  handlers = next;
  return () => {
    if (handlers === next) handlers = NOOP_HANDLERS;
  };
}

export function cancelAgentForSession(sessionId: string): Promise<void> {
  return handlers.cancelForSession(sessionId);
}

export function shutdownAgentLifecycle(): Promise<void> {
  return handlers.shutdown();
}
