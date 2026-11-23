import { use, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { diffLines, parsePatch } from 'diff';
import hljs from 'highlight.js/lib/common';
import {
  BotIcon,
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  Code2Icon,
  CopyIcon,
  FilePenLineIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { storedToolOutputId } from '@/lib/ai/conversation-tool';
import { aiErrorMessage, httpProbeTimeoutKind } from '@/lib/ai/error-message';
import { renderTerminalTranscript } from '@/lib/terminal/terminal-output-buffer';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import {
  extractSubagentToolSummary,
  isSubagentDelegationTool,
  subagentToolAction,
} from '@/lib/ai/subagent-lineage';
import { AiContentTitle } from './ai-content-title';
import { AiNativeCodeFade } from './ai-native-code-fade';
import { AiSubagentContext } from './ai-subagent-context';
import { AiSubagentToolCard } from './ai-subagent-tool-card';
import { subagentRoleLabel } from './ai-subagent-tree';
import { useToolLiveOutput } from './use-tool-live-output';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  AI_CONTENT_CODE_CLASS,
  AI_CONTENT_HEADER_CLASS,
  AI_DISCLOSURE_LEADING_CLASS,
  AI_DISCLOSURE_SEPARATOR_CLASS,
  AI_DISCLOSURE_SUMMARY_CLASS,
  AI_DISCLOSURE_TITLE_CLASS,
  AI_STATE_DOT_CLASS,
  AI_TOOL_ROW_CLASS,
} from './ai-style-classes';

export type AiToolVariant =
  | 'terminal'
  | 'read'
  | 'search'
  | 'web'
  | 'write'
  | 'edit'
  | 'code'
  | 'plan'
  | 'generic';

type ToolNode = AiConversationNodeOf<'tool'>;
type UnknownRecord = Record<string, unknown>;

const DETAIL_LIMIT = 64 * 1024;
const INLINE_DIFF_LIMIT = 32 * 1024;
const INLINE_DIFF_TIMEOUT_MS = 50;
const EMPTY_SUBAGENT_ID_MAP = new Map<string, string>();

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function firstString(record: UnknownRecord | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function firstNumber(record: UnknownRecord | null, keys: readonly string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function formatToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function bounded(value: string): string {
  return value.length > DETAIL_LIMIT ? `${value.slice(0, DETAIL_LIMIT)}\n…` : value;
}

function outputText(node: ToolNode): string {
  if (node.output === null) return '';
  if (typeof node.output === 'string') return node.output;
  const record = asRecord(node.output);
  if (record && classifyAiTool(node.name, node.nativeName) === 'terminal') {
    // Bound terminals have one shared PTY stream. An empty capture is still
    // an output value; it must not fall through to the protocol envelope.
    if (typeof record.combinedOutput === 'string') return record.combinedOutput;
    if ((typeof record.stdout === 'string' || typeof record.stderr === 'string')
      && !firstString(record, ['output', 'content', 'text', 'result', 'body', 'data', 'message', 'error'])) {
      const stdout = typeof record.stdout === 'string' ? record.stdout : '';
      const stderr = typeof record.stderr === 'string' ? record.stderr : '';
      const separator = stdout && stderr && !stdout.endsWith('\n') && !stderr.startsWith('\n') ? '\n' : '';
      return `${stdout}${separator}${stderr}`;
    }
  }
  const direct = firstString(record, [
    'output', 'stdout', 'content', 'text', 'result', 'body', 'data', 'message',
  ]);
  const stderr = firstString(record, ['stderr', 'error']);
  if (direct && stderr && direct !== stderr) return `${direct}\n${stderr}`;
  return direct ?? stderr ?? formatToolValue(node.output);
}

function classifyAiToolName(name: string): AiToolVariant {
  const normalized = name.toLowerCase().replace(/[.\-]/gu, '_');
  if (/(web_search|web_fetch|http|browser|url)/u.test(normalized)) return 'web';
  if (/(grep|glob|search|find_files|find_text)/u.test(normalized)) return 'search';
  if (/(read|cat|inspect_file|list_directory|list_files)/u.test(normalized)) return 'read';
  if (/(apply_patch|str_replace|edit|patch)/u.test(normalized)) return 'edit';
  if (/(write|create_file|save_file)/u.test(normalized)) return 'write';
  if (/(run_code|python|javascript|typescript|execute_code)/u.test(normalized)) return 'code';
  if (/(terminal|shell|bash|pwsh|command|exec|ssh)/u.test(normalized)) return 'terminal';
  return 'generic';
}

const EXACT_TOOL_VARIANTS: Readonly<Record<string, AiToolVariant>> = {
  apply_patch: 'edit',
  close_vim_editor: 'terminal',
  exec_command: 'terminal',
  insert_vim_text: 'edit',
  inspect_vim_buffer: 'read',
  kill_process: 'terminal',
  list_directory: 'read',
  update_plan: 'plan',
  probe_http: 'web',
  read_file: 'read',
  read_terminal: 'terminal',
  run_terminal_command: 'terminal',
  save_vim_buffer: 'write',
  search_text: 'search',
  terminal_execute: 'terminal',
  wait_process: 'terminal',
  wait_terminal: 'terminal',
  write_file: 'write',
  write_stdin: 'terminal',
  write_terminal_input: 'terminal',
};

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[.\-]/gu, '_');
}

export function classifyAiTool(name: string, nativeName?: string | null): AiToolVariant {
  const exactPublicVariant = EXACT_TOOL_VARIANTS[normalizedToolName(name)];
  if (exactPublicVariant) return exactPublicVariant;
  const publicVariant = classifyAiToolName(name);
  if (publicVariant !== 'generic' || !nativeName) return publicVariant;
  return EXACT_TOOL_VARIANTS[normalizedToolName(nativeName)] ?? 'generic';
}

export function toolExecutionDetails(node: ToolNode): UnknownRecord | null {
  if (classifyAiTool(node.name, node.nativeName) !== 'terminal') return null;
  const record = asRecord(node.output);
  if (!record || !['combinedOutput', 'stdout', 'stderr'].some(key => typeof record[key] === 'string')) return null;
  const details = Object.fromEntries(Object.entries(record).filter(([key]) => !['combinedOutput', 'stdout', 'stderr'].includes(key)));
  return Object.keys(details).length ? details : null;
}

function iconFor(variant: AiToolVariant): ComponentType<React.SVGProps<SVGSVGElement>> {
  switch (variant) {
    case 'terminal': return SquareTerminalIcon;
    case 'read': return FileTextIcon;
    case 'search': return SearchIcon;
    case 'web': return GlobeIcon;
    case 'write': return FilePenLineIcon;
    case 'edit': return FileSearchIcon;
    case 'code': return Code2Icon;
    case 'plan': return ListTodoIcon;
    case 'generic': return SparklesIcon;
  }
}

function titleKey(variant: AiToolVariant): LocaleKey {
  return `ai.workspace.tool.title.${variant}` as LocaleKey;
}

function toolSummary(node: ToolNode, variant: AiToolVariant): string {
  if (node.state === 'failed' || node.state === 'rejected') {
    const failure = node.error || node.summary || outputText(node);
    if (failure) return failure.split('\n')[0] ?? failure;
  }
  const input = asRecord(node.input);
  if (node.name === 'trash_file') return firstString(input, ['path']) ?? node.name;
  const path = variant === 'write' || variant === 'edit' ? toolFilePath(node) : null;
  if (path) return path.split('\n')[0] ?? path;
  const keys: Record<AiToolVariant, readonly string[]> = {
    terminal: ['description', 'explanation', 'command', 'cmd'],
    read: ['path', 'file_path', 'filePath', 'url'],
    search: ['query', 'pattern', 'path'],
    web: ['query', 'url'],
    write: ['path', 'file_path', 'filePath'],
    edit: ['path', 'file_path', 'filePath'],
    code: ['description', 'language'],
    plan: ['explanation'],
    generic: ['description', 'explanation', 'summary', 'intent', 'goal'],
  };
  const inputSummary = firstString(input, keys[variant]);
  return inputSummary?.split('\n')[0]
    ?? (node.summary ? node.summary.split('\n')[0] : undefined)
    ?? node.title
    ?? node.name;
}

function localizedPlanSummary(
  node: ToolNode,
  t: ReturnType<typeof useI18n>['t'],
): string | null {
  const input = asRecord(node.input);
  const explanation = firstString(input, ['explanation']);
  if (explanation) return explanation.split('\n')[0] ?? explanation;

  const counts = { inProgress: 0, pending: 0, completed: 0, blocked: 0, failed: 0 };
  const output = asRecord(node.output);
  const rawSteps = Array.isArray(input?.steps) && input.steps.length > 0
    ? input.steps
    : Array.isArray(output?.steps) && output.steps.length > 0
      ? output.steps
      : null;

  if (rawSteps) {
    for (const step of rawSteps) {
      const status = asRecord(step)?.status;
      if (status === 'in_progress' || status === 'inProgress') counts.inProgress += 1;
      else if (status === 'pending') counts.pending += 1;
      else if (status === 'completed') counts.completed += 1;
      else if (status === 'blocked') counts.blocked += 1;
      else if (status === 'failed') counts.failed += 1;
    }
  } else if (node.summary.startsWith('Updated task plan:')) {
    const match = (label: string): number => {
      const found = node.summary.match(new RegExp(`(\\d+)\\s+${label}`, 'i'));
      return found ? Number.parseInt(found[1], 10) : 0;
    };
    counts.inProgress = match('in progress');
    counts.pending = match('pending');
    counts.completed = match('completed');
    counts.blocked = match('blocked');
    counts.failed = match('failed');
  } else {
    return null;
  }

  const parts = [
    counts.inProgress > 0 ? t('ai.workspace.tasks.inProgress', { count: counts.inProgress }) : null,
    counts.pending > 0 ? t('ai.workspace.tasks.pending', { count: counts.pending }) : null,
    counts.completed > 0 ? t('ai.workspace.tasks.completed', { count: counts.completed }) : null,
    counts.blocked > 0 ? t('ai.workspace.tasks.blocked', { count: counts.blocked }) : null,
    counts.failed > 0 ? t('ai.workspace.tasks.failed', { count: counts.failed }) : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(t('ai.workspace.turnProcess.separator')) : null;
}

export function toolDisplaySummary(node: ToolNode, t: ReturnType<typeof useI18n>['t']): string {
  if (node.recoveredByToolKey) return t('ai.workspace.tool.recoveredSummary');
  if (node.state === 'uncertain') return t('ai.workspace.tool.uncertain');
  const variant = classifyAiTool(node.name, node.nativeName);
  if (variant === 'plan' && node.state !== 'failed' && node.state !== 'rejected') {
    const planSummary = localizedPlanSummary(node, t);
    if (planSummary) return planSummary;
  }
  const raw = toolSummary(node, variant);
  if (node.state === 'failed' || node.state === 'rejected') {
    const translated = aiErrorMessage(raw, t);
    return translated !== raw ? translated : t(node.state === 'rejected'
      ? 'ai.workspace.tool.rejected' : 'ai.workspace.tool.failureSummary');
  }
  return raw === 'Agent orchestration' ? t('ai.workspace.tool.title.orchestration') : raw;
}

function failureOnly(node: ToolNode): string | null {
  if (node.state !== 'failed' && node.state !== 'rejected') return null;
  const diagnostic = node.error || node.summary;
  if (!diagnostic) return null;
  return node.output === null || (typeof node.output === 'string' && node.output.trim() === diagnostic.trim())
    ? diagnostic : null;
}

export function toolErrorIsInOutput(node: ToolNode): boolean {
  return Boolean(node.error && (failureOnly(node) || bounded(outputText(node)).includes(node.error.trim())));
}

function FailureSurface({ node, diagnostic, showCopyActions, scrollable }: {
  readonly node: ToolNode;
  readonly diagnostic: string;
  readonly showCopyActions: boolean;
  readonly scrollable: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="ai-read-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="error">
      <AiToolContentRegion text={showCopyActions ? diagnostic : undefined} label={t('ai.workspace.tool.copyOutput')}>
        <pre tabIndex={0} className={cn(AI_CONTENT_CODE_CLASS, 'ai-detail-code ai-tool-text whitespace-pre-wrap [overflow-wrap:anywhere]', scrollable ? 'max-h-65 overflow-auto' : 'overflow-visible')} data-error={!node.recoveredByToolKey || undefined}>
          <code>{bounded(diagnostic)}</code>
        </pre>
      </AiToolContentRegion>
    </div>
  );
}

function toolTitle(
  node: ToolNode,
  variant: AiToolVariant,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (node.name === 'skill' || node.nativeName === 'skill') return t('ai.workspace.tool.title.skill');
  if (node.name === 'trash_file') return t('ai.workspace.approval.action.trashFile');
  if (node.name === 'probe_http' || node.nativeName === 'probe_http') return t('ai.workspace.tool.title.httpProbe');
  const subagentAction = subagentToolAction(node.name, node.nativeName);
  if (subagentAction === 'inspect') return t('ai.workspace.tool.title.inspectSubagent');
  if (subagentAction === 'cancel') return t('ai.workspace.tool.title.cancelSubagent');
  if (node.title === 'Agent orchestration') return t('ai.workspace.tool.title.orchestration');
  if (variant !== 'generic' || !node.title || node.title === node.name || node.title === node.nativeName) {
    return t(titleKey(variant));
  }
  return node.title;
}

export function toolLiveActionSummary(
  node: ToolNode,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const variant = classifyAiTool(node.name, node.nativeName);
  const title = toolTitle(node, variant, t);
  const summary = toolDisplaySummary(node, t).trim();
  const hasDetail = Boolean(summary && summary !== title && summary !== node.name && summary !== node.nativeName);
  if (node.state === 'preparing') {
    return hasDetail
      ? t('ai.workspace.turnProcess.runningAction', { action: t('ai.workspace.turnProcess.preparingTool', { tool: title }), detail: summary })
      : t('ai.workspace.turnProcess.preparingTool', { tool: title });
  }
  if (node.state === 'approval') {
    return hasDetail
      ? t('ai.workspace.turnProcess.approvalAction', { detail: summary })
      : t('ai.workspace.turnProcess.approvalAction', { detail: title });
  }
  return hasDetail
    ? t('ai.workspace.turnProcess.runningAction', { action: title, detail: summary })
    : t('ai.workspace.turnProcess.runningTool', { tool: title });
}

function TerminalOutputText({ text }: { text: string }) {
  const lines = useMemo(() => {
    const result = bounded(text).split(/\r?\n/u);
    // A final line terminator ends the previous line; it is not another row.
    if (result.length > 1 && result[result.length - 1] === '') result.pop();
    return result;
  }, [text]);
  return (
    <>
      {lines.map((line, index) => <div key={index} className="ai-block-line min-h-[18px] whitespace-pre">{line || '\u00a0'}</div>)}
    </>
  );
}

export function AiToolCopyButton({ text, label, className, showCopiedTooltip = true, placement = 'overlay', errorLabel }: {
  readonly text: string;
  readonly label?: string;
  readonly className?: string;
  readonly showCopiedTooltip?: boolean;
  readonly placement?: 'overlay' | 'inline';
  readonly errorLabel?: string;
}) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback(errorLabel);
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size={placement === 'inline' ? 'icon-sm' : 'icon-xs'}
            className={cn(placement === 'inline' ? 'static shrink-0' : 'ai-tool-copy-button absolute top-2 right-1 z-10', className)}
            aria-label={copied ? t('common.copied') : (label ?? t('common.copy'))}
            onClick={() => { void copy(text); }}
          />
        )}
      >
        {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      </TooltipTrigger>
      {(!copied || showCopiedTooltip) && (
        <TooltipContent>{copied ? t('common.copied') : (label ?? t('common.copy'))}</TooltipContent>
      )}
    </Tooltip>
  );
}

