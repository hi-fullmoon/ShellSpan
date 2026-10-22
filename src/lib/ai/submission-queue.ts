import type { AiSubmitInput, AiSubmitReceipt } from './session-adapter';
import { AiAdmissionUnconfirmedError, AiPreparationTimeoutError } from './session-error';

type ObserveAdmission = (sessionId: string, committed: (paused?: boolean) => void) => () => void;

/** One serial admission stream per conversation, independent of React navigation.
 * A rejected admission holds later inputs until the same operation is retried.
 * Model execution is never awaited here. */
export class AiSubmissionQueue {
  private sessionId: string | null;
  private entries: {
    id: string;
    prepare: () => Promise<AiSubmitInput<'agent'>>;
    input?: AiSubmitInput<'agent'>;
    paused?: boolean;
    started?: () => void;
    observe?: ObserveAdmission;
    reconciled?: (receipt: AiSubmitReceipt) => void;
    resolve: (receipt: AiSubmitReceipt) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private running = false;
  private blocked = false;
  private stopObserving?: () => void;
  private acknowledging = false;

  constructor(sessionId: string | null, private readonly submit: (
    sessionId: string | null, input: AiSubmitInput<'agent'>,
  ) => Promise<AiSubmitReceipt>, private readonly stop?: (sessionId: string) => Promise<void>,
  private readonly onStopError?: (sessionId: string, error: unknown) => void) {
    this.sessionId = sessionId;
  }

  enqueue(id: string, prepare: () => Promise<AiSubmitInput<'agent'>>, started?: () => void, observe?: ObserveAdmission,
    reconciled?: (receipt: AiSubmitReceipt) => void): Promise<AiSubmitReceipt> {
    return new Promise((resolve, reject) => {
      const previous = this.entries.find(entry => entry.id === id);
      if (previous) {
        // Retry retains the original session, content, attachments and identity.
        if (!this.blocked || this.acknowledging || previous !== this.entries[0]) {
          reject(new Error('Submission is already pending'));
          return;
        }
        previous.resolve = resolve;
        previous.reject = reject;
        previous.started = started;
        previous.observe = observe;
        previous.reconciled = reconciled;
        this.stopObserving?.();
        this.stopObserving = undefined;
        if (!previous.input) previous.prepare = prepare;
        this.blocked = false;
      } else {
        this.entries.push({ id, prepare, resolve, reject, started, observe, reconciled });
      }
      void this.drain();
    });
  }

  bindSession(sessionId: string): void { this.sessionId ??= sessionId; }

  get boundSessionId(): string | null { return this.sessionId; }

  /** A late durable receipt releases a previously rejected queue head. */
  acknowledge(receipt: AiSubmitReceipt): void {
    const head = this.entries[0];
    if (!this.blocked || this.acknowledging || !head || head.id !== receipt.clientOperationId) return;
    this.acknowledging = true;
    this.sessionId = receipt.sessionId;
    this.stopObserving?.();
    this.stopObserving = undefined;
    void (async () => {
      try {
        if (head.paused && !receipt.paused) await this.stop?.(receipt.sessionId);
      } catch (error) {
        this.onStopError?.(receipt.sessionId, error);
      } finally {
        if (receipt.paused) this.pause();
        this.entries.shift();
        this.blocked = false;
        this.acknowledging = false;
        head.resolve(receipt);
        queueMicrotask(() => { void this.drain(); });
        head.reconciled?.(receipt);
      }
    })();
  }

  pause(): void { for (const entry of this.entries) entry.paused = true; }

  private async drain(): Promise<void> {
    if (this.running || this.blocked) return;
    this.running = true;
    try {
      while (this.entries.length) {
        const entry = this.entries[0];
        try {
          entry.started?.();
          if (!entry.input) {
            let preparationTimer: ReturnType<typeof setTimeout> | undefined;
            entry.input = await Promise.race([
              entry.prepare(),
              new Promise<AiSubmitInput<'agent'>>((_, reject) => {
                preparationTimer = setTimeout(() => reject(new AiPreparationTimeoutError()), 15_000);
              }),
            ]).finally(() => clearTimeout(preparationTimer));
          }
          const input = { ...entry.input, paused: entry.paused || entry.input.paused };
          let admissionTimer: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          const admission = this.submit(this.sessionId, input).then(receipt => {
            // Promise.race does not cancel the native request. Its eventual
            // durable receipt must release the queue even without a stream event.
            if (timedOut) this.acknowledge(receipt);
            return receipt;
          });
          const receipt = await Promise.race([
            admission,
            new Promise<AiSubmitReceipt>((_, reject) => {
              admissionTimer = setTimeout(() => {
                timedOut = true;
                reject(new AiAdmissionUnconfirmedError());
              }, 15_000);
            }),
          ]).finally(() => clearTimeout(admissionTimer));
          this.sessionId = receipt.sessionId;
          if (entry.paused && !input.paused) {
            try {
              await this.stop?.(receipt.sessionId);
            } catch (error) {
              // Admission is already durable. A control failure must not retain
              // this entry as a failed send or block later paused admissions.
              this.onStopError?.(receipt.sessionId, error);
            }
          }
          if (receipt.paused) this.pause();
          this.entries.shift();
          entry.resolve(receipt);
        } catch (error) {
          this.blocked = true;
          entry.reject(error);
          const sessionId = this.sessionId ?? entry.input?.create?.request.sessionId;
          if (error instanceof AiAdmissionUnconfirmedError && sessionId && entry.observe) {
            this.stopObserving = entry.observe(sessionId, paused => this.acknowledge({
              sessionId, clientOperationId: entry.id, mode: entry.input!.mode, paused,
            }));
            if (!this.blocked) {
              this.stopObserving?.();
              this.stopObserving = undefined;
            }
          }
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
