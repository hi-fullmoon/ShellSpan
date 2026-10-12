import { describe, expect, it } from 'vitest';
import { awaitMutationAcknowledgement } from '../mutation-acknowledgement';

describe('durable mutation acknowledgement', () => {
  it('finishes on a receipt without waiting for a lost command reply', async () => {
    const pending = new Promise<never>(() => {});
    const receipt = new Promise<void>(resolve => setTimeout(resolve, 10));
    await expect(awaitMutationAcknowledgement(pending, receipt, () => {})).resolves.toBeUndefined();
  });

  it('releases a lost command when confirmation reaches its deadline', async () => {
    const pending = new Promise<never>(() => {});
    const receipt = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('confirmation deadline')), 10));
    await expect(awaitMutationAcknowledgement(pending, receipt, () => {})).rejects.toThrow('confirmation deadline');
  });

  it('does not treat a command reply as a durable receipt', async () => {
    let confirmReceipt: () => void = () => {};
    const receipt = new Promise<void>(resolve => { confirmReceipt = resolve; });
    let completed = false;
    const operation = awaitMutationAcknowledgement(Promise.resolve(), receipt, () => {}).then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    confirmReceipt();
    await operation;
    expect(completed).toBe(true);
  });
});