function ToolSurfaceHeader({ title, icon: Icon, copyText, copyLabel, className, titleClassName, children }: {
  readonly title: ReactNode;
  readonly icon?: ComponentType<React.SVGProps<SVGSVGElement>>;
  readonly copyText?: string;
  readonly copyLabel?: string;
  readonly className?: string;
  readonly titleClassName?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={cn(AI_CONTENT_HEADER_CLASS, 'ai-block-banner ai-tool-surface-header', className)} data-ai-copy-region={copyText ? '' : undefined}>
      {Icon && <Icon className="shrink-0" aria-hidden="true" />}
      <AiContentTitle className={cn('flex-1', titleClassName)}>{title}</AiContentTitle>
      {children}
      {copyText && <AiToolCopyButton text={copyText} label={copyLabel} className="static shrink-0" />}
    </div>
  );
}

function AiToolContentRegion({ children, text, label, className, showCopiedTooltip }: {
  readonly children: ReactNode;
  readonly text?: string;
  readonly label?: string;
  readonly className?: string;
  readonly showCopiedTooltip?: boolean;
}) {
  return (
    <div className={cn('ai-tool-content-region relative min-w-0', className)} data-ai-copy-region>
      {children}
      {text && <AiToolCopyButton text={text} label={label} className="top-1 right-3.5" showCopiedTooltip={showCopiedTooltip} />}
    </div>
  );
}

