import { describe, expect, it } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitInboxAdmission, awaitMutationAcknowledgement, withOperationDeadline } from '../mutation-acknowledgement';

const unresolved = new Promise<never>(() => {});

describe('durable mutation acknowledgement', () => {
  it('finishes on a receipt without waiting for a lost command reply', async () => {
    const operation = withOperationDeadline(500, () => new Error('confirmation deadline'), signal => {
      let confirm!: () => void;
      const receipt = new Promise<void>(resolve => { confirm = resolve; });
      return awaitMutationAcknowledgement(() => unresolved, receipt, () => {
        confirm();
        return unresolved;
      }, { signal, backfillAfterMs: 0 });
    });
    await expect(operation).resolves.toBeUndefined();
  });

  it('releases a lost command when confirmation reaches its deadline', async () => {
    let backfillStarted = false;
    const operation = withOperationDeadline(30, () => new Error('confirmation deadline'), signal => (
      awaitMutationAcknowledgement(() => unresolved, unresolved, () => {
        backfillStarted = true;
        return unresolved;
      }, { signal, backfillAfterMs: 0 })
    ));
    await expect(operation).rejects.toThrow('confirmation deadline');
    expect(backfillStarted).toBe(true);
  });

  it('does not treat a command reply as a durable receipt', async () => {
    const operation = withOperationDeadline(500, () => new Error('confirmation deadline'), signal => (
      awaitMutationAcknowledgement(async () => {}, unresolved, async () => {
        throw new Error('receipt missing from the log');
      }, { signal, backfillAfterMs: 0, backfillOnSuccess: true })
    ));
    await expect(operation).rejects.toThrow('receipt missing from the log');
  });

  it('acknowledges a late admission reply while its backfill is stalled', async () => {
    let reply!: (paused: boolean) => void;
    const request = new Promise<boolean>(resolve => { reply = resolve; });
    const operation = awaitInboxAdmission(() => request, unresolved, () => {
      reply(true);
      return unresolved;
    }, { deadlineMs: 500, pollMs: 0 });
    await expect(operation).resolves.toBe(true);
  });

  it('checks storage again if the reply fails after an earlier read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shellspan-admission-'));
    const path = join(directory, 'receipt');
    let rejectReply!: (error: Error) => void;
    const request = new Promise<boolean>((_, reject) => { rejectReply = reject; });
    let reads = 0;
    try {
      const operation = awaitInboxAdmission(() => request, unresolved, async () => {
        reads += 1;
        const missing = await access(path).then(() => false, (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return true;
        });
        if (reads === 1) {
          expect(missing).toBe(true);
          await writeFile(path, 'committed');
          rejectReply(new Error('IPC disconnected after commit'));
          // Deliver the IPC failure before returning the earlier read.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        return missing ? { kind: 'missing' } : { kind: 'found', paused: false };
      }, { deadlineMs: 1000, pollMs: 0 });
      await expect(operation).resolves.toBe(false);
      expect(reads).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
