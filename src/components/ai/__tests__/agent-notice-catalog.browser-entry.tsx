import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';
import { AiTerminalRecoveryNotice } from '../workspace/ai-terminal-recovery-notice';
import { AiQueueNotice } from '../workspace/ai-queue-notice';
import { AiApprovalPanel } from '../workspace/ai-approval-panel';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import { AiConversation } from '../workspace/ai-conversation';
import { AiTrashRecoveryNotice } from '../workspace/ai-tool-presentation';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { AiComposerEditor } from '../workspace/ai-composer-editor';
import { useFileCompletion } from '../workspace/use-file-completion';
import { AiCompletionPopover } from '../workspace/ai-completion-popover';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { FocusNoTarget } from '@/components/focus/focus-no-target';
import { initI18n, t } from '@/locales';
import { applyTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { terminalExecutionRecovery } from '@/lib/ai/terminal-execution-recovery';
import { terminalRecoveryView } from '@/test/fixtures/terminal-execution-recovery';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { FileReferenceList } from '@/types/agent-file-reference';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { Locale } from '@/types';
import '@/styles/base.css';
import '../styles/styles.css';

const root = createRoot(document.getElementById('root')!);
const budget = taskTokenBudgetView();
const recorded = projectAgentChatNodes(capture as AgentSessionEvent[]);
const flatten = (nodes: readonly AiConversationNode[]) => nodes.flatMap<AiConversationNode>(node => node.kind === 'turnProcess' ? node.children : [node]);
const children = flatten(recorded);
const error = budget.error;
if (!error) throw new Error('The native token-budget recording must include a real failure');
function approvalFrom(nodes: readonly AiConversationNode[], risk: string, callId?: string): AiPendingApproval | null {
  const marker = nodes.find(node => node.kind === 'approvalMarker' && (callId ? node.callId === callId : node.risk === risk));
  if (marker?.kind !== 'approvalMarker' || !marker.turnId || !marker.stepId) return null;
  const tool = nodes.find(node => node.kind === 'tool' && node.callId === marker.callId);
  if (tool?.kind !== 'tool') return null;
  return { sessionId: marker.sessionId, turnId: marker.turnId, stepId: marker.stepId,
    requestId: marker.requestId, callId: marker.callId, approvalId: marker.approvalId,
    risk: marker.risk, prompt: marker.prompt, reason: marker.reason, expiresAtUnixMs: marker.expiresAtUnixMs,
    toolName: tool.name, target: tool.target, arguments: tool.input, effect: tool.effect, evidenceRefs: tool.evidenceRefs };
}
const approval = approvalFrom(children, 'readOnly');
if (!approval) throw new Error('The native recording must include a read-only approval');
const trace: Record<string, AiConversationNode> = {};
const approvals: Record<string, AiPendingApproval> = { readOnly: approval };

async function readProjectFiles(query: string, signal: AbortSignal): Promise<FileReferenceList> {
  return (await fetch(`/project-entries?q=${encodeURIComponent(query)}`, { signal })).json();
}

function FileReferencePanelPreview() {
  const [value, setValue] = useState('');
  const anchor = useRef<HTMLDivElement>(null);
  const completion = useFileCompletion({ text: value, update: setValue, query: readProjectFiles, disabled: false });
  return <div ref={anchor} className="mt-auto flex min-w-0 flex-col gap-3">
    <AiComposerEditor {...completion.editorProps} value={value} onChange={setValue} placeholder="" commandNames={[]} />
    <AiCompletionPopover anchor={anchor} onDismiss={completion.dismiss}>{completion.panel}</AiCompletionPopover>
  </div>;
}

export interface NoticeCase {
  id: string;
  label: string;
  group: 'availability' | 'recovery' | 'errors' | 'approval' | 'transcript';
  source: string;
  selector: string;
  kind?: 'row' | 'panel' | 'disclosure';
}
const workspaceSelector = '[data-slot="ai-workspace-status-notices"] [data-slot="alert"]';
const workspaceSource = 'src/components/ai/workspace/ai-workspace-root.tsx';
export const cases: NoticeCase[] = [
  ...[
    ['terminal', '未连接终端 · 带重连按钮'],
    ['terminal-plain', '未连接终端 · 纯提示'],
    ['model', '模型配置不可用 · 打开设置'],
    ['conflict', '终端被其他任务占用'],
    ['reconnect', '重新连接后验证并继续'],
    ['reconnect-busy', '正在验证连接'],
    ['history', '历史会话 · 续接说明'],
    ['history-busy', '历史会话 · 准备续接'],
    ['history-error', '历史会话 · 续接失败'],
    ['budget', '任务预算检查点已保存'],
    ['waitingApproval', '等待审批记录同步'],
    ['waitingQuestion', '等待问题记录同步'],
  ].map(([id, label]) => ({ id, label, group: 'availability' as const, source: workspaceSource, selector: workspaceSelector })),
  { id: 'focus', label: 'Focus · 未选择终端', group: 'availability', source: 'src/components/focus/focus-no-target.tsx', selector: '[data-slot="focus-start-notice"]' },
  { id: 'supplement', label: '子 Agent · 补充输入不可用', group: 'availability', source: 'src/components/ai/workspace/ai-composer-seat.tsx', selector: '[role="status"][data-slot="alert"]' },
  ...['waiting', 'stopping', 'stopped', 'reconnecting'].map((stage, index) => ({
    id: `recovery-${stage}`, label: ['终端恢复 · 先停止任务', '终端恢复 · 正在停止', '终端恢复 · 可重新连接', '终端恢复 · 正在连接'][index],
    group: 'recovery' as const, source: 'src/components/ai/workspace/ai-terminal-recovery-notice.tsx', selector: '[data-terminal-recovery-notice]',
  })),
  ...[
    ['operation-error', '操作失败 · 可关闭'], ['draft-error', '失败草稿 · 可重试'],
    ['sync-error', '消息同步中断'], ['sync-persistent', '消息同步持续失败'], ['sync-retrying', '正在重试消息同步'],
  ].map(([id, label]) => ({ id, label, group: 'errors' as const, source: 'src/components/ai/workspace/ai-workspace-error-notices.tsx', selector: '[data-ai-error-notice]' })),
  ...[
    ['queue-conflict', '队列内容发生版本冲突'], ['queue-error', '队列操作失败'],
  ].map(([id, label]) => ({ id, label, group: 'errors' as const, source: 'src/components/ai/workspace/ai-queue-notice.tsx', selector: '[data-slot="alert"]' })),
  { id: 'permission', label: '已启用完全访问权限', group: 'approval', source: 'src/components/ai/agent-permission-selector.tsx', selector: '[data-slot="alert"]' },
  { id: 'approval-readOnly', label: '审批 · 操作影响说明', group: 'approval', source: 'src/components/ai/workspace/ai-approval-panel.tsx', selector: '[role="note"]' },
  { id: 'approval-panel', label: '审批面板 · 图标与标题', group: 'approval', source: 'src/components/ai/workspace/ai-approval-panel.tsx', selector: '[data-slot="ai-approval-panel"]', kind: 'panel' },
  { id: 'approval-error', label: '审批操作失败', group: 'approval', source: 'src/components/ai/workspace/ai-approval-panel.tsx', selector: '[data-ai-error-notice]' },
  { id: 'trash-success', label: '文件已移入系统回收站', group: 'approval', source: 'src/components/ai/workspace/ai-tool-presentation.tsx', selector: '[data-slot="alert"]' },
  { id: 'file-reference', label: '引用文件 · 操作说明', group: 'availability', source: 'src/components/ai/workspace/use-file-completion.tsx', selector: '[data-file-completion] p:has(>svg)' },
  { id: 'transcript-approval', label: '对话记录 · 审批结果', group: 'transcript', source: 'src/components/ai/workspace/ai-conversation-node-seat.tsx', selector: '.ai-transcript-notice' },
  { id: 'transcript-error', label: '对话记录 · 请求失败', group: 'transcript', source: 'src/components/ai/workspace/ai-conversation-node-seat.tsx', selector: '.ai-turn-error' },
  { id: 'processing', label: '对话状态 · 处理中', group: 'transcript', source: 'src/components/ai/workspace/ai-conversation.tsx', selector: '[data-ai-running-indicator]' },
  { id: 'thinking', label: '对话状态 · 思考中', group: 'transcript', source: 'src/components/ai/workspace/ai-conversation.tsx', selector: '[data-ai-thinking-indicator]' },
  { id: 'process', label: '对话记录 · 本轮处理完成', group: 'transcript', source: 'src/components/ai/workspace/ai-conversation-node-seat.tsx', selector: '.ai-turn-process-trigger', kind: 'disclosure' },
];

export async function loadRecordedNotices() {
  const sessions: AgentSessionEvent[][] = await (await fetch('/recorded-notices')).json();
  const nodes = sessions.flatMap(events => flatten(projectAgentChatNodes(events)));
  for (const node of nodes) {
    const id = node.kind === 'retry' ? 'transcript-retry'
      : node.kind === 'error' && node.state === 'cancelled' ? 'transcript-stopped'
      : null;
    if (!id || trace[id]) continue;
    trace[id] = node;
    cases.push({ id, label: id === 'transcript-retry' ? '对话记录 · 自动重试' : '对话记录 · 已停止',
      group: 'transcript', source: 'src/components/ai/workspace/ai-conversation-node-seat.tsx', selector: '.ai-transcript-notice' });
  }
  for (const risk of ['destructive', 'sensitiveRead', 'stateChange', 'externalSideEffect'] as const) {
    const recordedApproval = approvalFrom(nodes, risk);
    if (!recordedApproval) continue;
    approvals[risk] = recordedApproval;
    cases.push({ id: `approval-${risk}`, label: `审批 · ${risk === 'destructive' ? '删除或覆盖风险' : risk === 'sensitiveRead' ? '敏感读取风险' : risk === 'externalSideEffect' ? '外部系统影响' : '写入操作风险'}`,
      group: 'approval', source: 'src/components/ai/workspace/ai-approval-panel.tsx', selector: '[role="note"]' });
  }
  const privateInput = nodes.find(node => node.kind === 'tool' && node.name === 'write_terminal_input'
    && typeof node.input === 'object' && node.input !== null && 'contentPersisted' in node.input && node.input.contentPersisted === false);
  if (privateInput?.kind === 'tool') {
    const privateApproval = approvalFrom(nodes, '', privateInput.callId);
    if (privateApproval) {
      approvals.loading = privateApproval;
      approvals.unavailable = privateApproval;
      for (const [id, label] of [['loading', '审批 · 加载私密参数'], ['unavailable', '审批 · 私密参数不可用']]) {
        cases.push({ id: `approval-${id}`, label, group: 'approval', source: 'src/components/ai/workspace/ai-approval-panel.tsx',
          selector: id === 'loading' ? '[role="status"]' : '[data-ai-error-notice]' });
      }
    }
  }
  return cases;
}

function renderCase(id: string): ReactNode {
  const record = () => { document.body.dataset.catalogAction = id; };
  const workspace = (props: Partial<ComponentProps<typeof AiWorkspaceRoot>>) => <AiWorkspaceRoot scope="terminal" mode="agent" view={null} {...props} />;
  if (id === 'focus') return <FocusNoTarget />;
  if (id === 'supplement') return <AiComposerSeat phase="active" status="idle" inputMode="supplement" currentSessionId={budget.summary.id}
    unavailableReason={t('agent.availability.needsTerminal')} />;
  if (id === 'file-reference') return <FileReferencePanelPreview />;
  if (id === 'trash-success') return <AiTrashRecoveryNotice />;
  if (id.startsWith('recovery-')) {
    const stage = id.slice(9);
    const recovery = terminalExecutionRecovery(terminalRecoveryView(stage === 'stopped' || stage === 'reconnecting' ? 'idle' : 'waiting'));
    if (!recovery) throw new Error('Recorded terminal recovery must be recognized');
    return <AiTerminalRecoveryNotice recovery={recovery} stopping={stage === 'stopping'} reconnecting={stage === 'reconnecting'} onStop={record} onReconnect={record} />;
  }
  if (id.startsWith('sync-')) return <AiWorkspaceErrorNotices syncError={error!}
    syncRecovery={{ attempts: id === 'sync-persistent' ? 3 : 1, retrying: id === 'sync-retrying' }} onRetrySync={async () => record()} />;
  if (id === 'operation-error' || id === 'draft-error') return <AiWorkspaceErrorNotices
    composerState={createAiComposerState({ phase: 'error', lastError: id === 'operation-error' ? error : null,
      failedDrafts: id === 'draft-error' ? [{ id: budget.summary.id, content: budget.snapshot.value.header.goal, mode: 'nextTurn', error: error! }] : [] })}
    onDismissError={record} onRetryFailedDraft={record} />;
  if (id.startsWith('queue-')) return <AiQueueNotice conflict={id === 'queue-conflict'} error={id === 'queue-error' ? error!.message : null} />;
  if (id === 'permission') return <AgentPermissionSelector sessionId={approval!.sessionId} mode="fullAccess" disabled />;
  if (id.startsWith('approval-')) return <AiApprovalPanel approval={approvals[id.slice(9)] ?? approval!}
    decision={null} argumentsLoading={id === 'approval-loading'} error={id === 'approval-error' ? error!.message : null} onApprove={record} onReject={record} onOpenDetails={record} />;
  if (id === 'transcript-approval') return <AiConversationNodeList nodes={children.filter(node => node.kind === 'approvalMarker').slice(0, 1)} />;
  if (id === 'transcript-error') return <AiConversationNodeList nodes={flatten(budget.nodes).filter(node => node.kind === 'error').slice(0, 1)} />;
  if (id === 'processing' || id === 'thinking') return <AiConversation nodes={[]} status="running" runningIndicator={id === 'thinking' ? 'ask' : 'agent'} throughSeq={null} />;
  if (id === 'process') return <AiConversationNodeList nodes={recorded.filter(node => node.kind === 'turnProcess').slice(0, 1)} />;
  if (trace[id]) return <AiConversationNodeList nodes={[trace[id]]} />;
  if (id === 'budget') return workspace({ view: budget });
  if (id === 'waitingApproval' || id === 'waitingQuestion') return workspace({ composerState: createAiComposerState({ phase: id }) });
  if (id.startsWith('history')) return workspace({ historicalContinuationAvailable: id !== 'history-error', historicalContinuationBusy: id === 'history-busy',
    historicalContinuationError: id === 'history-error' ? error!.message : null });
  if (id.startsWith('reconnect')) return workspace({ onContinueOnReconnectedTerminal: record, terminalReconnectBusy: id === 'reconnect-busy' });
  return workspace({ agentUnavailableReason: t(id === 'model' ? 'ai.error.invalidModelSelection' : id === 'conflict' ? 'terminal.occupancy.submitBlocked' : 'agent.availability.needsTerminal'),
    terminalConflict: id === 'conflict', canStartAgent: id === 'model',
    onOpenModel: id === 'model' ? record : undefined, onReconnectTerminal: id === 'terminal' ? record : undefined });
}

export async function show(id: string, locale: Locale, theme: 'light' | 'dark') {
  useAppStore.setState({ locale });
  await initI18n(locale);
  applyTheme(theme);
  delete document.body.dataset.catalogAction;
  flushSync(() => root.render(null));
  flushSync(() => root.render(<main key={id} className="ai-panel-shell @container/ai-workspace flex min-h-0 min-w-0 flex-col p-4"
    style={{ height: '100dvh' }} data-ai-scope="terminal">{renderCase(id)}</main>));
  await document.fonts.ready;
}