function ToolScrollArea({ children, className, contentClassName, viewportClassName, scrollable, view, label, horizontal = true, viewportRef, onViewportScroll }: {
  readonly children: ReactNode;
  readonly className: string;
  readonly contentClassName?: string;
  readonly viewportClassName?: string;
  readonly scrollable: boolean;
  readonly view?: 'generic' | 'diff';
  readonly label?: string;
  readonly horizontal?: boolean;
  readonly viewportRef?: RefObject<HTMLDivElement | null>;
  readonly onViewportScroll?: () => void;
}) {
  // Embedded previews may delegate vertical scrolling to their parent section.
  if (!scrollable) return <div ref={viewportRef} onScroll={onViewportScroll} className={cn(className, contentClassName, 'max-h-none overflow-auto')} data-ai-tool-view={view}>{children}</div>;
  return (
    <ScrollArea
      className={cn('ai-tool-scroll-area flex min-h-0 flex-col overflow-hidden', className)}
      data-ai-tool-view={view}
      horizontal={horizontal}
      viewportRender={<div ref={viewportRef} onScroll={onViewportScroll} className={cn('ai-tool-scroll-viewport h-auto min-h-0 min-w-0 flex-1', viewportClassName)} aria-label={label} style={horizontal ? undefined : { overflowX: 'hidden' }} />}
    >
      <ScrollAreaContent className={cn('min-w-0', contentClassName)} style={{ minWidth: 0 }}>
        {children}
      </ScrollAreaContent>
    </ScrollArea>
  );
}

const TOOL_OUTPUT_FADE_CLASS = 'data-[overflow-y-end]:scroll-fade-b';

function ToolExecutionFooter({ children, className, succeeded }: {
  readonly children: ReactNode;
  readonly className: string;
  readonly succeeded: boolean;
}) {
  return (
    <div className={cn(AI_CONTENT_HEADER_CLASS, 'flex-wrap justify-end py-1.5', className)}>
      {succeeded && <CheckIcon className="size-3 shrink-0" aria-hidden="true" />}
      {children}
    </div>
  );
}

const LIVE_SCROLL_FOLLOW_THRESHOLD = 8;

function TerminalSurface({ node, showCopyActions, scrollable, showInput }: { node: ToolNode; showCopyActions: boolean; scrollable: boolean; showInput: boolean }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const rawOutput = outputText(node);
  const liveOutput = useToolLiveOutput(node.sessionId, node.callId, node.state === 'running');
  const usingLive = node.state === 'running' && !rawOutput && liveOutput !== null;
  const isAlternateScreen = usingLive && liveOutput.alternateScreen;
  const effectiveRaw = usingLive ? (isAlternateScreen ? '' : liveOutput.tail) : rawOutput;
  const output = useMemo(() => renderTerminalTranscript(effectiveRaw), [effectiveRaw]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const handleViewportScroll = (): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followingRef.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= LIVE_SCROLL_FOLLOW_THRESHOLD;
  };
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followingRef.current) return;
    if (usingLive && output) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [usingLive, output]);
  const command = firstString(input, ['command', 'cmd', 'script']) ?? formatToolValue(node.input);
  const displayCommand = command || node.name;
  const outputRecord = asRecord(node.output);
  const execution = firstString(outputRecord, ['execution']);
  const executionLabel = execution === 'running' ? 'ai.workspace.tool.execution.running'
    : execution === 'completed' ? 'ai.workspace.tool.execution.completed'
      : execution === 'notStarted' ? 'ai.workspace.tool.execution.notStarted'
        : execution === 'unknown' ? 'ai.workspace.tool.uncertain' : null;
  const targetTerminalSessionId = node.target?.sessionId ?? null;
  const isBoundTerminalTool = node.nativeName === 'terminal_execute' || outputRecord?.channel === 'terminal';
  const canFocusTerminal = useTerminalStore((state) => Boolean(
    isBoundTerminalTool
    && targetTerminalSessionId
    && state.sessions.some((session) => session.sessionId === targetTerminalSessionId),
  ));
  const handleFocusTerminal = (): void => {
    if (!targetTerminalSessionId) return;
    useTerminalStore.getState().setActiveSession(targetTerminalSessionId);
    useAppStore.getState().setActiveSection('terminal');
    terminalRegistry.get(targetTerminalSessionId)?.terminal?.focus();
  };
  const job = asRecord(outputRecord?.job);
  const exitCode = execution && execution !== 'completed' ? null
    : firstNumber(execution === 'completed' && job ? job : outputRecord, ['exitCode', 'exit_code', 'code']);
  const hasFailedExit = exitCode !== null && exitCode !== 0;
  const succeeded = exitCode === 0;
  const showSuccessIcon = succeeded || (execution === null && exitCode === null && node.state === 'succeeded');
  const exitStatus = hasFailedExit && <span className="ai-terminal-exit shrink-0">{t('ai.workspace.tool.exitCode', { code: exitCode })}</span>;
  const footerLabel = succeeded ? 'ai.workspace.tool.execution.succeeded' : executionLabel ?? `ai.workspace.tool.${node.state}`;
  const showOutputSection = Boolean(output || isAlternateScreen || node.state !== 'running');
  const commandTitle = <>
    <AiToolContentRegion text={showCopyActions ? command : undefined} label={t('ai.workspace.tool.copyCommand')} showCopiedTooltip={false}>
      <div className="ai-terminal-command-row flex min-w-0 items-start py-1 pl-3.5">
        <AiContentTitle
          className="flex-1"
          buttonClassName="ai-terminal-command pr-3.5"
          leading={<span className="ai-terminal-prompt shrink-0 select-none" aria-hidden="true">$</span>}
          collapsible
          customScrollbar
          expandLabel={t('ai.workspace.tool.expandCommand')}
          collapseLabel={t('ai.workspace.tool.collapseCommand')}
        >
          {displayCommand}
        </AiContentTitle>
      </div>
    </AiToolContentRegion>
  </>;
  return (
    <div
      className="ai-terminal-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden"
      data-ai-tool-view="terminal"
      data-running={node.state === 'running' || undefined}
      data-live-output={usingLive || undefined}
    >
      <ToolSurfaceHeader className="ai-terminal-header" title={t('ai.workspace.tool.shell')}>
        {usingLive && liveOutput.truncated && !isAlternateScreen && (
          <span className="shrink-0 text-xs text-muted-foreground" data-ai-live-truncated="">
            {t('ai.workspace.tool.showingRecentOutput')}
          </span>
        )}
        {canFocusTerminal && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ai-terminal-focus-button h-5 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleFocusTerminal}
          >
            <SquareArrowOutUpRightIcon className="size-3 shrink-0" aria-hidden="true" />
            <span>{t('ai.workspace.tool.focusTerminal')}</span>
          </Button>
        )}
        {!showInput && <>
          {executionLabel && <span className="shrink-0" data-ai-terminal-execution={execution}>{t(executionLabel)}</span>}
          {exitStatus}
        </>}
      </ToolSurfaceHeader>
      <div className="ai-terminal-output relative m-0 min-w-0 max-w-full">
        {showInput && commandTitle}
        {showOutputSection && <div className={showInput ? 'mt-2' : undefined} data-ai-terminal-output>
          <AiToolContentRegion text={showCopyActions && !isAlternateScreen ? output : undefined} label={t('ai.workspace.tool.copyOutput')} showCopiedTooltip={false}>
            <ToolScrollArea
              className={cn('ai-terminal-transcript min-w-0 max-w-full', usingLive ? 'max-h-[156px]' : 'max-h-65')}
              viewportClassName={showInput ? TOOL_OUTPUT_FADE_CLASS : undefined}
              scrollable={scrollable}
              label={t('ai.workspace.tool.shell')}
              viewportRef={viewportRef}
              onViewportScroll={handleViewportScroll}
            >
              <div className="px-3.5 pb-3">
                {isAlternateScreen ? (
                  <span className="text-muted-foreground" data-ai-terminal-interactive="">
                    {t('ai.workspace.tool.interactiveRunning')}
                  </span>
                ) : output ? (
                  <TerminalOutputText text={output} />
                ) : (
                  t('ai.workspace.tool.noOutput')
                )}
              </div>
            </ToolScrollArea>
          </AiToolContentRegion>
        </div>}
      </div>
      {showInput && (
        <ToolExecutionFooter className="ai-terminal-footer" succeeded={showSuccessIcon}>
          {hasFailedExit ? exitStatus : <span data-ai-terminal-execution={execution}>{t(footerLabel)}</span>}
        </ToolExecutionFooter>
      )}
    </div>
  );
}

