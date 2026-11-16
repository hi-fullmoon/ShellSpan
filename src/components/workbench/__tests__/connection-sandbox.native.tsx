import { createRoot } from 'react-dom/client';
import { ConnectionFormDrawer } from '@/components/workbench/connection-form-drawer';
import { TooltipProvider } from '@/components/ui/tooltip';
import { invokeAddProfile, invokeDeleteProfilePassword, invokeGetProfileSandbox, invokeRemoveProfile, invokeSaveProfileSandbox, invokeStoreProfilePassword, isTauriRuntime } from '@/lib/ipc/tauri';
import { initI18n, t, type LocaleKey } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';

const workspace = '/srv/shellspan-workspaces/project';
const url = (suffix: string) => `/__sandbox-${suffix}/${new URLSearchParams(location.search).get('token')}`;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const found = read();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${description}`);
}

function button(key: LocaleKey, root: ParentNode = document) {
  return [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === t(key));
}

async function verify() {
  assert(isTauriRuntime(), 'Native IPC is required');
  const config: { port: number; available: boolean } = await fetch(url('config')).then((response) => response.json());
  const locale = config.available ? 'zh-CN' : 'en-US';
  await initI18n(locale);
  useAppStore.setState({ locale });
  const id = `remote-sandbox-ui-${crypto.randomUUID()}`;
  const profile = { id, name: 'Linux sandbox acceptance', host: '127.0.0.1', port: config.port,
    username: 'sandbox', authMethod: 'password' as const, createdAt: Date.now(), updatedAt: Date.now() };
  const root = createRoot(document.getElementById('root')!);
  let created = false;
  try {
    await invokeAddProfile(profile);
    created = true;
    await invokeStoreProfilePassword(id, 'shellspan-sandbox-e2e');
    const initial = await invokeGetProfileSandbox(id);
    await invokeSaveProfileSandbox(id, initial.binding, { workspace, mode: 'readOnly' });
    root.render(<TooltipProvider><ConnectionFormDrawer open initial={profile} onClose={() => {}} onSubmit={() => {}} onConnect={() => {}} /></TooltipProvider>);
    const trigger = await until(() => button('connection.sandbox.manage'), 'sandbox entry in connection settings');
    trigger.click();
    const dialog = await until(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((node) => node.textContent?.includes(t('connection.sandbox.mode'))), 'sandbox settings dialog');
    const select = dialog.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    assert(select?.textContent?.trim() === t('connection.sandbox.mode.readOnly'), 'Selected mode exposes its localized label');
    const test = await until(() => { const node = button('connection.sandbox.test', dialog); return node && !node.disabled ? node : undefined; }, 'enabled test control');
    test.click();
    const trust = await until(() => button('connection.preflight.trust', dialog), 'SSH trust confirmation');
    const fingerprint = dialog.textContent?.match(/SHA256:[\w+/]+/)?.[0];
    assert(fingerprint, 'SSH fingerprint displayed');
    trust.click();
    const expected = config.available ? 'connection.sandbox.report.passed' : 'connection.sandbox.report.missing';
    await until(() => dialog.textContent?.includes(t(expected)) ? true : undefined, expected);
    if (config.available) {
      assert(dialog.textContent?.includes(t('connection.sandbox.step.sandboxSftp')), 'SFTP step displayed');
    } else {
      assert(dialog.querySelector('code')?.textContent === 'apk add bubblewrap', 'Detected Alpine installation command');
      assert(button('connection.sandbox.copyInstall', dialog), 'Installation command can be copied');
    }
    const body = dialog.querySelector<HTMLElement>('[aria-busy]');
    const footer = button('common.save', dialog);
    assert(body && footer && body.scrollHeight > body.clientHeight, 'Preflight report scrolls inside the dialog');
    const bounds = dialog.getBoundingClientRect();
    const saveBounds = footer.getBoundingClientRect();
    assert(bounds.right <= innerWidth + 1 && bounds.left >= -1 && saveBounds.bottom <= innerHeight, 'Dialog and save button remain within the viewport');
    const input = dialog.querySelector<HTMLInputElement>('input[data-slot="input"]');
    assert(input?.value === workspace, 'Saved workspace loaded');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, `${workspace}-changed`);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => dialog.textContent?.includes(t(expected)) ? undefined : true, 'editing invalidates the previous report');
    footer.click();
    await until(() => !dialog.isConnected || dialog.hasAttribute('data-closed')
      || trigger.getAttribute('aria-expanded') === 'false' ? true : undefined, 'saved settings close');
    const saved = await invokeGetProfileSandbox(id);
    assert(saved.policy?.workspace === `${workspace}-changed` && saved.binding !== initial.binding, 'Rust persisted the new workspace and policy revision');
    return { ok: true, locale, width: innerWidth, height: innerHeight, result: config.available ? 'passed' : 'missing' };
  } finally {
    root.unmount();
    if (created) {
      await invokeDeleteProfilePassword(id);
      await invokeRemoveProfile(id);
    }
  }
}

void verify().catch((error: unknown) => ({ ok: false, error: String(error) }))
  .then((result) => fetch(url('result'), { method: 'POST', body: JSON.stringify(result) }));
