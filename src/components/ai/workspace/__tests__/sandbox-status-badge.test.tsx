import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAppStore } from '@/stores/appStore';
import { AiConversation } from '../ai-conversation';
import { AiSessionHeader } from '../ai-session-header';
import { SandboxStatusBadge } from '../sandbox-status-badge';

const initialAiSettings = useAiSettingsStore.getState();

describe('SandboxStatusBadge', () => {
  afterEach(() => {
    useAiSettingsStore.setState(initialAiSettings, true);
  });

  it('renders nothing for unsandboxed sessions', () => {
    const { container } = render(
      <SandboxStatusBadge
        target={{
          kind: 'local',
          targetId: 'local-1',
          sessionId: 'term-1',
          cwd: '/Users/demo/repo',
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows macOS sandbox posture details when opened', async () => {
    const user = userEvent.setup();
    render(
      <SandboxStatusBadge
        target={{
          kind: 'local',
          targetId: 'local-1',
          sessionId: 'term-1',
          cwd: '/Users/demo/.shellspan/sandboxes/0123456789abcdef0123456789abcdef/workspace',
          localSandboxRequired: 'macNono',
        }}
      />,
    );

    const trigger = screen.getByRole('button', { name: /macOS nono/i });
    await user.click(trigger);

    expect(await screen.findByText('macOS nono')).toBeInTheDocument();
    expect(
      screen.getByText('/Users/demo/.shellspan/sandboxes/0123456789abcdef0123456789abcdef/workspace'),
    ).toBeInTheDocument();
  });

  it('shows remote sandbox posture for sandboxed SSH sessions', async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    const user = userEvent.setup();
    render(
      <SandboxStatusBadge
        remoteSandboxMode="clientReadOnly"
        target={{
          kind: 'remote',
          targetId: 'remote-1',
          sessionId: 'term-2',
          rootPath: '/etc/nginx',
          remoteSandboxRequired: true,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /SSH Read-only \(L1\)/i }));
    expect(await screen.findByText('SSH Read-only (L1)')).toBeInTheDocument();
    expect(screen.getByText('Client read-only guard (no remote shell)')).toBeInTheDocument();
    expect(screen.getByText('/etc/nginx')).toBeInTheDocument();
  });

  it('reflects active macOS sandbox proxy network policy in the popover', async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    useAiSettingsStore.setState({
      agentSandboxNetworkMode: 'customAllowlist',
      agentSandboxNetworkAllowlist: ['registry.npmmirror.com', '*.corp.internal'],
    });
    const user = userEvent.setup();
    render(
      <SandboxStatusBadge
        target={{
          kind: 'local',
          targetId: 'local-1',
          sessionId: 'term-1',
          cwd: '/Users/demo/.shellspan/sandboxes/0123456789abcdef0123456789abcdef/workspace',
          localSandboxRequired: 'macNono',
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /macOS nono/i }));
    expect(await screen.findByText('Filtered proxy · 2 custom domain(s)')).toBeInTheDocument();
  });

  it('renders blocked domains and allows adding a blocked domain from the tool violation banner', async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    const allowDomain = vi.fn().mockResolvedValue(undefined);
    useAiSettingsStore.setState({
      agentSandboxNetworkMode: 'devRegistries',
      agentSandboxNetworkAllowlist: [],
      allowSandboxDomain: allowDomain,
    });
    const user = userEvent.setup();
    const nodes: AiConversationNode[] = [
      {
        kind: 'tool',
        key: 'tool:cmd-1',
        sourceKind: 'agent',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        stepId: 'step-1',
        firstSeq: 1,
        lastSeq: 2,
        timestamp: '2026-11-23T12:00:00.000Z',
        callId: 'cmd-1',
        name: 'exec_command',
        nativeName: 'exec_command',
        title: null,
        summary: '',
        state: 'succeeded',
        effect: 'stateChange',
        durationMs: 200,
        detailRef: { kind: 'agentTool', sessionId: 'sess-1', callId: 'cmd-1' },
        evidenceRefs: [],
        input: { command: 'curl https://registry.npmmirror.com/' },
        output: {
          output: 'curl: (56) Received HTTP code 403 from proxy',
          exitCode: 56,
          sandboxViolation: {
            category: 'networkBlocked',
            blockedDomains: ['registry.npmmirror.com'],
            hint: 'Blocked by sandbox proxy.',
          },
        },
        error: null,
        target: null,
        idempotency: 'no',
        approval: null,
      },
    ];

    render(<AiConversation nodes={nodes} status="idle" throughSeq={2} />);

    await user.click(screen.getByRole('button', { name: /Command/i }));
    expect(await screen.findByText('Blocked domains: registry.npmmirror.com')).toBeInTheDocument();
    const allowButton = screen.getByRole('button', { name: 'Allow registry.npmmirror.com' });
    await user.click(allowButton);

    await waitFor(() => expect(allowDomain).toHaveBeenCalledWith('registry.npmmirror.com'));
  });

  it('renders cleanly inside AiSessionHeader alongside the session title', async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    const { container } = render(
      <AiSessionHeader
        title="Investigate nginx reload"
        context="/Users/demo/repo"
        status="idle"
        sandboxBadge={(
          <SandboxStatusBadge
            target={{
              kind: 'local',
              targetId: 'local-1',
              sessionId: 'term-1',
              cwd: '/Users/demo/.shellspan/sandboxes/0123456789abcdef0123456789abcdef/workspace',
              localSandboxRequired: 'macNono',
            }}
          />
        )}
      />,
    );

    const header = container.querySelector('[data-slot="ai-workspace-header"]');
    expect(header).toBeInTheDocument();
    expect(header?.querySelector('[data-slot="ai-sandbox-status-trigger"]')).toBeInTheDocument();
    expect(screen.getByText('Sandbox')).toBeInTheDocument();
  });
});