function ReadSurface({ node, showCopyActions, showInput, scrollable }: { node: ToolNode; showCopyActions: boolean; showInput: boolean; scrollable: boolean }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const path = firstString(input, ['path', 'file_path', 'filePath']);
  const inputText = path ?? formatToolValue(node.input);
  const label = path
    ?? (node.state === 'failed' || node.state === 'rejected' ? t('ai.workspace.tool.title.read') : node.summary || node.name);
  const output = outputText(node);
  const preview = bounded(output);
  const lines = preview.split('\n');
  const viewportRef = useRef<HTMLPreElement>(null);
  return (
    <div className="ai-read-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="read">
      {showInput && <ToolSurfaceHeader title={label} copyText={showCopyActions ? inputText : undefined} copyLabel={t('ai.workspace.tool.copyInput')} />}
      <div className="ai-tool-content-region relative min-w-0" data-ai-copy-region>
        {showCopyActions && output && <AiToolCopyButton text={output} label={t('ai.workspace.tool.copyOutput')} className="top-1 right-3.5" />}
        <pre ref={viewportRef} className={cn(AI_CONTENT_CODE_CLASS, 'ai-read-lines pr-12 whitespace-pre', scrollable ? 'max-h-65 overflow-auto' : 'overflow-visible')} tabIndex={0}>
          {lines.map((line, index) => (
            <span key={index} className="ai-read-line grid min-h-[18px] grid-cols-[34px_minmax(max-content,1fr)]">
              <span className="ai-read-line-number" aria-hidden="true">{index + 1}</span>
              <span>{line || '\u00a0'}</span>
            </span>
          ))}
        </pre>
        {scrollable && <AiNativeCodeFade viewportRef={viewportRef} text={preview} />}
      </div>
    </div>
  );
}

function SearchSurface({ node, showCopyActions, showInput, scrollable }: { node: ToolNode; showCopyActions: boolean; showInput: boolean; scrollable: boolean }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const query = firstString(input, ['query', 'pattern'])
    ?? (node.state === 'failed' || node.state === 'rejected' ? t('ai.workspace.tool.title.search') : node.summary || node.name);
  const output = outputText(node);
  const lines = bounded(output).split('\n').filter(Boolean);
  return (
    <div className="ai-search-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="search">
      {showInput && <ToolSurfaceHeader title={query} icon={SearchIcon} />}
      <AiToolContentRegion text={showCopyActions ? output : undefined} label={t('ai.workspace.tool.copyOutput')}>
        <div className={cn('ai-search-results m-0 flex max-w-full flex-col gap-1 px-3.5 pt-1 pb-3', scrollable ? 'max-h-65 overflow-auto' : 'overflow-visible')} tabIndex={0}>
          {lines.map((line, index) => <div key={index} className="ai-search-result min-w-0 [overflow-wrap:anywhere]">{line}</div>)}
        </div>
      </AiToolContentRegion>
    </div>
  );
}

