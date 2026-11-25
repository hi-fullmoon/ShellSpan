import { AiAdmissionUnconfirmedError } from './session-error';

export type ConfirmationTrigger = { kind: 'backfill' | 'success' } | { kind: 'error'; error: unknown };

/** A durable receipt can finish an operation even when its reply or backfill is lost. */
export async function awaitMutationAcknowledgement(
  command: () => Promise<unknown>,
  receipt: Promise<void>,
  reconcile: (trigger: ConfirmationTrigger) => Promise<void>,
  options: { readonly signal: AbortSignal; readonly backfillOnSuccess?: boolean; readonly backfillAfterMs: number },
): Promise<void> {
  const { signal } = options;
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backfill = new Promise<ConfirmationTrigger>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'backfill' }), options.backfillAfterMs);
  });
  const confirmation = Promise.race([
    backfill,
    Promise.resolve().then(command).then(
      () => options.backfillOnSuccess ? { kind: 'success' } as const : backfill,
      error => ({ kind: 'error', error } as const),
    ),
  ]).then(reconcile);
  void confirmation.catch(() => undefined);
  void cancelled.catch(() => undefined);
  try {
    await Promise.race([receipt, confirmation, cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Limit both the request and any reconciliation it starts. */
export async function withOperationDeadline<T>(
  timeoutMs: number,
  timeoutError: () => Error,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const scope = new AbortController();
  const timer = setTimeout(() => scope.abort(timeoutError()), timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    scope.signal.addEventListener('abort', () => reject(scope.signal.reason), { once: true });
  });
  const running = Promise.resolve().then(() => operation(scope.signal));
  void running.catch(() => undefined);
  void deadline.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
    scope.abort();
  }
}

type AdmissionBackfill = { kind: 'found'; paused: boolean } | { kind: 'missing' | 'unavailable' };

/** Keep listening for the native admission reply while storage is being read. */
export async function awaitInboxAdmission(
  command: () => Promise<boolean>,
  receipt: Promise<boolean>,
  backfill: (signal: AbortSignal) => Promise<AdmissionBackfill>,
  timing = { deadlineMs: 15_000, pollMs: 3_000 },
): Promise<boolean> {
  return withOperationDeadline(timing.deadlineMs, () => new AiAdmissionUnconfirmedError(), async signal => {
    let failure: { kind: 'error'; error: unknown } | undefined;
    const request = Promise.resolve().then(command).then(
      paused => ({ kind: 'found', paused } as const), error => {
        failure = { kind: 'error', error };
        return failure;
      },
    );
    const observed = receipt.then(paused => ({ kind: 'found', paused } as const));
    const decisiveReply = request.then(result => {
      if (result.kind === 'found') return result;
      if (/different payload|SUBMISSION_CONFLICT/.test(String(result.error))) throw result.error;
      // Other errors require a successful read before we can report rejection.
      return new Promise<never>(() => {});
    });
    void decisiveReply.catch(() => undefined);
    const waitForReceipt = (replies: readonly Promise<Awaited<typeof request>>[]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const interval = new Promise<{ kind: 'interval' }>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'interval' }), timing.pollMs);
      });
      return Promise.race([...replies, observed, interval]).finally(() => clearTimeout(timer));
    };
    let waitAfterFailedRead = false;
    while (!signal.aborted) {
      const result = await waitForReceipt(waitAfterFailedRead ? [decisiveReply] : [request]);
      if (result.kind === 'found') return result.paused;
      signal.throwIfAborted();
      // An older read cannot prove rejection if the command failed while it
      // was in flight. Confirm against storage again after that failure.
      const failureBeforeRead = failure;
      const refreshed = await Promise.race([backfill(signal), decisiveReply, observed]);
      if (refreshed.kind === 'found') return refreshed.paused;
      if (refreshed.kind === 'missing' && failureBeforeRead) throw failureBeforeRead.error;
      waitAfterFailedRead = refreshed.kind === 'unavailable';
    }
    signal.throwIfAborted();
    throw new AiAdmissionUnconfirmedError();
  });
}
