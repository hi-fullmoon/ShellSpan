import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AiSandboxSettings } from '../workspace/ai-sandbox-settings';
import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';
import { initI18n, t } from '@/locales';
import { sandboxGapLabels } from '@/lib/ai/sandbox-presentation';
import en from '@/locales/en-US';
import zh from '@/locales/zh-CN';
import { useAppStore } from '@/stores/appStore';
import type { AgentSandboxPolicy } from '@/types/agent-session';

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

function NewPolicy() {
  const [policy, setPolicy] = useState<AgentSandboxPolicy>('workspace');
  return <AiSandboxSettings policy={policy} existing={false} surface="boundTerminal" onPolicyChange={setPolicy} />;
}

it('shows unavailable workspace intent, terminal conflict, and explicit host choice with readable labels', async () => {
  const user = userEvent.setup();
  render(<NewPolicy />);
  const trigger = screen.getByRole('button', { name: 'Session settings' });
  expect(trigger).toHaveClass('size-7', '[&_svg]:size-4');
  expect(trigger.querySelector('svg')).toHaveClass('lucide-settings-2');
  expect(trigger).not.toHaveAttribute('title');
  await user.click(trigger);
  expect(screen.getByText(/lacks the required sandbox capabilities/)).toBeVisible();
  expect(screen.getByText(/Restricted execution cannot use an ordinary visible terminal/)).toBeVisible();
  const select = screen.getByRole('combobox');
  expect(select).toHaveTextContent('Workspace execution');
  select.focus();
  await user.keyboard('{ArrowDown}');
  expect(await screen.findByRole('option', { name: 'Read-only inspection' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('option', { name: 'Workspace execution' })).toHaveAttribute('aria-disabled', 'true');
  await user.click(screen.getByRole('option', { name: 'Host operations' }));
  expect(screen.getByRole('combobox')).toHaveTextContent('Host operations');
  expect(screen.getByText(/File and network isolation are not enabled/)).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Session settings' })).toHaveFocus());
});

it('keeps historical missing policy unchanged and exposes its frozen host and project', async () => {
  const user = userEvent.setup();
  render(<AiSandboxSettings existing surface="direct" target={{ kind: 'remote', targetId: 'target', sessionId: 'terminal', host: 'host.example', port: 22, username: 'operator', rootPath: '/srv/project' }} onPolicyChange={() => { throw new Error('Existing policy must not change'); }} />);
  await user.click(screen.getByRole('button', { name: 'Session settings' }));
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByText('operator@host.example:22')).toBeVisible();
  expect(screen.getByText('/srv/project')).toBeVisible();
  expect(screen.getByText('Unconfirmed')).toBeVisible();
  expect(screen.getByText(/retains its recorded policy/)).toBeVisible();
});

it('has identical bilingual keys', () => { expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort()); });

it('offers an explicit session-policy recovery path without pretending damaged defaults were saved', async () => {
  let selected: AgentSandboxPolicy | undefined;
  render(<AiSandboxSettings policy="host" existing={false} surface="boundTerminal" defaultsReady={false}
    onPolicyChange={policy => { selected = policy; }} onRememberDefault={async () => { throw new Error('Storage unavailable'); }} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', {name:'Session settings'}));
  expect(screen.getByRole('button', {name:'Remember defaults'})).toBeDisabled();
  expect(screen.getByText(/explicitly use the currently selected policy/)).toBeVisible();
  await user.click(screen.getByRole('button', {name:'Use selected policy for this session'}));
  expect(selected).toBe('host');
});

it.each(['zh-CN', 'en-US'] as const)('translates the current native capability gaps in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const gap = 'Native Direct shell, process controls, project-file reads, public TCP proxies and Node loopback service relays are available; other tools and runtimes are unsupported';
  expect(sandboxGapLabels[gap]).toBe('agent.sandbox.toolsGap');
  render(<AiSandboxSettings existing surface="direct" policy="workspace" target={{kind:'local',targetId:'local',sessionId:'terminal'}}
    capability={{status:'partial',files:true,network:true,processLifecycle:false,gaps:[gap]}} onPolicyChange={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: t('agent.sandbox.settings') }));
  await user.click(screen.getByText(t('agent.sandbox.details')));
  expect(screen.getByText(t('agent.sandbox.toolsGap'))).toBeVisible();
  expect(screen.queryByText(gap)).toBeNull();
  expect(screen.queryByText(t('agent.sandbox.legacyNetworkToolsGap'))).toBeNull();
});

it.each(['zh-CN', 'en-US'] as const)('translates current cache capability and never infers authorization after a failed status request in %s', async locale => {
  useAppStore.setState({locale}); await initI18n(locale);
  const gap = 'Native Direct shell, process controls, project-file reads, cache-directory read/write grants, public TCP proxies and Node loopback service relays are available; other tools and runtimes are unsupported';
  expect(sandboxGapLabels[gap]).toBe('agent.sandbox.cacheToolsGap');
  render(<AiSandboxSettings existing sessionId="status-transport-unavailable" surface="direct" policy="workspace" target={{kind:'local',targetId:'local',sessionId:'terminal'}} capability={{status:'partial',files:true,network:true,processLifecycle:false,gaps:[gap]}} onPolicyChange={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', {name:t('agent.sandbox.settings')}));
  expect(await screen.findByText(t('agent.sandbox.authorizationUnknown'))).toBeVisible();
  expect(screen.queryByText(t('agent.sandbox.authorization.active'))).toBeNull();
  await user.click(screen.getByText(t('agent.sandbox.details')));
  expect(screen.getByText(t('agent.sandbox.cacheToolsGap'))).toBeVisible();
  expect(screen.getByText(t('agent.sandbox.processLimited'))).toBeVisible();
});

it('keeps the ordinary terminal option disabled for restricted Direct and allows Direct selection', async () => {
  const user = userEvent.setup();
  render(<AgentExecutionSurfaceSelector surface="boundTerminal" realTerminalState="ready" boundTerminalDisabled />);
  const trigger = screen.getByRole('button', { name: /Execution method/ });
  expect(trigger).not.toHaveAttribute('title');
  await user.click(trigger);
  expect((await screen.findByRole('menu')).querySelector('[data-slot="dropdown-menu-label"]')).toHaveTextContent('Execution method');
  expect(await screen.findByRole('menuitemradio', { name: 'Visible command' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('menuitemradio', { name: 'Direct' })).not.toHaveAttribute('aria-disabled');
});