interface WebSource {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

function webSources(value: unknown): readonly WebSource[] {
  const record = asRecord(value);
  const raw = Array.isArray(value) ? value : Array.isArray(record?.sources) ? record.sources : [];
  return raw.flatMap((item) => {
    const source = asRecord(item);
    const url = firstString(source, ['url', 'href', 'link']);
    if (!url) return [];
    return [{
      url,
      title: firstString(source, ['title', 'name']) ?? url,
      snippet: firstString(source, ['snippet', 'description', 'text']) ?? '',
    }];
  });
}

function WebSurface({ node, showCopyActions, showInput, scrollable }: { node: ToolNode; showCopyActions: boolean; showInput: boolean; scrollable: boolean }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const sources = webSources(node.output);
  const url = firstString(input, ['url']);
  const answer = firstString(asRecord(node.output), ['answer', 'summary']);
  const diagnostic = node.error || node.summary || outputText(node);
  const timeoutKind = node.state === 'failed' && (node.name === 'probe_http' || node.nativeName === 'probe_http')
    ? httpProbeTimeoutKind(diagnostic) : null;
  const label = url ?? (node.state === 'failed' || node.state === 'rejected'
    ? toolTitle(node, 'web', t) : node.summary || node.name);
  const output = timeoutKind ? diagnostic : outputText(node);
  return (
    <div className="ai-web-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="web">
      {showInput && <ToolSurfaceHeader title={label} icon={GlobeIcon} />}
      <AiToolContentRegion text={showCopyActions ? output : undefined} label={t('ai.workspace.tool.copyOutput')}>
        <div className={cn('ai-web-content min-w-0 max-w-full', scrollable ? 'max-h-65 overflow-auto' : 'overflow-visible')} tabIndex={0}>
          {(timeoutKind || answer) && <p className="ai-web-answer m-0 px-3.5 pt-3 pb-1">{timeoutKind
            ? t(timeoutKind === 'ssh' ? 'ai.workspace.tool.httpProbe.sshTimeout' : 'ai.workspace.tool.httpProbe.httpTimeout')
            : answer}</p>}
          {sources.length > 0 ? (
            <div className="ai-web-sources flex min-w-0 flex-col p-2">
              {sources.map((source, index) => (
                <a key={`${source.url}:${index}`} href={source.url} target="_blank" rel="noreferrer" className="ai-web-source flex min-w-0 flex-col p-1.5">
                  <span className="min-w-0 truncate">{source.title}</span>
                  {source.snippet && <small className="min-w-0 truncate">{source.snippet}</small>}
                </a>
              ))}
            </div>
          ) : (
            <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-detail-code ai-tool-text whitespace-pre-wrap break-words')}>{bounded(timeoutKind ? diagnostic : outputText(node))}</pre>
          )}
        </div>
      </AiToolContentRegion>
    </div>
  );
}

interface DiffHunk {
  readonly oldStart?: number;
  readonly newStart?: number;
  readonly path: string;
  readonly lines: readonly DiffLine[];
  readonly exact: boolean;
}

interface DiffLine {
  readonly number?: number;
  readonly kind: 'context' | 'removed' | 'added';
  readonly text: string;
}

interface DiffModel {
  readonly hunks: readonly DiffHunk[];
  readonly totalsKnown: boolean;
}

function contentLines(text: string): readonly string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function lineTokens(text: string): readonly string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

function textDiffLines(oldText: string | null, newText: string): Pick<DiffHunk, 'lines' | 'exact'> {
  if (oldText === null) {
    return { lines: contentLines(newText).map((text): DiffLine => ({ kind: 'added', text })), exact: true };
  }
  const oldTokens = lineTokens(oldText);
  const newTokens = lineTokens(newText);
  let prefix = 0;
  while (prefix < oldTokens.length && prefix < newTokens.length && oldTokens[prefix] === newTokens[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < oldTokens.length - prefix && suffix < newTokens.length - prefix
    && oldTokens[oldTokens.length - suffix - 1] === newTokens[newTokens.length - suffix - 1]) {
    suffix += 1;
  }
  const contextLine = (token: string): DiffLine => ({
    kind: 'context', text: token.endsWith('\n') ? token.slice(0, -1) : token,
  });
  const before = oldTokens.slice(0, prefix).map(contextLine);
  const after = suffix === 0 ? [] : oldTokens.slice(-suffix).map(contextLine);
  const oldMiddle = oldTokens.slice(prefix, oldTokens.length - suffix).join('');
  const newMiddle = newTokens.slice(prefix, newTokens.length - suffix).join('');
  const changes = oldMiddle.length + newMiddle.length > INLINE_DIFF_LIMIT
    ? undefined
    : diffLines(oldMiddle, newMiddle, { timeout: INLINE_DIFF_TIMEOUT_MS });
  const middle = changes?.flatMap((change): DiffLine[] => {
    const kind: DiffLine['kind'] = change.added ? 'added' : change.removed ? 'removed' : 'context';
    return contentLines(change.value).map((text) => ({ kind, text }));
  }) ?? [
    ...contentLines(oldMiddle).map((text): DiffLine => ({ kind: 'removed', text })),
    ...contentLines(newMiddle).map((text): DiffLine => ({ kind: 'added', text })),
  ];
  return { lines: [...before, ...middle, ...after], exact: changes !== undefined };
}

export interface ToolFileChangeEntry {
  readonly path: string;
  readonly added: number | null;
  readonly removed: number | null;
  readonly kind: 'modified' | 'deleted';
  readonly tool: ToolNode;
}

export function extractToolFileChanges(node: ToolNode): readonly ToolFileChangeEntry[] {
  if (node.state !== 'succeeded') return [];
  if (node.name === 'trash_file' || node.nativeName === 'trash_file') {
    const path = firstString(asRecord(node.input), ['path', 'file_path', 'filePath']);
    return path ? [{ path, added: null, removed: null, kind: 'deleted', tool: node }] : [];
  }
  const variant = classifyAiTool(node.name, node.nativeName);
  if (variant !== 'write' && variant !== 'edit') return [];
  const model = diffModel(node);
  if (model.hunks.length > 0) {
    const byPath = new Map<string, { added: number; removed: number; exact: boolean }>();
    for (const hunk of model.hunks) {
      let added = 0;
      let removed = 0;
      for (const line of hunk.lines) {
        if (line.kind === 'added') added += 1;
        if (line.kind === 'removed') removed += 1;
      }
      const existing = byPath.get(hunk.path);
      if (existing) {
        existing.added += added;
        existing.removed += removed;
        existing.exact = existing.exact && hunk.exact;
      } else {
        byPath.set(hunk.path, { added, removed, exact: hunk.exact && model.totalsKnown });
      }
    }
    return [...byPath.entries()].map(([path, counts]) => ({
      path,
      added: counts.exact ? counts.added : null,
      removed: counts.exact ? counts.removed : null,
      kind: 'modified',
      tool: node,
    }));
  }
  const path = toolFilePath(node);
  return path ? [{ path, added: null, removed: null, kind: 'modified', tool: node }] : [];
}

function diffStat(model: DiffModel): string | null {
  if (!model.totalsKnown || model.hunks.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of model.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added += 1;
      if (line.kind === 'removed') removed += 1;
    }
  }
  return `+${added} -${removed}`;
}

function firstPath(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const path = firstString(asRecord(value), ['path', 'file_path', 'filePath']);
    if (path) return path;
  }
  return null;
}

function toolFilePath(node: ToolNode): string | null {
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  return firstString(input, ['path', 'file_path', 'filePath'])
    ?? firstString(output, ['path', 'file_path', 'filePath'])
    ?? firstPath(input?.preconditions)
    ?? firstPath(output?.files);
}

function structuredDiffHunks(node: ToolNode): readonly DiffHunk[] {
  const output = asRecord(node.output);
  const diffs = Array.isArray(output?.diffs) ? output.diffs : null;
  if (!diffs) return [];
  return diffs.flatMap((value) => {
    const hunk = asRecord(value);
    const path = firstString(hunk, ['path', 'file_path']);
    const oldText = hunk?.oldText ?? hunk?.old_string ?? null;
    const newText = hunk?.newText ?? hunk?.new_string;
    return path && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
      ? [{ path, ...textDiffLines(oldText, newText) }]
      : [];
  });
}

function unifiedDiffHunks(node: ToolNode): readonly DiffHunk[] {
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  const unifiedDiff = firstString(output, ['diff']) ?? firstString(input, ['patch']);
  if (!unifiedDiff || unifiedDiff.length > DETAIL_LIMIT) return [];
  try {
    const fallbackPath = toolFilePath(node);
    return parsePatch(unifiedDiff).flatMap((patch) => patch.hunks.map((hunk) => {
      return {
        path: fallbackPath ?? patch.newFileName ?? patch.oldFileName ?? node.name,
        exact: true,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        lines: hunk.lines.flatMap((line): DiffLine[] => {
          const kind = line.startsWith('-') ? 'removed' : line.startsWith('+') ? 'added'
            : line.startsWith(' ') ? 'context' : null;
          return kind ? [{ kind, text: line.slice(1) }] : [];
        }),
      };
    }));
  } catch {
    return [];
  }
}

function directDiffHunks(node: ToolNode): readonly DiffHunk[] {
  const input = asRecord(node.input);
  const path = toolFilePath(node);
  const oldText = input?.old_string ?? input?.oldText ?? null;
  const newText = input?.new_string ?? input?.newText ?? input?.content;
  return path && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
    ? [{ path, ...textDiffLines(oldText, newText) }]
    : [];
}

