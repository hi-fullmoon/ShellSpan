import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AiWorkspaceController } from '@/components/ai/workspace/ai-workspace-controller';
import { initI18n } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';

const transport = vi.hoisted(() => ({ config: (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.SHELLSPAN_SKILLS_BRIDGE, listeners: new Set<(event: { payload: unknown }) => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: unknown) => {
  const { url } = JSON.parse(transport.config!);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, args }) });
  const result = await response.json();
  if (command === 'agent_runtime_followup') for (const event of result.events) for (const listener of transport.listeners) listener({ payload: event });
  return result.value;
} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (_name: string, listener: (event: { payload: unknown }) => void) => { transport.listeners.add(listener); return () => transport.listeners.delete(listener); } }));

interface BridgeState { requests: { messages: unknown }[]; sessions: { snapshot: AgentSessionSnapshot; events: AgentSessionEvent[] }[] }
// Ordinary unit runs deliberately skip this process integration; the stage gate starts
// the Rust transport and requires both the frontend and Rust sides to pass.
describe.runIf(Boolean(transport.config))('controller to production Runtime and HTTP provider', () => {
  it('freezes an explicit root before listing, then preserves menu and manual slash submissions through durable claims and wire messages', async () => {
    const bridge = JSON.parse(transport.config!);
    const state = async (): Promise<BridgeState> => (await (await fetch(bridge.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: '__state', args: {} }) })).json()).value;
    useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US');
    useAgentPermissionStore.getState().resetAll();
    useAiSettingsStore.setState({ agentEnabled: true, defaultProviderId: 'bridge', providers: [{ id: 'bridge', preset: 'custom', name: 'Test HTTP receiver', kind: 'openAiCompatible', baseUrl: bridge.modelUrl, model: 'test-model', requiresApiKey: false }] });
    for (const mode of ['menu', 'manual']) {
      useTerminalStore.setState({ activeSessionId: `local-${mode}`, sessions: [{ sessionId: `local-${mode}`, title: 'Local fixture', host: 'local', port: 0, username: 'fixture', status: 'connected' }] });
      const user = userEvent.setup(); render(<AiWorkspaceController scope="terminal" />);
      await user.click(screen.getByRole('button', { name: 'Skills' }));
      expect(screen.getByText('Local fixture (local)')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Load skills' })).toBeDisabled();
      const prior = await state(); expect(prior.requests).toHaveLength(mode === 'menu' ? 0 : 1);
      await user.type(screen.getByRole('textbox', { name: 'Project directory' }), bridge.root);
      await user.click(screen.getByRole('button', { name: 'Load skills' }));
      await screen.findByText('User only');
      expect((await state()).requests).toHaveLength(prior.requests.length);
      if (mode === 'menu') await user.click(screen.getByRole('menuitem', { name: /inspect/ }));
      else { await user.keyboard('{Escape}'); await user.type(screen.getByRole('textbox'), '  please /inspect  '); }
      const content = mode === 'menu' ? '/inspect ' : '  please /inspect  ';
      expect(screen.getByRole('textbox')).toHaveValue(content);
      await user.click(screen.getByRole('textbox')); await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByText('Controller wire complete')).toBeVisible(), { timeout: 10000 });
      const captured = await state(); const session = captured.sessions[captured.sessions.length - 1]!;
      expect(session.snapshot.header.target?.cwd).toBe(bridge.root);
      for (const operation of ['enqueued', 'claimed']) expect(session.events.some((event) => event.type === 'agent/inbox/spliced' && event.data.operation === operation && event.data.messages.some((message) => message.content === content && message.clientSubmissionId))).toBe(true);
      const prepared = session.events.find((event) => event.type === 'skill/step_prepared');
      expect(prepared?.type === 'skill/step_prepared' && prepared.data.prepared.outcomes[0].loaded?.instructions).toBe('ENTIRE CONTROLLER INSTRUCTION\nFinal line from the real file.\n');
      expect(JSON.stringify(captured.requests[captured.requests.length - 1]?.messages)).toContain('ENTIRE CONTROLLER INSTRUCTION');
      expect(JSON.stringify(captured.requests[captured.requests.length - 1]?.messages)).toContain('skill_provenance');
      cleanup();
    }
  }, 30000);
});
