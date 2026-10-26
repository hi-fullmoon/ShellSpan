import { getCurrentWindow } from '@tauri-apps/api/window';

const parameters = new URLSearchParams(location.search);
const endpoint = `/__single-instance/${parameters.get('token')}/${parameters.get('role')}`;
const window = getCurrentWindow();

async function report(type: string, id?: string) {
  const [visible, minimized, focused] = await Promise.all([
    window.isVisible(), window.isMinimized(), window.isFocused(),
  ]);
  await fetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ type, id, visible, minimized, focused }),
  });
}

async function run() {
  await report('ready');
  for (;;) {
    const response = await fetch(endpoint);
    const command: { type: string; id: string } | null = await response.json();
    if (command) {
      if (command.type === 'hide') await window.hide();
      if (command.type === 'minimize') await window.minimize();
      await report('state', command.id);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

void run().catch(async (error: unknown) => {
  await fetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ type: 'error', error: String(error) }),
  });
});
