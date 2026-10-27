import { invokeLoadUiPreferences, invokeSaveUiPreferences, isTauriRuntime } from '@/lib/ipc/tauri';
const values = new Map<string, string>();
const pending = new Map<string, string>();
const hydrationListeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();

export function readLocalState(key: string): string | null { return values.get(key) ?? null; }
export function onLocalStateHydrated(listener: () => void): () => void {
  hydrationListeners.add(listener);
  return () => { hydrationListeners.delete(listener); };
}
export async function hydrateLocalState(): Promise<void> {
  if (!isTauriRuntime()) return;
  const entries = await invokeLoadUiPreferences();
  values.clear();
  for (const [key, value] of entries) values.set(key, value);
  for (const listener of hydrationListeners) listener();
}
export function saveLocalState(key: string, value: string): void {
  values.set(key, value);
  // Browser previews have no native persistence; desktop state is stored only in SQLite.
  if (!isTauriRuntime()) return;
  pending.set(key, value);
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    void flushLocalState().catch(() => { /* IPC records the error; the failed batch remains pending. */ });
  }, 150);
}
export function flushLocalState(): Promise<void> {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  writes = writes.catch(() => undefined).then(async () => {
    // Collect after the preceding write settles so a restored failed batch is
    // included in an already queued exit flush, together with the latest edits.
    const entries: [string, string][] = [...pending];
    pending.clear();
    if (!entries.length) return;
    try { await invokeSaveUiPreferences(entries); }
    catch (error) {
      for (const [key, value] of entries) if (values.get(key) === value && !pending.has(key)) pending.set(key, value);
      throw error;
    }
  });
  return writes;
}
