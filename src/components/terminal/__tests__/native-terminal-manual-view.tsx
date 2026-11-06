import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';

export function mountNativeManualView(container: HTMLElement, family: string, command: string) {
  const root = createRoot(container);
  // The production terminal registry imperatively attaches immediately after
  // this helper returns, so the React host must already be committed.
  flushSync(() => root.render(<main className="flex h-screen min-h-0 flex-col gap-3 p-3">
    <section className="shrink-0 space-y-2">
      <h1>Native terminal manual input · {family}</h1>
      <p>Type this command. Before Enter: Left, Backspace, reinsert D. Then record the actual output.</p>
      <code>{command}</code><div><Button id="manual-native-record" size="sm" variant="outline">Record manual input</Button></div>
    </section><div id="manual-native-terminal" className="min-h-0 flex-1" />
  </main>));
  const host = container.querySelector('#manual-native-terminal'), button = container.querySelector('#manual-native-record');
  if (!(host instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    root.unmount(); throw new Error('Actual manual controls were not mounted');
  }
  return { root, host, button };
}
