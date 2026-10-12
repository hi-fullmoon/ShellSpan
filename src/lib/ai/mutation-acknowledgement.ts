/** A durable receipt can finish an operation even when its IPC reply is lost. */
export async function awaitMutationAcknowledgement(
  command: Promise<unknown>,
  receipt: Promise<void>,
  confirmCurrent: () => void,
): Promise<void> {
  await Promise.race([command, receipt]);
  confirmCurrent();
  await receipt;
}
