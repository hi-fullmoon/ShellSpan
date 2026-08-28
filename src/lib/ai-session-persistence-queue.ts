const persistenceQueues = new Map<string, Promise<void>>();

export function enqueueAiSessionPersistence(
  conversationId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = persistenceQueues.get(conversationId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  persistenceQueues.set(conversationId, next);
  const cleanup = (): void => {
    if (persistenceQueues.get(conversationId) === next) {
      persistenceQueues.delete(conversationId);
    }
  };
  void next.then(cleanup, cleanup);
  return next;
}

export async function flushAiSessionPersistenceQueue(): Promise<void> {
  while (persistenceQueues.size > 0) {
    await Promise.allSettled([...persistenceQueues.values()]);
  }
}