function diffModel(node: ToolNode): DiffModel {
  const structured = structuredDiffHunks(node);
  if (structured.length > 0) return { hunks: structured, totalsKnown: structured.every((hunk) => hunk.exact) };
  const unified = unifiedDiffHunks(node);
  if (unified.length > 0) return { hunks: unified, totalsKnown: true };
  const direct = directDiffHunks(node);
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  const precondition = asRecord(input?.precondition);
  const replacesUnknownContent = output?.operation === 'replace'
    || typeof precondition?.sha256 === 'string';
  return { hunks: direct, totalsKnown: direct.length > 0 && direct.every((hunk) => hunk.exact) && !replacesUnknownContent };
}

export function toolDiffPreview(node: ToolNode): DiffModel | null {
  const variant = classifyAiTool(node.name, node.nativeName);
  if (variant !== 'write' && variant !== 'edit') return null;
  const diagnostic = failureOnly(node);
  if (diagnostic && !httpProbeTimeoutKind(diagnostic)) return null;
  const model = diffModel(node);
  return model.hunks.length > 0 ? model : null;
}

function DiffSurface({ node, compact, model, showCopyActions, scrollable, copyAction, showInput }: { node: ToolNode; compact: boolean; model?: DiffModel; showCopyActions: boolean; scrollable: boolean; copyAction?: ReactNode; showInput: boolean }) {
  const { t } = useI18n();
  const currentModel = useMemo(() => model ?? diffModel(node), [model, node]);
  const hunks = useMemo(() => currentModel.hunks.map((hunk) => {
    let oldNumber = hunk.oldStart ?? 1;
    let newNumber = hunk.newStart ?? 1;
    return { ...hunk, lines: hunk.lines.map((line) => {
      const number = line.kind === 'removed' ? oldNumber : newNumber;
      if (line.kind !== 'added') oldNumber += 1;
      if (line.kind !== 'removed') newNumber += 1;
      return { ...line, number };
    }) };
  }), [currentModel]);
  const files = useMemo(() => {
    const grouped = new Map<string, (typeof hunks)[number]>();
    for (const hunk of hunks) {
      const previous = grouped.get(hunk.path);
      if (previous) {
        previous.exact = previous.exact && hunk.exact;
        previous.lines.push(...hunk.lines);
      } else {
        grouped.set(hunk.path, { ...hunk, lines: [...hunk.lines] });
      }
    }
    return [...grouped.values()];
  }, [hunks]);
  const copyText = firstString(asRecord(node.output), ['diff', 'patch', 'unified_diff'])
    ?? firstString(asRecord(node.input), ['patch', 'diff'])
    ?? outputText(node);
  if (hunks.length === 0) return <IoSurface node={node} compact={compact} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} />;
  return (
    <div className="ai-diff-block my-1 ml-1 flex min-w-0 max-w-[calc(100%-4px)] flex-col gap-px overflow-hidden" data-ai-tool-view="diff">
      {files.map((hunk, index) => (
        <section key={`${hunk.path}:${index}`} className="min-w-0 max-w-full shrink-0">
          <ToolSurfaceHeader title={hunk.path} className={showInput ? undefined : 'min-h-8'}>
            {hunk.exact && currentModel.totalsKnown && <span className="ai-diff-counts shrink-0">
              <span data-diff-count="added">+{hunk.lines.filter((line) => line.kind === 'added').length}</span>{' '}
              <span data-diff-count="removed">-{hunk.lines.filter((line) => line.kind === 'removed').length}</span>
            </span>}
          </ToolSurfaceHeader>
          <AiToolContentRegion text={showCopyActions && index === 0 ? copyText : undefined} label={t('ai.workspace.tool.copyOutput')}>
            <ToolScrollArea className="ai-diff-content max-h-65 min-w-0 max-w-full" viewportClassName={showInput ? TOOL_OUTPUT_FADE_CLASS : undefined} scrollable={scrollable}>
              {!hunk.exact && <div className="px-2.5 py-1 text-xs text-muted-foreground" data-diff-simplified>
                {t('ai.workspace.tool.diffSimplified')}
              </div>}
              <pre className="ai-diff-body m-0 min-w-0 max-w-full pt-px whitespace-pre" aria-label={hunk.path}>
                <code className="ai-diff-lines">
                  {hunk.lines.map((line, lineIndex) => (
                    <span key={lineIndex} data-diff={line.kind}>
                      <span className="ai-diff-line-number" aria-hidden="true">{line.number}</span>
                      <DiffCode text={line.text} path={hunk.path} />
                    </span>
                  ))}
                </code>
              </pre>
            </ToolScrollArea>
            {index === 0 && copyAction}
          </AiToolContentRegion>
        </section>
      ))}
    </div>
  );
}

function DiffCode({ text, path }: { text: string; path: string }) {
  const html = useMemo(() => {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const language = ({ tsx: 'typescript', jsx: 'javascript', vue: 'xml', svg: 'xml', mjs: 'javascript', cjs: 'javascript' } as Record<string, string>)[extension] ?? extension;
    if (text.length > 10_000 || !hljs.getLanguage(language)) return null;
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  }, [text, path]);
  // Only highlight.js-generated, escaped markup is inserted; unknown languages stay plain text.
  return html === null ? <span className="ai-diff-code table-cell px-3">{text || '\u00a0'}</span>
    : <span className="ai-diff-code table-cell px-3" dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />;
}

function CodeSurface({ node, showCopyActions, scrollable, showInput }: { node: ToolNode; showCopyActions: boolean; scrollable: boolean; showInput: boolean }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const code = firstString(input, ['code', 'program', 'script']) ?? formatToolValue(node.input);
  const language = firstString(input, ['language', 'lang']) ?? 'code';
  const output = outputText(node);
  const exitCode = node.state === 'succeeded' || node.state === 'failed'
    ? firstNumber(asRecord(node.output), ['exitCode', 'exit_code']) : null;
  const hasFailedExit = exitCode !== null && exitCode !== 0;
  const succeeded = node.state === 'succeeded' && !hasFailedExit;
  const failed = hasFailedExit || node.state === 'failed' || node.state === 'rejected';
  const outputLabel = t('ai.workspace.tool.outputLabel');
  return (
    <div className="ai-code-block ai-tool-code-block relative my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="code">
      {showInput && <>
        <ToolSurfaceHeader title={language} titleClassName="ai-code-block-language" />
        <AiToolContentRegion text={showCopyActions ? code : undefined} label={t('ai.workspace.tool.copyInput')} showCopiedTooltip={false}>
          <ToolScrollArea className="ai-code-content max-h-65 min-w-0 max-w-full" viewportClassName={TOOL_OUTPUT_FADE_CLASS} scrollable={scrollable} label={language}>
            <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-code-block-pre ai-tool-text whitespace-pre-wrap [overflow-wrap:anywhere]')}><code>{bounded(code)}</code></pre>
          </ToolScrollArea>
        </AiToolContentRegion>
      </>}
      {node.output !== null && (
        <div className={cn('ai-io-section min-w-0', showInput && 'mt-2')}>
          <AiToolContentRegion text={showCopyActions ? output : undefined} label={t('ai.workspace.tool.copyOutput')} showCopiedTooltip={!showInput}>
            <ToolScrollArea className="ai-code-output max-h-65 min-w-0 max-w-full" viewportClassName={showInput ? TOOL_OUTPUT_FADE_CLASS : undefined} scrollable={scrollable} label={outputLabel}>
              <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-io-text whitespace-pre-wrap [overflow-wrap:anywhere]')}>{bounded(output)}</pre>
            </ToolScrollArea>
          </AiToolContentRegion>
        </div>
      )}
      {showInput && (
        <ToolExecutionFooter className="ai-code-footer" succeeded={succeeded}>
          <span className={cn(failed && 'text-destructive')}>
            {hasFailedExit ? t('ai.workspace.tool.exitCode', { code: exitCode })
              : t(succeeded ? 'ai.workspace.tool.execution.succeeded' : `ai.workspace.tool.${node.state}`)}
          </span>
        </ToolExecutionFooter>
      )}
    </div>
  );
}

