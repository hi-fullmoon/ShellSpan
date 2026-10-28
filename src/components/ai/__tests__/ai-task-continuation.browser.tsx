import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { AiTaskStrip } from '@/components/ai/workspace/ai-task-strip';
import { createAgentActivityProjector, projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { initI18n } from '@/locales';
import type { AgentSessionEvent } from '@/types/agent-session';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

export async function mountTaskContinuation(host: HTMLElement, events: readonly AgentSessionEvent[]) {
  await initI18n('zh-CN');
  host.className = 'ai-panel-shell';
  host.style.cssText = 'padding:16px;display:flex;flex-direction:column';
  const root = createRoot(host);
  const project = createAgentActivityProjector();
  return (index: number) => {
    const prefix = events.slice(0, index + 1);
    const activity = project(prefix);
    const replayed = projectAgentActivity(prefix);
    if (JSON.stringify(activity) !== JSON.stringify(replayed)) throw new Error('Live and replay projections differ');
    flushSync(() => root.render(<AiTaskStrip steps={activity.plan?.steps ?? []} active={activity.planActive} />));
    return { plan: activity.plan, active: activity.planActive,
      recordedPlans: prefix.filter(event => event.type === 'task/plan').length,
      historyPlans: activity.nodes.filter(node => node.kind === 'task').length };
  };
}
