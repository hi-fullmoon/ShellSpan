import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { InfoIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../alert';
import { Button } from '../button';
import { Toaster } from '../sonner';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { AiErrorNotice } from '@/components/ai/workspace/ai-error-notice';
import { AiConversationNodeList } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import type { AgentSessionEvent } from '@/types/agent-session';
import { FocusNoTarget } from '@/components/focus/focus-no-target';
import { initI18n, t } from '@/locales';
import { applyTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

const root = createRoot(document.getElementById('root')!);
const transcriptNotices = [...projectAgentChatNodes(capture as AgentSessionEvent[]), ...taskTokenBudgetView().nodes]
  .flatMap<AiConversationNode>(node => node.kind === 'turnProcess' ? node.children : [node])
  .filter(node => node.kind === 'approvalMarker' || node.kind === 'retry' || node.kind === 'error');

function AvailabilityWorkspace({ action, message }: { action: boolean; message: string }) {
  const [reconnectRequested, setReconnectRequested] = useState(false);
  return <AiWorkspaceRoot scope="terminal" mode="agent" view={null}
    agentUnavailableReason={message} onReconnectTerminal={action && !reconnectRequested
      ? () => { setReconnectRequested(true); } : undefined} />;
}

export async function show(locale: Locale, theme: 'light' | 'dark') {
  useAppStore.setState({ locale });
  await initI18n(locale);
  applyTheme(theme);
  const message = t('agent.availability.needsTerminal');
  flushSync(() => root.render(<main className="ai-panel-shell flex min-w-0 flex-col gap-3 p-4">
    <section data-cases="notices" className="flex min-w-0 flex-col gap-3">
      <FocusNoTarget />
      <AiErrorNotice title={t('ai.requestFailed')} action={<Button size="xs" variant="ghost"
        onClick={() => { document.body.dataset.noticeAction = 'dismiss'; }}>{t('common.close')}</Button>}>
        {message}
      </AiErrorNotice>
      {[false, true].map(action => <section key={String(action)} data-case={`availability-${action}`}
        className="flex h-[400px] min-w-0 flex-col">
        <AvailabilityWorkspace key={`${locale}-${theme}`} action={action} message={message} />
      </section>)}
    </section>
    <section data-cases="variants" className="flex min-w-0 flex-col gap-3">
      {(['info', 'default', 'subtle', 'warning', 'destructive', 'destructiveSubtle'] as const).flatMap(variant =>
        (['default', 'sm', 'xs'] as const).flatMap(size => [false, true].map(titled =>
          <Alert key={`${variant}-${size}-${titled}`} variant={variant} size={size}>
            <InfoIcon />
            {titled && <AlertTitle>{t('agent.availability.title')}</AlertTitle>}
            <AlertDescription>{message}</AlertDescription>
          </Alert>)))}
    </section>
    <section data-cases="transcript" className="flex min-w-0 flex-col gap-3">
      <AiConversationNodeList nodes={transcriptNotices} />
    </section>
    <Toaster />
  </main>));
  await document.fonts.ready;
}

export function showToast(variant: 'success' | 'error') {
  return useToastStore.getState().addToast(t('agent.availability.needsTerminal'), variant, Infinity);
}