export function AiToolTextSection({ title, text, copyText, copyLabel, scrollable = true, showHeader = true }: {
  readonly title: string;
  readonly text: string;
  readonly copyText?: string;
  readonly copyLabel?: string;
  readonly scrollable?: boolean;
  readonly showHeader?: boolean;
}) {
  return (
    <div className="ai-io-section min-w-0 shrink-0 overflow-hidden">
      {showHeader && <ToolSurfaceHeader title={title} titleClassName="ai-io-label" />}
      <AiToolContentRegion text={copyText} label={copyLabel}>
        <ToolScrollArea className="ai-io-input max-h-65 min-w-0 max-w-full" scrollable={scrollable} label={title}>
          <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-io-text whitespace-pre-wrap [overflow-wrap:anywhere]')}>{text}</pre>
        </ToolScrollArea>
      </AiToolContentRegion>
    </div>
  );
}

function IoSurface({ node, showCopyActions, scrollable, showInput = true }: {
  node: ToolNode;
  compact: boolean;
  showCopyActions: boolean;
  scrollable: boolean;
  showInput?: boolean;
}) {
  const { t } = useI18n();
  const input = bounded(formatToolValue(node.input));
  const output = bounded(outputText(node));
  return (
    <div className="ai-io-card my-1 ml-1 flex min-w-0 max-w-[calc(100%-4px)] flex-col gap-2" data-ai-tool-view="generic">
      {showInput && input && (
        <AiToolTextSection title={t('ai.workspace.tool.inputLabel')} text={input}
          copyText={showCopyActions ? formatToolValue(node.input) : undefined}
          copyLabel={t('ai.workspace.tool.copyInput')} scrollable={scrollable} />
      )}
      {output && (
        <div className="ai-io-section min-w-0 shrink-0 overflow-hidden">
          {(showInput || showCopyActions) && <ToolSurfaceHeader title={t('ai.workspace.tool.outputLabel')} titleClassName={showInput ? 'ai-io-label' : undefined} />}
          <AiToolContentRegion text={showCopyActions ? outputText(node) : undefined} label={t('ai.workspace.tool.copyOutput')}>
            <ToolScrollArea className="ai-io-output max-h-65 min-w-0 max-w-full" scrollable={scrollable}>
              <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-io-text whitespace-pre-wrap [overflow-wrap:anywhere]')} data-error={node.state === 'failed' || undefined}>
                {output}
              </pre>
            </ToolScrollArea>
          </AiToolContentRegion>
        </div>
      )}
    </div>
  );
}

function TrashSurface({ node, showCopyActions, scrollable, showInput }: { readonly node: ToolNode; readonly showCopyActions: boolean; readonly scrollable: boolean; readonly showInput: boolean }) {
  if (node.state !== 'succeeded') return <IoSurface node={node} compact={false} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} />;
  return <AiTrashRecoveryNotice />;
}

export function AiTrashRecoveryNotice() {
  const { t } = useI18n();
  return (
    <Alert variant="info" size="sm" role="note">
      <Trash2Icon aria-hidden="true" />
      <AlertDescription>{t('ai.workspace.tool.trashRecovery')}</AlertDescription>
    </Alert>
  );
}

export function AiToolExpandedContent({
  node,
  compact = false,
  showCopyActions = true,
  showInput = true,
  scrollable = true,
  diffModel: precomputedDiff,
  diffCopyAction,
}: {
  readonly node: ToolNode;
  readonly compact?: boolean;
  readonly showCopyActions?: boolean;
  readonly showInput?: boolean;
  readonly scrollable?: boolean;
  readonly diffModel?: DiffModel;
  readonly diffCopyAction?: ReactNode;
}) {
  const variant = classifyAiTool(node.name, node.nativeName);
  const diagnostic = failureOnly(node);
  if (diagnostic && !httpProbeTimeoutKind(diagnostic)) {
    return <FailureSurface node={node} diagnostic={diagnostic} showCopyActions={showCopyActions} scrollable={scrollable} />;
  }
  if (node.name === 'trash_file') return <TrashSurface node={node} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} />;
  switch (variant) {
    case 'terminal': return <TerminalSurface node={node} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} />;
    case 'read': return <ReadSurface node={node} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} />;
    case 'search': return <SearchSurface node={node} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} />;
    case 'web': return <WebSurface node={node} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} />;
    case 'write':
    case 'edit': return <DiffSurface node={node} compact={compact} model={precomputedDiff} showCopyActions={showCopyActions} scrollable={scrollable} copyAction={diffCopyAction} showInput={showInput} />;
    case 'code': return <CodeSurface node={node} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} />;
    case 'plan':
    case 'generic': return <IoSurface node={node} compact={compact} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} />;
  }
}

export function AiToolRow({
  node,
  onOpenStoredOutput,
}: {
  readonly node: ToolNode;
  readonly onOpenStoredOutput?: (node: ToolNode, artifactId: string) => void;
}) {
  if (isSubagentDelegationTool(node.name, node.nativeName)) {
    return <AiSubagentToolCard node={node} />;
  }
  return <StandardAiToolRow node={node} onOpenStoredOutput={onOpenStoredOutput} />;
}

function toolGroupTargetLabel(node: ToolNode, variant: 'read' | 'search'): string | null {
  const input = asRecord(node.input);
  const raw = variant === 'read'
    ? firstString(input, ['path', 'file_path', 'filePath'])
    : firstString(input, ['query', 'pattern', 'path']);
  if (!raw) return null;
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return null;
  if (variant === 'read') {
    const segments = firstLine.split(/[\\/]/u).filter(Boolean);
    return segments[segments.length - 1] ?? firstLine;
  }
  return firstLine;
}

