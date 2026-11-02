import { invoke } from '@tauri-apps/api/core';
import { info } from '@tauri-apps/plugin-log';
import { readImageDraft, writeImageDraft, detachImageDraft, restoreCancelledImageDraft,
  acknowledgeDetachedImageDraft, holdDetachedImageDraft, type ImageDraft } from '@/lib/ai/image-drafts';
import { hydrateLocalState, saveLocalState, readLocalState, flushLocalState } from '@/lib/preferences/local-state';
import { invokeReadLogFile } from '@/lib/ipc/tauri';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const owner = 'agent:native-storage-verification';
const phase = new URLSearchParams(location.search).get('phase');

async function verify(): Promise<void> {
  const image = new Uint8Array(await (await fetch('/src-tauri/icons/32x32.png')).arrayBuffer());
  const imageData = btoa(String.fromCharCode(...image));
  const source = await (await fetch('/README.md')).text();
  await hydrateLocalState();
  if (phase === 'reopen') {
    check(readLocalState('shellspan.focus.split') === '0.65', 'UI preferences did not survive application restart');
    const restored = await readImageDraft(owner, true);
    check(restored?.images[0]?.data === imageData && restored.text === source, 'Draft bytes or text did not survive application restart');
    check(restored.operation === undefined, 'Completed preparation remained attached to the editor');
    return;
  }
  saveLocalState('shellspan.focus.split', '0.65');
  saveLocalState('shellspan.aiPanelWidth.terminal', '560');
  await flushLocalState();
  const original: ImageDraft = { owner, revision: 1, text: source,
    images: [{ name: '32x32.png', mediaType: 'image/png', data: imageData }] };
  await writeImageDraft(original, 0);
  const contenders = await Promise.allSettled([
    writeImageDraft({ ...original, revision: 2 }, 1),
    writeImageDraft({ ...original, revision: 2 }, 1),
  ]);
  check(contenders.filter(result => result.status === 'fulfilled').length === 1, 'Concurrent writes did not enforce draft revisions');
  const current = await readImageDraft(owner, true);
  check(current?.revision === 2, 'Wrong revision after concurrent write');
  const bound: ImageDraft = { ...current, revision: 3,
    operation: { id: 'native-storage-preparation', sessionId: 'native-storage-verification', mode: 'nextTurn' } };
  await writeImageDraft(bound, 2);
  const abort = new AbortController(); abort.abort();
  const cancelled = await Promise.allSettled([detachImageDraft(bound, abort.signal)]);
  check(cancelled[0].status === 'rejected', 'Cancelled preparation was detached');
  check((await readImageDraft(owner, true))?.revision === 3, 'Cancelled preparation changed persisted state');
  const inFlightCancellation = new AbortController();
  const transferring = detachImageDraft(bound, inFlightCancellation.signal);
  inFlightCancellation.abort();
  const detached = await transferring;
  const release = holdDetachedImageDraft(bound.operation!.id);
  check(!(await readImageDraft(owner))?.images.length, 'Active submission was restored over the editor');
  release();
  check((await readImageDraft(owner))?.owner === detached.owner, 'Interrupted detached submission was not recoverable');
  const recovered = await restoreCancelledImageDraft(bound);
  check(recovered?.owner === owner && recovered.images[0].data === imageData, 'Cancelled preparation lost its image');
  const rebound = { ...recovered, revision: recovered.revision + 1,
    operation: { id: 'native-storage-second-preparation', sessionId: 'native-storage-verification', mode: 'nextTurn' as const } };
  await writeImageDraft(rebound, recovered.revision);
  const second = await detachImageDraft(rebound);
  const blank = await readImageDraft(owner, true);
  check(blank, 'Missing editor after detach');
  const newer = { owner, revision: blank.revision + 1, text: source, images: [] };
  await writeImageDraft(newer, blank.revision);
  check(await restoreCancelledImageDraft(rebound) === null, 'Cancellation overwrote newer editor content');
  check((await readImageDraft(owner))?.owner === owner, 'Pending images overwrote newer editor text');
  await Promise.all([acknowledgeDetachedImageDraft(second.operation!.id), acknowledgeDetachedImageDraft(second.operation!.id)]);
  check(await readImageDraft(second.owner, true) === null, 'Accepted submission was not cleared idempotently');
  await writeImageDraft({ ...newer, revision: newer.revision + 1, images: original.images }, newer.revision);
  await info('Native frontend storage verification completed');
  const log = await invokeReadLogFile('frontend.log');
  check(log.includes('Native frontend storage verification completed'), 'Log viewer did not read the configured log directory');
}

void verify().then(async () => {
  await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: true, phase }) });
  await invoke('request_app_exit');
}).catch(async (error: unknown) => {
  await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: false, phase, error: String(error) }) });
  await invoke('request_app_exit');
});
