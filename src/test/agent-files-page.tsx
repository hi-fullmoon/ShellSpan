import { createRoot } from 'react-dom/client';
import { emit } from '@tauri-apps/api/event';
import { mockIPC } from '@tauri-apps/api/mocks';
import '@/components/ai/ai-panel.css';
import { AiWorkspaceController } from '@/components/ai/workspace/ai-workspace-controller';
import { initI18n } from '@/locales';
import { applyTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore } from '@/stores/terminalStore';

export async function mountFilesPage(root: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const rpc = params.get('rpc')!;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc)) throw new Error('test-only loopback bridge required');
  mockIPC(async (command, args) => {
    if (command.startsWith('plugin:event|')) return 1;
    if (command.startsWith('plugin:log|')) return;
    const result = await (await fetch(rpc, { method: 'POST', body: JSON.stringify({ command, args }) })).json();
    if (result.error) throw new Error(result.error);
    for (const event of result.events ?? []) await emit('agent-runtime-session-event', event);
    return result.value;
  }, { shouldMockEvents: true });
  const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  useAppStore.setState({ locale, theme }); await initI18n(locale); applyTheme(theme);
  useAiSettingsStore.setState({ defaultProviderId: 'image-bridge', providers: [{ id: 'image-bridge', preset: 'qwen', profile: 'qwen', name: 'Vision test', kind: 'openAiCompatible', model: 'qwen3-vl-plus', baseUrl: params.get('modelUrl')!, requiresApiKey: false }] });
  const target = params.get('target') ?? 'images-menu';
  useTerminalStore.setState({ activeSessionId: target, sessions: [{ sessionId: target, title: 'Image fixture', host: 'local', port: 0, username: 'fixture', status: 'connected' }] });
  Object.assign(window, { imageTestChangeProvider: (model: string) => useAiSettingsStore.setState(s => ({ providers: s.providers.map(p => ({ ...p, model })) })) });
  document.body.style.margin = '0'; document.body.style.overflow = 'hidden';
  createRoot(root).render(<main className="ai-panel-shell" data-ai-scope="terminal" data-stage6d-ready style={{ width: '100vw', height: '100vh' }}><AiWorkspaceController scope="terminal" /></main>);
}