export function AiToolGroupRow({
  tools,
  onOpenStoredOutput,
}: {
  readonly tools: readonly ToolNode[];
  readonly onOpenStoredOutput?: (node: ToolNode, artifactId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const { readCount, searchCount, totalDurationMs, preview } = useMemo(() => {
    let reads = 0;
    let searches = 0;
    let duration = 0;
    let hasDuration = false;
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const tool of tools) {
      const variant = classifyAiTool(tool.name, tool.nativeName) === 'search' ? 'search' : 'read';
      if (variant === 'search') searches += 1;
      else reads += 1;
      if (tool.durationMs !== null) {
        duration += Math.max(0, tool.durationMs);
        hasDuration = true;
      }
      if (labels.length < 2) {
        const label = toolGroupTargetLabel(tool, variant);
        if (label && !seen.has(label)) {
          seen.add(label);
          labels.push(label);
        }
      }
    }
    return {
      readCount: reads,
      searchCount: searches,
      totalDurationMs: hasDuration ? duration : null,
      preview: labels.length > 0 ? labels.join(', ') : null,
    };
  }, [tools]);

  const kind: 'explored' | 'read' | 'search' = readCount > 0 && searchCount > 0
    ? 'explored'
    : searchCount > 0
      ? 'search'
      : 'read';
  const Icon = kind === 'search' ? SearchIcon : kind === 'read' ? FileTextIcon : FileSearchIcon;
  const title = t(`ai.workspace.toolGroup.title.${kind}` as LocaleKey);
  const countText = kind === 'explored'
    ? [
        readCount === 1
          ? t('ai.workspace.toolGroup.mixedReadSingle')
          : t('ai.workspace.toolGroup.mixedRead', { count: readCount }),
        searchCount === 1
          ? t('ai.workspace.toolGroup.mixedSearchSingle')
          : t('ai.workspace.toolGroup.mixedSearch', { count: searchCount }),
      ].join(t('ai.workspace.toolGroup.partSeparator'))
    : kind === 'read'
      ? t('ai.workspace.toolGroup.readCount', { count: readCount })
      : t('ai.workspace.toolGroup.searchCount', { count: searchCount });
  const summary = kind !== 'explored' && preview
    ? `${countText}${t('ai.workspace.turnProcess.separator')}${preview}`
    : countText;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-tool-group ai-tool-row-root flex min-w-0 flex-col"
        data-tool-group=""
        data-tool-group-count={tools.length}
        data-tool-state="succeeded"
        data-expanded={open || undefined}
      >
        <CollapsibleTrigger
          render={(
            <button
              type="button"
              className={AI_TOOL_ROW_CLASS}
              data-ai-node-action=""
              aria-expanded={open}
              aria-label={`${title}: ${summary}`}
            />
          )}
        >
          <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
            <Icon />
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className={AI_DISCLOSURE_TITLE_CLASS}>{title}</span>
          <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
          <span className={AI_DISCLOSURE_SUMMARY_CLASS} title={summary}>
            {summary}
          </span>
          {totalDurationMs !== null && (
            <span className="ai-tool-meta ml-2 inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap">
              <span className="ai-tool-duration">{formatToolDuration(totalDurationMs, t)}</span>
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ai-tool-group-body ml-[22px] flex min-w-0 max-w-[calc(100%-22px)] flex-col gap-1 border-l pt-1 pb-0.5 pl-2.5">
            {tools.map((tool) => (
              <AiToolRow key={tool.key} node={tool} onOpenStoredOutput={onOpenStoredOutput} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function StandardAiToolRow({
  node,
  onOpenStoredOutput,
}: {
  readonly node: ToolNode;
  readonly onOpenStoredOutput?: (node: ToolNode, artifactId: string) => void;
}) {
  const { t } = useI18n();
  const variant = classifyAiTool(node.name, node.nativeName);
  const liveOutput = useToolLiveOutput(node.sessionId, node.callId, variant === 'terminal' && node.state === 'running');
  const [disclosure, setDisclosure] = useState<{ open?: boolean; recoveryKey?: string }>({});
  const autoOpenedRef = useRef(false);
  if (variant === 'terminal' && node.state === 'running' && liveOutput !== null && disclosure.open === undefined) {
    autoOpenedRef.current = true;
  }
  const hasManualChoice = disclosure.open !== undefined && disclosure.recoveryKey === node.recoveredByToolKey;
  const open = hasManualChoice
    ? Boolean(disclosure.open)
    : (autoOpenedRef.current && !node.recoveredByToolKey);
  const setOpen = (next: boolean) => setDisclosure({ open: next, recoveryKey: node.recoveredByToolKey });
  const subagentContext = use(AiSubagentContext);
  const subagentAction = subagentToolAction(node.name, node.nativeName);
  const Icon = subagentAction ? BotIcon : node.name === 'trash_file' ? Trash2Icon : iconFor(variant);
  const stateKey = `ai.workspace.tool.${node.state}` as LocaleKey;
  const subagentSummary = (subagentAction === 'inspect' || subagentAction === 'cancel')
    && !node.recoveredByToolKey
    && node.state !== 'uncertain'
    && node.state !== 'failed'
    && node.state !== 'rejected'
    ? extractSubagentToolSummary(
        node,
        subagentContext?.lineage ?? null,
        subagentContext?.toolChildSessionIds ?? EMPTY_SUBAGENT_ID_MAP,
      )
    : null;
  const readableSubagentTitle = subagentSummary
    && subagentSummary.title.trim() !== ''
    && subagentSummary.title !== subagentSummary.childSessionId
    && subagentSummary.title !== node.name
    && subagentSummary.title !== node.nativeName
    && subagentSummary.title !== 'Agent orchestration'
    ? subagentSummary.title
    : null;
  const summary = subagentSummary
    ? readableSubagentTitle ?? subagentRoleLabel(subagentSummary.role, t)
    : toolDisplaySummary(node, t);
  const hasError = !node.recoveredByToolKey && (node.state === 'failed' || node.state === 'rejected');
  const title = toolTitle(node, variant, t);
  const model = useMemo(() => variant === 'write' || variant === 'edit' ? diffModel(node) : null, [node, variant]);
  const changeStat = model ? diffStat(model) : null;
  const storedOutputId = storedToolOutputId(node);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-tool-row-root flex min-w-0 flex-col"
        data-tool-state={node.state}
        data-tool-recovered={Boolean(node.recoveredByToolKey) || undefined}
        data-tool-variant={variant}
        data-tool-fallback={variant === 'generic' || undefined}
      >
        <span className="sr-only" role="status">{t(node.recoveredByToolKey ? 'ai.workspace.tool.recovered' : stateKey)}</span>
        <CollapsibleTrigger
          render={(
            <button
              type="button"
              className={AI_TOOL_ROW_CLASS}
              data-ai-node-action=""
              aria-label={`${title}: ${summary}${changeStat ? ` ${changeStat}` : ''}`}
            />
          )}
        >
          <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
            {node.state === 'uncertain' ? <CircleHelpIcon /> : hasError
              ? <span className={AI_STATE_DOT_CLASS} data-state="failed" />
              : node.state === 'approval'
                ? <ShieldAlertIcon />
                : <Icon />}
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className={AI_DISCLOSURE_TITLE_CLASS}>{title}</span>
          <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
          <span
            className={AI_DISCLOSURE_SUMMARY_CLASS}
            data-error={hasError || undefined}
          >
            {summary}
          </span>
          {(changeStat || node.durationMs !== null) && (
            <span className="ai-tool-meta ml-2 inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap">
              {changeStat && <span className="ai-tool-diff-stat">{changeStat}</span>}
              {node.durationMs !== null && (
                <span className="ai-tool-duration">{formatToolDuration(node.durationMs, t)}</span>
              )}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ai-tool-body flex min-w-0 max-w-full flex-col">
            <AiToolExpandedContent node={node} compact diffModel={model ?? undefined} />
            {storedOutputId && onOpenStoredOutput && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="mt-1.5 ml-1 shrink-0 self-start"
                onClick={() => onOpenStoredOutput(node, storedOutputId)}
              >
                {t('ai.workspace.details.openStoredOutput')}
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function formatToolDuration(
  durationMs: number,
  t: (key: LocaleKey, values?: Record<string, string | number>) => string,
): string {
  const safeMs = Math.max(0, durationMs);
  if (safeMs < 1_000) return t('ai.workspace.durationMs', { duration: Math.round(safeMs) });
  const seconds = safeMs < 10_000
    ? Math.round(safeMs / 100) / 10
    : Math.round(safeMs / 1_000);
  return seconds < 60
    ? t('ai.workspace.duration.seconds', { seconds })
    : t('ai.workspace.duration.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

export function ToolStateIcon({ node }: { readonly node: ToolNode }) {
  if (node.state === 'uncertain') return <CircleHelpIcon aria-hidden="true" />;
  if (node.state === 'succeeded') return <CheckIcon aria-hidden="true" />;
  if (node.state === 'approval') return <ShieldAlertIcon aria-hidden="true" />;
  if (node.state === 'failed' || node.state === 'rejected') {
    return <span className={AI_STATE_DOT_CLASS} data-state="failed" aria-hidden="true" />;
  }
  return <BracesIcon aria-hidden="true" />;
}

export function toolOutputForCopy(node: ToolNode): string {
  const diagnostic = failureOnly(node);
  if (diagnostic) return diagnostic;
  const output = outputText(node);
  return classifyAiTool(node.name, node.nativeName) === 'terminal' ? renderTerminalTranscript(output) : output;
}
