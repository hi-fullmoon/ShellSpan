import type { AiSubmitInput, AiSubmitReceipt } from './session-adapter';

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
    resolve: (receipt: AiSubmitReceipt) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private running = false;
  private blocked = false;

  constructor(sessionId: string | null, private readonly submit: (
    sessionId: string | null, input: AiSubmitInput<'agent'>,
  ) => Promise<AiSubmitReceipt>, private readonly stop?: (sessionId: string) => Promise<void>) {
    this.sessionId = sessionId;
  }

  enqueue(id: string, prepare: () => Promise<AiSubmitInput<'agent'>>): Promise<AiSubmitReceipt> {
    return new Promise((resolve, reject) => {
      const previous = this.entries.find(entry => entry.id === id);
      if (previous) {
        // Retry retains the original session, content, attachments and identity.
        if (!this.blocked || previous !== this.entries[0]) {
          reject(new Error('Submission is already pending'));
          return;
        }
        previous.resolve = resolve;
        previous.reject = reject;
        if (!previous.input) previous.prepare = prepare;
        this.blocked = false;
      } else {
        this.entries.push({ id, prepare, resolve, reject });
      }
      void this.drain();
    });
  }

  bindSession(sessionId: string): void { this.sessionId ??= sessionId; }

  pause(): void { for (const entry of this.entries) entry.paused = true; }

  private async drain(): Promise<void> {
    if (this.running || this.blocked) return;
    this.running = true;
    try {
      while (this.entries.length) {
        const entry = this.entries[0];
        try {
          entry.input ??= await entry.prepare();
          const input = { ...entry.input, paused: entry.paused || entry.input.paused };
          const receipt = await this.submit(this.sessionId, input);
          this.sessionId = receipt.sessionId;
          if (entry.paused && !input.paused) await this.stop?.(receipt.sessionId);
          if (receipt.paused) this.pause();
          this.entries.shift();
          entry.resolve(receipt);
        } catch (error) {
          this.blocked = true;
          entry.reject(error);
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
