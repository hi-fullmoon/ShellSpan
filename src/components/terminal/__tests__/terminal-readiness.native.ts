import { terminalRegistry } from '../registry/terminal-registry';
import { invokeCreateLocalSession, invokeCloseSession } from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const originalRegistry = terminalRegistry;
let updatedRegistry: typeof terminalRegistry | undefined;
import.meta.hot?.accept('../registry/terminal-registry', (module) => {
  updatedRegistry = module?.terminalRegistry;
});

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const token = new URL(location.href).searchParams.get('token');
async function verify(): Promise<void> {
  await initI18n('zh-CN');
  const ids: string[] = [];
  const hosts: HTMLElement[] = [];
  try {
    const create = async (registry: typeof terminalRegistry) => {
      const session = await invokeCreateLocalSession(100, 25);
      ids.push(session.sessionId);
      const controller = registry.create(session.sessionId, () => {}, () => {}, () => 'connected', () => {});
      const host = document.createElement('div');
      host.style.cssText = 'width:800px;height:300px';
      document.body.append(host);
      hosts.push(host);
      controller.attach(host);
      await controller.whenOutputReady();
      return controller;
    };
    const first = await create(originalRegistry);
    const response = await fetch(`/__terminal-registry-reload/${token}`, { method: 'POST' });
    assert(response.ok, 'Failed to request registry hot update');
    await eventually(() => updatedRegistry !== undefined, 'Registry hot update was not delivered');
    assert(updatedRegistry === originalRegistry, 'Hot update replaced the registry retained by Agent callbacks');
    assert(updatedRegistry.get(first.sessionId) === first, 'Hot update lost the connected terminal controller');
    const second = await create(updatedRegistry);
    assert(originalRegistry.get(second.sessionId) === second, 'Agent callback cannot find a terminal created after hot update');
    for (const controller of [first, second]) {
      const marker = `shellspan-readiness-${crypto.randomUUID()}`;
      let output = '';
      const unsubscribe = controller.subscribeOutput(chunk => { output += chunk; });
      try {
        // The echoed command does not contain the complete marker.
        const split = Math.floor(marker.length / 2);
        await controller.writeInput(`printf '%s%s\\n' '${marker.slice(0, split)}' '${marker.slice(split)}'\r`);
        await eventually(() => output.includes(marker), 'Real PTY output did not reach the registered controller');
      } finally { unsubscribe(); }
    }
  } finally {
    for (const id of ids) {
      try { await invokeCloseSession(id); }
      finally { originalRegistry.dispose(id); updatedRegistry?.dispose(id); }
    }
    for (const host of hosts) host.remove();
  }
}

void verify().then(() => ({ ok: true }), (error: unknown) => ({
  ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
})).then(result => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(result) }));
