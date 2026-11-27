import { memo, use, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { applyPatch, diffLines, parsePatch } from 'diff';
import hljs from 'highlight.js/lib/common';
import {
  ArrowUpRightIcon,
  BotIcon,
  BracesIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  Code2Icon,
  CopyIcon,
  FilePenLineIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { aiErrorMessage, httpProbeTimeoutKind } from '@/lib/ai/error-message';
import {
  EMPTY_SANDBOX_DOMAINS,
  restartManagedSandboxTerminalIfOpen,
  useSessionSandboxDomainsStore,
} from '@/lib/terminal/sandbox-terminal';
import { invokeAllowSessionSandboxDomain } from '@/lib/ipc/tauri';
import { renderTerminalTranscript } from '@/lib/terminal/terminal-output-buffer';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useLinkedAgentSessionStatus } from '@/hooks/useLinkedAgentSessionStatus';
import { dispatchAppAction } from '@/lib/app-actions/registry';
import type { AppUiAction } from '@/types/agent-app-action';
import type { AgentSessionRuntimeStatus } from '@/types/agent-session';
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

function mergeTerminalOutput(base: string, observed: string): string {
  if (!observed) return base;
  if (!base || base === observed) return observed;
  const separator = !base.endsWith('\n') && !observed.startsWith('\n') ? '\n' : '';
  return `${base}${separator}${observed}`;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDirectoryEntries(entries: readonly unknown[]): string | null {
  if (entries.length === 0) return '';
  const lines: string[] = [];
  for (const item of entries) {
    if (typeof item === 'string') {
      if (item) lines.push(item);
      continue;
    }
    const entry = asRecord(item);
    const label = firstString(entry, ['name', 'path']);
    if (!label) return null;
    const kind = firstString(entry, ['kind', 'type'])?.toLowerCase();
    lines.push((kind === 'directory' || kind === 'dir') && !label.endsWith('/') ? `${label}/` : label);
  }
  return lines.join('\n');
}

function outputText(node: ToolNode): string {
  const observedOutput = node.backgroundJob?.output ?? '';
  if (node.output === null) return observedOutput;
  if (typeof node.output === 'string') return mergeTerminalOutput(node.output, observedOutput);
  const record = asRecord(node.output);
  const variant = classifyAiTool(node.name, node.nativeName);
  if (record && variant === 'terminal') {
    // Bound terminals have one shared PTY stream. An empty capture is still
    // an output value; it must not fall through to the protocol envelope.
    if (typeof record.combinedOutput === 'string') return mergeTerminalOutput(record.combinedOutput, observedOutput);
    if ((typeof record.stdout === 'string' || typeof record.stderr === 'string')
      && !firstString(record, ['output', 'content', 'text', 'result', 'body', 'data', 'message', 'error'])) {
      const stdout = typeof record.stdout === 'string' ? record.stdout : '';
      const stderr = typeof record.stderr === 'string' ? record.stderr : '';
      const separator = stdout && stderr && !stdout.endsWith('\n') && !stderr.startsWith('\n') ? '\n' : '';
      return mergeTerminalOutput(`${stdout}${separator}${stderr}`, observedOutput);
    }
  }
  if (record && variant === 'read') {
    // Preserve empty/whitespace file content, directory listings, and metadata-only
    // responses instead of falling through to the raw protocol JSON envelope.
    if (typeof record.content === 'string') return mergeTerminalOutput(record.content, observedOutput);
    if (Array.isArray(record.entries)) {
      const formatted = formatDirectoryEntries(record.entries);
      if (formatted !== null) return mergeTerminalOutput(formatted, observedOutput);
    }
    if (record.encoding === 'metadataOnly' || (record.content === null && typeof record.byteLength === 'number')) {
      return observedOutput;
    }
  }
  const direct = firstString(record, [
    'output', 'stdout', 'content', 'text', 'result', 'body', 'data', 'message',
  ]);
  const stderr = firstString(record, ['stderr', 'error']);
  if (direct && stderr && direct !== stderr) return mergeTerminalOutput(`${direct}\n${stderr}`, observedOutput);
  return mergeTerminalOutput(direct ?? stderr ?? formatToolValue(node.output), observedOutput);
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

function toolInputSummary(node: ToolNode, variant: AiToolVariant): string | undefined {
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
  return inputSummary?.split('\n')[0];
}

function toolSummary(node: ToolNode, variant: AiToolVariant): string {
  if (node.state === 'failed' || node.state === 'rejected') {
    const failure = node.error || node.summary || outputText(node);
    if (failure) return failure.split('\n')[0] ?? failure;
  }
  return toolInputSummary(node, variant)
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
    if (translated !== raw) return translated;
    const inputSummary = toolInputSummary(node, variant)
      ?? (node.state === 'rejected' ? node.approval?.prompt?.split('\n')[0] : undefined);
    if (inputSummary) return inputSummary;
    return t(node.state === 'rejected'
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

function FailureSurface({ node, diagnostic, showCopyActions, scrollable, headerAction }: {
  readonly node: ToolNode;
  readonly diagnostic: string;
  readonly showCopyActions: boolean;
  readonly scrollable: boolean;
  readonly headerAction?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="ai-read-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="error">
      {headerAction && (
        <ToolSurfaceHeader title={t('ai.workspace.tool.outputLabel')}>
          {headerAction}
        </ToolSurfaceHeader>
      )}
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
  if (node.name === 'app_inspect' || node.nativeName === 'app_inspect') return t('ai.workspace.tool.title.appInspect');
  if (node.name === 'app_navigate' || node.nativeName === 'app_navigate') return t('ai.workspace.tool.title.appNavigate');
  if (node.name === 'app_propose_action' || node.nativeName === 'app_propose_action') return t('ai.workspace.tool.title.appPropose');
  if (node.name === 'app_terminal' || node.nativeName === 'app_terminal') return t('ai.workspace.tool.title.appTerminal');
  if (node.name === 'app_session' || node.nativeName === 'app_session') return t('ai.workspace.tool.title.appSession');
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

function ToolExecutionFooter({ children, className, succeeded, running }: {
  readonly children: ReactNode;
  readonly className: string;
  readonly succeeded: boolean;
  readonly running?: boolean;
}) {
  return (
    <div className={cn(AI_CONTENT_HEADER_CLASS, 'flex-wrap justify-end', className)}>
      {running ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin" aria-hidden="true" />
        : succeeded && <CheckIcon className="size-3 shrink-0" aria-hidden="true" />}
      {children}
    </div>
  );
}

const LIVE_SCROLL_FOLLOW_THRESHOLD = 8;

function TerminalSurface({ node, showCopyActions, scrollable, showInput, headerAction }: { node: ToolNode; showCopyActions: boolean; scrollable: boolean; showInput: boolean; headerAction?: ReactNode }) {
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
  const observedJob = node.backgroundJob;
  const isBackground = input?.background === true || Boolean(observedJob);
  const outputRecord = asRecord(node.output);
  const rawExecution = firstString(outputRecord, ['execution']);
  const rawState = firstString(outputRecord, ['state']);
  const observedExecution = observedJob
    ? observedJob.observing || observedJob.state === 'running' ? 'running'
      : observedJob.state === 'exited' ? 'completed'
        : observedJob.state === 'rejected' ? 'notStarted'
          : observedJob.state === 'uncertain' ? 'unknown' : null
    : null;
  const execution = observedExecution ?? rawExecution ?? (rawState === 'running' ? 'running' : null);
  const executionLabel: LocaleKey | null = execution === 'running'
    ? (isBackground && !observedJob ? 'ai.workspace.tool.execution.started' : 'ai.workspace.tool.execution.running')
    : execution === 'completed' ? 'ai.workspace.tool.execution.completed'
      : execution === 'notStarted' ? 'ai.workspace.tool.execution.notStarted'
        : execution === 'unknown' ? 'ai.workspace.tool.uncertain' : null;
  const job = asRecord(outputRecord?.job);
  const processHandle = observedJob?.processHandle
    ?? firstString(outputRecord, ['processHandle', 'process_handle'])
    ?? firstString(job, ['processHandle', 'process_handle']);
  const exitCode = execution && execution !== 'completed' ? null
    : observedJob
      ? observedJob.exitCode
      : firstNumber(execution === 'completed' && job ? job : outputRecord, ['exitCode', 'exit_code', 'code']);
  const hasFailedExit = exitCode !== null && exitCode !== 0;
  const succeeded = exitCode === 0;
  const backgroundLaunchOnly = isBackground && !observedJob && execution !== 'completed' && exitCode === null && node.state === 'succeeded';
  const showSuccessIcon = succeeded || (!isBackground && execution === null && exitCode === null && node.state === 'succeeded');
  const showRunningIcon = isBackground && (node.state === 'running' || Boolean(observedJob?.observing));
  const exitStatus = hasFailedExit && <span className="ai-terminal-exit shrink-0">{t('ai.workspace.tool.exitCode', { code: exitCode })}</span>;
  const footerLabel: LocaleKey = succeeded
    ? 'ai.workspace.tool.execution.succeeded'
    : executionLabel ?? (backgroundLaunchOnly ? 'ai.workspace.tool.execution.started' : `ai.workspace.tool.${node.state}` as LocaleKey);
  const showBackgroundNotice = isBackground
    && !output
    && !isAlternateScreen
    && node.state !== 'running'
    && node.state !== 'failed'
    && node.state !== 'rejected'
    && node.state !== 'uncertain'
    && execution !== 'notStarted'
    && execution !== 'unknown'
    && !hasFailedExit;
  const sandboxViolationRecord = asRecord(outputRecord?.sandboxViolation);
  const rawViolationCategory = firstString(sandboxViolationRecord, ['category']);
  const blockedDomains = Array.isArray(sandboxViolationRecord?.blockedDomains)
    ? sandboxViolationRecord.blockedDomains.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const { error: showError, success: showSuccess } = useToast();
  const networkMode = useAiSettingsStore((state) => state.agentSandboxNetworkMode);
  const networkAllowlist = useAiSettingsStore((state) => state.agentSandboxNetworkAllowlist);
  const networkSaving = useAiSettingsStore((state) => state.agentSandboxNetworkSaving);
  const allowSandboxDomain = useAiSettingsStore((state) => state.allowSandboxDomain);
  const sessionSandboxDomains = useSessionSandboxDomainsStore((state) => (
    node.sessionId ? (state.domainsBySession[node.sessionId] ?? EMPTY_SANDBOX_DOMAINS) : EMPTY_SANDBOX_DOMAINS
  ));
  const setSessionDomains = useSessionSandboxDomainsStore((state) => state.setSessionDomains);
  const [sessionAllowSaving, setSessionAllowSaving] = useState(false);
  const sandboxViolationKey: LocaleKey | null = rawViolationCategory === 'networkBlocked'
    ? 'ai.sandbox.violation.networkBlocked'
    : rawViolationCategory === 'filesystemDenied'
      ? 'ai.sandbox.violation.filesystemDenied'
      : rawViolationCategory === 'resourceLimit'
        ? 'ai.sandbox.violation.resourceLimit'
        : null;
  const backgroundNoticeLabel: LocaleKey = observedJob?.state === 'exited'
    ? 'ai.workspace.tool.backgroundCompleted'
    : 'ai.workspace.tool.backgroundStarted';
  const showOutputSection = Boolean(output || isAlternateScreen || showBackgroundNotice || node.state !== 'running');
  const terminalTitle = isBackground ? (
    <span className="inline-flex items-center gap-1.5">
      <span>{t('ai.workspace.tool.shell')}</span>
      <Badge variant="outline" size="sm" data-ai-terminal-background="">
        {t('ai.workspace.tool.background')}
      </Badge>
    </span>
  ) : t('ai.workspace.tool.shell');
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
      data-background={isBackground || undefined}
    >
      <ToolSurfaceHeader className="ai-terminal-header" title={terminalTitle}>
        {usingLive && liveOutput.truncated && !isAlternateScreen && (
          <span className="shrink-0 text-xs text-muted-foreground" data-ai-live-truncated="">
            {t('ai.workspace.tool.showingRecentOutput')}
          </span>
        )}
        {!showInput && <>
          {executionLabel && <span className="shrink-0" data-ai-terminal-execution={execution}>{t(executionLabel)}</span>}
          {exitStatus}
        </>}
        {headerAction}
      </ToolSurfaceHeader>
      <div className="ai-terminal-output relative m-0 min-w-0 max-w-full">
        {showInput && commandTitle}
        {showOutputSection && <div className={showInput ? 'mt-2' : undefined} data-ai-terminal-output>
          {showBackgroundNotice ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3.5 pb-2 text-xs text-muted-foreground" data-ai-terminal-background-notice="">
              <span>{t(backgroundNoticeLabel)}</span>
              {processHandle && (
                <code className="font-mono text-xs opacity-80" data-ai-terminal-handle="">
                  {processHandle}
                </code>
              )}
            </div>
          ) : (
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
          )}
        </div>}
      </div>
      {sandboxViolationKey && (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-destructive/20 bg-destructive/5 px-3.5 py-1.5 text-xs text-destructive"
          data-ai-sandbox-violation={rawViolationCategory ?? undefined}
        >
          <span className="inline-flex items-center gap-1">
            <ShieldAlertIcon className="size-3.5 shrink-0" />
            <span>{t(sandboxViolationKey)}</span>
          </span>
          {blockedDomains.length > 0 && (
            <span className="font-mono opacity-90" data-ai-sandbox-blocked-domains="">
              {t('ai.sandbox.violation.blockedDomains', { domains: blockedDomains.join(', ') })}
            </span>
          )}
          {rawViolationCategory === 'networkBlocked' && blockedDomains.map((domain) => {
            const normalized = domain.trim().toLowerCase();
            const alreadyGlobal = networkMode === 'customAllowlist'
              && networkAllowlist.includes(normalized);
            const alreadySession = sessionSandboxDomains.includes(normalized);
            const alreadyAllowed = alreadyGlobal || alreadySession;
            return (
              <span key={domain} className="inline-flex flex-wrap items-center gap-1">
                {node.sessionId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="text-foreground"
                    disabled={alreadyAllowed || sessionAllowSaving || networkSaving}
                    onClick={() => {
                      const sessionId = node.sessionId;
                      if (!sessionId) return;
                      setSessionAllowSaving(true);
                      void invokeAllowSessionSandboxDomain(sessionId, normalized)
                        .then(async (updatedDomains) => {
                          setSessionDomains(sessionId, updatedDomains);
                          const restartState = await restartManagedSandboxTerminalIfOpen(sessionId, {
                            formatTitle: (shell) => t('terminal.sandbox.tabTitle', { shell }),
                          });
                          if (restartState === 'restarted') {
                            showSuccess(t('ai.sandbox.violation.domainAllowedSessionAndRestarted', { domain: normalized }));
                          } else if (restartState === 'busy' || restartState === 'failed') {
                            showSuccess(t('ai.sandbox.violation.domainAllowedSessionNeedsRestart', { domain: normalized }));
                          } else {
                            showSuccess(t('ai.sandbox.violation.domainAllowedSession', { domain: normalized }));
                          }
                        })
                        .catch(() => showError(t('settings.ai.agent.sandboxNetworkSaveFailed')))
                        .finally(() => setSessionAllowSaving(false));
                    }}
                  >
                    {alreadyAllowed
                      ? t('ai.sandbox.violation.domainAlreadyAllowed', { domain: normalized })
                      : t('ai.sandbox.violation.allowDomainSession', { domain: normalized })}
                  </Button>
                )}
                {!alreadyGlobal && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-foreground"
                    disabled={networkSaving || sessionAllowSaving}
                    onClick={() => {
                      void allowSandboxDomain(domain)
                        .then(async () => {
                          const restartState = node.sessionId
                            ? await restartManagedSandboxTerminalIfOpen(node.sessionId, {
                                formatTitle: (shell) => t('terminal.sandbox.tabTitle', { shell }),
                              })
                            : 'not_open';
                          if (restartState === 'restarted') {
                            showSuccess(t('ai.sandbox.violation.domainAllowedAndRestarted', { domain: normalized }));
                          } else if (restartState === 'busy' || restartState === 'failed') {
                            showSuccess(t('ai.sandbox.violation.domainAllowedNeedsRestart', { domain: normalized }));
                          } else {
                            showSuccess(t('ai.sandbox.violation.domainAllowed', { domain: normalized }));
                          }
                        })
                        .catch(() => showError(t('settings.ai.agent.sandboxNetworkSaveFailed')));
                    }}
                  >
                    {node.sessionId
                      ? t('ai.sandbox.violation.allowDomainGlobal')
                      : t('ai.sandbox.violation.allowDomain', { domain: normalized })}
                  </Button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {showInput && (
        <ToolExecutionFooter className="ai-terminal-footer" succeeded={showSuccessIcon} running={showRunningIcon}>
          {hasFailedExit ? exitStatus : <span data-ai-terminal-execution={execution}>{t(footerLabel)}</span>}
        </ToolExecutionFooter>
      )}
    </div>
  );
}

function ReadSurface({ node, showCopyActions, showInput, scrollable, headerAction }: { node: ToolNode; showCopyActions: boolean; showInput: boolean; scrollable: boolean; headerAction?: ReactNode }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const path = firstString(input, ['path', 'file_path', 'filePath']);
  const label = path
    ?? (node.state === 'failed' || node.state === 'rejected' ? t('ai.workspace.tool.title.read') : node.summary || node.name);
  const outputRecord = asRecord(node.output);
  const output = outputText(node);
  const isDirectoryListing = Array.isArray(outputRecord?.entries);
  const isMetadataOnly = Boolean(
    outputRecord
    && !output
    && (outputRecord.encoding === 'metadataOnly'
      || (outputRecord.content === null && typeof outputRecord.byteLength === 'number')),
  );
  const metadataSummary = useMemo(() => {
    if (!isMetadataOnly || !outputRecord) return null;
    const parts = [t('ai.workspace.tool.readMetadataOnly')];
    const byteLength = firstNumber(outputRecord, ['byteLength', 'sizeBytes']);
    if (byteLength !== null) parts.push(formatByteSize(byteLength));
    if (outputRecord.isBinary === true) parts.push(t('ai.workspace.tool.readBinary'));
    const permissions = firstString(outputRecord, ['permissions']);
    if (permissions) parts.push(permissions);
    return parts.join(t('ai.workspace.turnProcess.separator'));
  }, [isMetadataOnly, outputRecord, t]);
  const emptyNotice = useMemo(() => {
    if (output || metadataSummary) return null;
    if (node.output === null && (node.state === 'preparing' || node.state === 'running')) {
      return t('ai.workspace.tool.reading');
    }
    if (isDirectoryListing) return t('ai.workspace.tool.readEmptyDirectory');
    if (node.output === '' || (outputRecord && typeof outputRecord.content === 'string' && outputRecord.content === '')) {
      return t('ai.workspace.tool.readEmptyFile');
    }
    return null;
  }, [isDirectoryListing, metadataSummary, node.output, node.state, output, outputRecord, t]);
  const preview = bounded(output);
  const lines = preview.split('\n');
  const viewportRef = useRef<HTMLPreElement>(null);
  return (
    <div className="ai-read-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="read">
      {(showInput || Boolean(headerAction)) && (
        <ToolSurfaceHeader title={label}>
          {headerAction}
        </ToolSurfaceHeader>
      )}
      <div className="ai-tool-content-region relative min-w-0" data-ai-copy-region>
        {showCopyActions && output && <AiToolCopyButton text={output} label={t('ai.workspace.tool.copyOutput')} className="top-1 right-3.5" />}
        {metadataSummary ? (
          <div className="px-3.5 pt-1 pb-3 text-xs text-muted-foreground" data-ai-read-metadata="">
            {metadataSummary}
          </div>
        ) : emptyNotice ? (
          <div className="px-3.5 pt-1 pb-3 text-xs text-muted-foreground" data-ai-read-empty="">
            {emptyNotice}
          </div>
        ) : (
          <>
            <pre ref={viewportRef} className={cn(AI_CONTENT_CODE_CLASS, 'ai-read-lines pr-0 whitespace-pre overscroll-x-contain', scrollable ? 'max-h-65 overflow-auto' : 'overflow-visible')} tabIndex={0}>
              {lines.map((line, index) => (
                <span key={index} className="ai-read-line grid min-h-[18px] w-max min-w-full grid-cols-[34px_minmax(max-content,1fr)] pr-3.5 first:pr-12">
                  <span className="ai-read-line-number" aria-hidden="true">{index + 1}</span>
                  <span>{line || '\u00a0'}</span>
                </span>
              ))}
            </pre>
            {scrollable && <AiNativeCodeFade viewportRef={viewportRef} text={preview} />}
          </>
        )}
      </div>
    </div>
  );
}

function SearchSurface({ node, showCopyActions, showInput, scrollable, headerAction }: { node: ToolNode; showCopyActions: boolean; showInput: boolean; scrollable: boolean; headerAction?: ReactNode }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const query = firstString(input, ['query', 'pattern'])
    ?? (node.state === 'failed' || node.state === 'rejected' ? t('ai.workspace.tool.title.search') : node.summary || node.name);
  const output = outputText(node);
  const lines = bounded(output).split('\n').filter(Boolean);
  return (
    <div className="ai-search-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="search">
      {(showInput || Boolean(headerAction)) && (
        <ToolSurfaceHeader title={query} icon={SearchIcon}>
          {headerAction}
        </ToolSurfaceHeader>
      )}
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

function WebSurface({ node, showCopyActions, showInput, scrollable, headerAction }: { node: ToolNode; showCopyActions: boolean; showInput: boolean; scrollable: boolean; headerAction?: ReactNode }) {
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
      {(showInput || Boolean(headerAction)) && (
        <ToolSurfaceHeader title={label} icon={GlobeIcon}>
          {headerAction}
        </ToolSurfaceHeader>
      )}
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
  readonly lineNumbersKnown?: boolean;
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
    const oldText = hunk?.oldText ?? hunk?.old_string ?? hunk?.oldString ?? null;
    const newText = hunk?.newText ?? hunk?.new_string ?? hunk?.newString;
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
  const oldText = input?.old_string ?? input?.oldString ?? input?.oldText ?? null;
  const newText = input?.new_string ?? input?.newString ?? input?.newText ?? input?.content;
  return path && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
    ? [{ path, ...textDiffLines(oldText, newText), ...(oldText === null ? {} : { lineNumbersKnown: false }) }]
    : [];
}

const diffModelCache = new WeakMap<ToolNode, DiffModel>();

function computeDiffModel(node: ToolNode): DiffModel {
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

function diffModel(node: ToolNode): DiffModel {
  const cached = diffModelCache.get(node);
  if (cached) return cached;
  const model = computeDiffModel(node);
  diffModelCache.set(node, model);
  return model;
}

export function toolDiffPreview(node: ToolNode): DiffModel | null {
  const variant = classifyAiTool(node.name, node.nativeName);
  if (variant !== 'write' && variant !== 'edit') return null;
  const diagnostic = failureOnly(node);
  if (diagnostic && !httpProbeTimeoutKind(diagnostic)) return null;
  const model = diffModel(node);
  return model.hunks.length > 0 ? model : null;
}

const MAX_FULL_DIFF_BASE_BYTES = 200_000;

function normalizePatchFileName(fileName: string | undefined): string | null {
  if (!fileName || fileName === '/dev/null') return null;
  return fileName.replace(/^[ab]\//, '');
}

export function applyToolEditToText(text: string, path: string, node: ToolNode): string | null {
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  const unifiedDiff = firstString(output, ['diff']) ?? firstString(input, ['patch']);
  if (unifiedDiff) {
    try {
      const patches = parsePatch(unifiedDiff);
      const matched = patches.length === 1
        ? patches[0]
        : patches.find((patch) => (
          normalizePatchFileName(patch.newFileName) === path
          || normalizePatchFileName(patch.oldFileName) === path
        ));
      if (matched) {
        const patched = applyPatch(text, matched);
        if (patched !== false) return patched;
      }
    } catch {
      // Fall through to direct string replacement if patch parsing fails.
    }
  }
  const oldStr = firstString(input, ['old_string', 'oldString', 'oldText']);
  const newStr = firstString(input, ['new_string', 'newString', 'newText']);
  if (oldStr !== null && newStr !== null) {
    const idx = text.indexOf(oldStr);
    if (idx < 0) return null;
    return `${text.slice(0, idx)}${newStr}${text.slice(idx + oldStr.length)}`;
  }
  const content = firstString(input, ['content']);
  if (content !== null && classifyAiTool(node.name, node.nativeName) === 'write') {
    return content;
  }
  return null;
}

export function buildTurnFileDiffPreview(
  path: string,
  tools: readonly ToolNode[],
  baseText?: string | null,
): DiffModel | null {
  if (typeof baseText === 'string' && baseText.length <= MAX_FULL_DIFF_BASE_BYTES && tools.length > 0) {
    let current: string | null = baseText;
    for (const tool of tools) {
      current = applyToolEditToText(current, path, tool);
      if (current === null) break;
    }
    if (current !== null && current !== baseText) {
      const diff = textDiffLines(baseText, current);
      if (diff.lines.length > 0) {
        return {
          hunks: [{ path, oldStart: 1, newStart: 1, ...diff }],
          totalsKnown: diff.exact,
        };
      }
    }
  }
  const collectedHunks: DiffHunk[] = [];
  let totalsKnown = true;
  for (const tool of tools) {
    const preview = toolDiffPreview(tool);
    if (!preview) continue;
    totalsKnown = totalsKnown && preview.totalsKnown;
    const matchingHunks = preview.hunks.filter((hunk) => hunk.path === path);
    collectedHunks.push(...(matchingHunks.length > 0 ? matchingHunks : preview.hunks));
  }
  if (collectedHunks.length === 0) return null;
  const hunks = collectedHunks.every((hunk) => typeof (hunk.newStart ?? hunk.oldStart) === 'number')
    ? [...collectedHunks].sort((a, b) => (a.newStart ?? a.oldStart ?? 0) - (b.newStart ?? b.oldStart ?? 0))
    : collectedHunks;
  return { hunks, totalsKnown };
}

const DIFF_CONTEXT_RADIUS = 3;
const DIFF_MIN_FOLD_LINES = 4;
const DIFF_EXPAND_STEP = 10;

interface FoldRevealState {
  readonly top: number;
  readonly bottom: number;
  readonly all?: boolean;
}

type NumberedDiffLine = Omit<DiffLine, 'number'> & { readonly number: number | null };

type DiffRowItem =
  | { readonly type: 'line'; readonly line: NumberedDiffLine }
  | { readonly type: 'gap'; readonly hiddenCount: number }
  | {
    readonly type: 'fold';
    readonly id: string;
    readonly remainingCount: number;
    readonly canExpandDown: boolean;
    readonly canExpandUp: boolean;
  };

function foldSegmentLines(
  segmentKey: string,
  lines: readonly NumberedDiffLine[],
  foldReveals: Readonly<Record<string, FoldRevealState>>,
): readonly DiffRowItem[] {
  const hasChanges = lines.some((line) => line.kind !== 'context');
  if (!hasChanges || lines.length < DIFF_MIN_FOLD_LINES) {
    return lines.map((line) => ({ type: 'line', line }));
  }
  const visible = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].kind === 'context') continue;
    const start = Math.max(0, i - DIFF_CONTEXT_RADIUS);
    const end = Math.min(lines.length - 1, i + DIFF_CONTEXT_RADIUS);
    for (let j = start; j <= end; j += 1) visible[j] = true;
  }
  const rows: DiffRowItem[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    if (visible[cursor]) {
      rows.push({ type: 'line', line: lines[cursor] });
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end < lines.length && !visible[end]) end += 1;
    const hidden = lines.slice(cursor, end);
    const foldId = `${segmentKey}:${cursor}-${end}`;
    const reveal = foldReveals[foldId];
    if (hidden.length < DIFF_MIN_FOLD_LINES || reveal?.all) {
      for (const line of hidden) rows.push({ type: 'line', line });
      cursor = end;
      continue;
    }
    const topCount = Math.min(reveal?.top ?? 0, hidden.length);
    const bottomCount = Math.min(reveal?.bottom ?? 0, hidden.length - topCount);
    const remainingCount = hidden.length - topCount - bottomCount;
    for (let i = 0; i < topCount; i += 1) {
      rows.push({ type: 'line', line: hidden[i] });
    }
    if (remainingCount > 0) {
      rows.push({
        type: 'fold',
        id: foldId,
        remainingCount,
        canExpandDown: cursor > 0,
        canExpandUp: end < lines.length,
      });
    }
    for (let i = hidden.length - bottomCount; i < hidden.length; i += 1) {
      rows.push({ type: 'line', line: hidden[i] });
    }
    cursor = end;
  }
  return rows;
}

function buildDiffRows(
  fileKey: string,
  segments: readonly (readonly NumberedDiffLine[])[],
  foldReveals: Readonly<Record<string, FoldRevealState>>,
): readonly DiffRowItem[] {
  const rows: DiffRowItem[] = [];
  for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
    const segment = segments[segIndex];
    if (segIndex > 0 && segment.length > 0) {
      const previous = segments[segIndex - 1];
      const prevEnd = previous[previous.length - 1]?.number;
      const nextStart = segment[0]?.number;
      if (typeof prevEnd === 'number' && typeof nextStart === 'number' && nextStart > prevEnd + 1) {
        rows.push({ type: 'gap', hiddenCount: nextStart - prevEnd - 1 });
      }
    }
    rows.push(...foldSegmentLines(`${fileKey}:${segIndex}`, segment, foldReveals));
  }
  return rows;
}

function DiffSurface({ node, compact, model, showCopyActions, scrollable, copyAction, showInput, hideHeader = false, foldContext = false, headerAction }: { node: ToolNode; compact: boolean; model?: DiffModel; showCopyActions: boolean; scrollable: boolean; copyAction?: ReactNode; showInput: boolean; hideHeader?: boolean; foldContext?: boolean; headerAction?: ReactNode }) {
  const { t } = useI18n();
  const [foldReveals, setFoldReveals] = useState<Readonly<Record<string, FoldRevealState>>>(() => ({}));
  const currentModel = useMemo(() => model ?? diffModel(node), [model, node]);
  const hunks = useMemo(() => currentModel.hunks.map((hunk) => {
    if (hunk.lineNumbersKnown === false) {
      return {
        ...hunk,
        lines: hunk.lines.map((line): NumberedDiffLine => ({ ...line, number: null })),
      };
    }
    let oldNumber = hunk.oldStart ?? 1;
    let newNumber = hunk.newStart ?? 1;
    return { ...hunk, lines: hunk.lines.map((line): NumberedDiffLine => {
      const number = line.kind === 'removed' ? oldNumber : newNumber;
      if (line.kind !== 'added') oldNumber += 1;
      if (line.kind !== 'removed') newNumber += 1;
      return { ...line, number };
    }) };
  }), [currentModel]);
  const files = useMemo(() => {
    const grouped = new Map<string, {
      path: string;
      exact: boolean;
      added: number;
      removed: number;
      segments: (readonly NumberedDiffLine[])[];
    }>();
    for (const hunk of hunks) {
      const added = hunk.lines.filter((line) => line.kind === 'added').length;
      const removed = hunk.lines.filter((line) => line.kind === 'removed').length;
      const previous = grouped.get(hunk.path);
      if (previous) {
        previous.exact = previous.exact && hunk.exact;
        previous.added += added;
        previous.removed += removed;
        previous.segments.push(hunk.lines);
      } else {
        grouped.set(hunk.path, {
          path: hunk.path,
          exact: hunk.exact,
          added,
          removed,
          segments: [hunk.lines],
        });
      }
    }
    return [...grouped.values()];
  }, [hunks]);
  const copyText = firstString(asRecord(node.output), ['diff', 'patch', 'unified_diff'])
    ?? firstString(asRecord(node.input), ['patch', 'diff'])
    ?? outputText(node);
  if (hunks.length === 0) {
    if (node.output === null && (node.state === 'preparing' || node.state === 'running')) {
      const pendingPath = toolFilePath(node);
      const hasPendingHeader = !hideHeader && (Boolean(pendingPath) || Boolean(headerAction));
      return (
        <div
          className={cn(
            'ai-diff-block flex min-w-0 flex-col gap-px overflow-hidden',
            hideHeader ? 'w-full max-w-full' : 'my-1 ml-1 max-w-[calc(100%-4px)]',
          )}
          data-ai-tool-view="diff"
          data-embedded={hideHeader || undefined}
        >
          <section className="min-w-0 max-w-full shrink-0">
            {hasPendingHeader && (
              <ToolSurfaceHeader title={pendingPath ?? node.name} className={showInput ? undefined : 'min-h-8'}>
                {headerAction}
              </ToolSurfaceHeader>
            )}
            <div className={cn(hasPendingHeader ? 'px-3.5 pt-1 pb-3' : 'px-3.5 py-2.5', 'text-xs text-muted-foreground')} data-diff-pending="">
              {t(node.state === 'preparing' ? 'ai.workspace.tool.preparing' : 'ai.workspace.tool.running')}
            </div>
          </section>
        </div>
      );
    }
    return <IoSurface node={node} compact={compact} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} headerAction={headerAction} />;
  }
  return (
    <div
      className={cn(
        'ai-diff-block flex min-w-0 flex-col gap-px overflow-hidden',
        hideHeader ? 'w-full max-w-full' : 'my-1 ml-1 max-w-[calc(100%-4px)]',
      )}
      data-ai-tool-view="diff"
      data-embedded={hideHeader || undefined}
    >
      {files.map((hunk, index) => {
        const rows = foldContext
          ? buildDiffRows(`${hunk.path}:${index}`, hunk.segments, foldReveals)
          : hunk.segments.flatMap((segment) => segment.map((line): DiffRowItem => ({ type: 'line', line })));
        return (
          <section key={`${hunk.path}:${index}`} className="min-w-0 max-w-full shrink-0">
            {(!hideHeader || files.length > 1) && (
              <ToolSurfaceHeader title={hunk.path} className={showInput ? undefined : 'min-h-8'}>
                {hunk.exact && currentModel.totalsKnown && <span className="ai-diff-counts shrink-0">
                  <span data-diff-count="added">+{hunk.added}</span>{' '}
                  <span data-diff-count="removed">-{hunk.removed}</span>
                </span>}
                {index === 0 && headerAction}
              </ToolSurfaceHeader>
            )}
            <AiToolContentRegion text={showCopyActions && index === 0 ? copyText : undefined} label={t('ai.workspace.tool.copyOutput')}>
              <ToolScrollArea className="ai-diff-content max-h-65 min-w-0 max-w-full" viewportClassName={showInput ? TOOL_OUTPUT_FADE_CLASS : undefined} scrollable={scrollable}>
                {!hunk.exact && <div className="px-2.5 py-1 text-xs text-muted-foreground" data-diff-simplified>
                  {t('ai.workspace.tool.diffSimplified')}
                </div>}
                <pre className="ai-diff-body m-0 min-w-0 max-w-full pt-px whitespace-pre" aria-label={hunk.path}>
                  <code className="ai-diff-lines">
                    {rows.map((row, rowIndex) => {
                      if (row.type === 'fold') {
                        const expandAll = () => setFoldReveals((prev) => ({
                          ...prev,
                          [row.id]: { top: 0, bottom: 0, all: true },
                        }));
                        const expandDown = () => setFoldReveals((prev) => {
                          const cur = prev[row.id] ?? { top: 0, bottom: 0 };
                          return { ...prev, [row.id]: { ...cur, top: cur.top + DIFF_EXPAND_STEP } };
                        });
                        const expandUp = () => setFoldReveals((prev) => {
                          const cur = prev[row.id] ?? { top: 0, bottom: 0 };
                          return { ...prev, [row.id]: { ...cur, bottom: cur.bottom + DIFF_EXPAND_STEP } };
                        });
                        const showStepper = row.remainingCount > DIFF_EXPAND_STEP && (row.canExpandDown || row.canExpandUp);
                        const GutterIcon = row.canExpandDown && row.canExpandUp
                          ? ChevronsUpDownIcon
                          : row.canExpandUp
                            ? ChevronUpIcon
                            : ChevronDownIcon;
                        return (
                          <span key={row.id} data-diff="fold" className="ai-diff-fold-row">
                            <span
                              className="ai-diff-fold-gutter"
                              aria-hidden="true"
                              onClick={expandAll}
                            >
                              <GutterIcon className="inline-block size-3 align-[-2px]" />
                            </span>
                            <span className="ai-diff-fold-cell table-cell align-middle">
                              <span className="ai-diff-fold-bar flex h-[26px] w-full items-center justify-between gap-2">
                                <button
                                  type="button"
                                  className="ai-diff-fold-main flex h-full min-w-0 flex-1 items-center px-3 text-left"
                                  onClick={expandAll}
                                >
                                  {t('ai.workspace.tool.diffExpandLines', { count: row.remainingCount })}
                                </button>
                                {showStepper && (
                                  <span className="ai-diff-fold-steps flex shrink-0 items-center gap-0.5 pr-3.5">
                                    {row.canExpandDown && (
                                      <button
                                        type="button"
                                        className="ai-diff-fold-step inline-flex h-5 items-center gap-0.5 px-1.5 tabular-nums"
                                        aria-label={t('ai.workspace.tool.diffExpandDown', { count: DIFF_EXPAND_STEP })}
                                        title={t('ai.workspace.tool.diffExpandDown', { count: DIFF_EXPAND_STEP })}
                                        onClick={expandDown}
                                      >
                                        <ChevronDownIcon className="size-3 shrink-0" aria-hidden="true" />
                                        <span>+{DIFF_EXPAND_STEP}</span>
                                      </button>
                                    )}
                                    {row.canExpandUp && (
                                      <button
                                        type="button"
                                        className="ai-diff-fold-step inline-flex h-5 items-center gap-0.5 px-1.5 tabular-nums"
                                        aria-label={t('ai.workspace.tool.diffExpandUp', { count: DIFF_EXPAND_STEP })}
                                        title={t('ai.workspace.tool.diffExpandUp', { count: DIFF_EXPAND_STEP })}
                                        onClick={expandUp}
                                      >
                                        <ChevronUpIcon className="size-3 shrink-0" aria-hidden="true" />
                                        <span>+{DIFF_EXPAND_STEP}</span>
                                      </button>
                                    )}
                                  </span>
                                )}
                              </span>
                            </span>
                          </span>
                        );
                      }
                      if (row.type === 'gap') {
                        return (
                          <span key={`gap:${rowIndex}`} data-diff="gap" className="ai-diff-gap-row">
                            <span className="ai-diff-fold-gutter" aria-hidden="true">⋯</span>
                            <span className="ai-diff-gap-cell table-cell align-middle">
                              <span className="ai-diff-fold-bar flex h-6 w-full items-center px-3">
                                {t('ai.workspace.tool.diffOmittedLines', { count: row.hiddenCount })}
                              </span>
                            </span>
                          </span>
                        );
                      }
                      return (
                        <span key={`${row.line.kind}:${row.line.number ?? 'x'}:${rowIndex}`} data-diff={row.line.kind}>
                          <span className="ai-diff-line-number" aria-hidden="true">
                            {row.line.number ?? (row.line.kind === 'removed' ? '-' : row.line.kind === 'added' ? '+' : '\u00a0')}
                          </span>
                          <DiffCode text={row.line.text} path={hunk.path} />
                        </span>
                      );
                    })}
                  </code>
                </pre>
              </ToolScrollArea>
              {index === 0 && copyAction}
            </AiToolContentRegion>
          </section>
        );
      })}
    </div>
  );
}

const DiffCode = memo(function DiffCode({ text, path }: { text: string; path: string }) {
  const html = useMemo(() => {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const language = ({ tsx: 'typescript', jsx: 'javascript', vue: 'xml', svg: 'xml', mjs: 'javascript', cjs: 'javascript' } as Record<string, string>)[extension] ?? extension;
    if (text.length > 10_000 || !hljs.getLanguage(language)) return null;
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  }, [text, path]);
  // Only highlight.js-generated, escaped markup is inserted; unknown languages stay plain text.
  return html === null ? <span className="ai-diff-code table-cell px-3">{text || '\u00a0'}</span>
    : <span className="ai-diff-code table-cell px-3" dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />;
});

function CodeSurface({ node, showCopyActions, scrollable, showInput, headerAction }: { node: ToolNode; showCopyActions: boolean; scrollable: boolean; showInput: boolean; headerAction?: ReactNode }) {
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
      {showInput ? <>
        <ToolSurfaceHeader title={language} titleClassName="ai-code-block-language">
          {headerAction}
        </ToolSurfaceHeader>
        <AiToolContentRegion text={showCopyActions ? code : undefined} label={t('ai.workspace.tool.copyInput')} showCopiedTooltip={false}>
          <ToolScrollArea className="ai-code-content max-h-65 min-w-0 max-w-full" viewportClassName={TOOL_OUTPUT_FADE_CLASS} scrollable={scrollable} label={language}>
            <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-code-block-pre ai-tool-text whitespace-pre-wrap [overflow-wrap:anywhere]')}><code>{bounded(code)}</code></pre>
          </ToolScrollArea>
        </AiToolContentRegion>
      </> : headerAction ? (
        <ToolSurfaceHeader title={outputLabel}>
          {headerAction}
        </ToolSurfaceHeader>
      ) : null}
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

type PlanStepStatus = 'completed' | 'inProgress' | 'pending' | 'blocked' | 'failed';

interface PlanSurfaceStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly status: PlanStepStatus;
}

const PLAN_STATUS_ORDER: readonly PlanStepStatus[] = [
  'completed',
  'inProgress',
  'pending',
  'blocked',
  'failed',
];

function normalizePlanStepStatus(value: unknown): PlanStepStatus {
  if (value === 'in_progress' || value === 'inProgress') return 'inProgress';
  if (value === 'completed' || value === 'blocked' || value === 'failed') return value;
  return 'pending';
}

function PlanStepStatusIcon({ status }: { readonly status: PlanStepStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2Icon data-status="completed" />;
    case 'inProgress':
      return <LoaderCircleIcon data-status="inProgress" />;
    case 'blocked':
    case 'failed':
      return <OctagonAlertIcon data-status={status} />;
    case 'pending':
      return <CircleDashedIcon data-status="pending" />;
  }
}

function extractPlanSurfaceData(node: ToolNode): {
  readonly explanation: string | null;
  readonly steps: readonly PlanSurfaceStep[];
  readonly counts: Readonly<Record<PlanStepStatus, number>>;
  readonly planVersion: number | null;
} {
  const input = asRecord(node.input);
  const output = asRecord(node.output);
  const explanation = firstString(input, ['explanation'])?.trim() || null;
  const rawSteps = Array.isArray(input?.steps) && input.steps.length > 0
    ? input.steps
    : Array.isArray(output?.steps) && output.steps.length > 0
      ? output.steps
      : [];
  const steps: PlanSurfaceStep[] = rawSteps.flatMap((rawStep, index) => {
    const step = asRecord(rawStep);
    const title = firstString(step, ['title', 'step', 'id']);
    if (!title) return [];
    const detail = firstString(step, ['detail', 'description'])?.trim() || null;
    const id = firstString(step, ['id']) ?? `step-${index}`;
    return [{ id, title, detail, status: normalizePlanStepStatus(step?.status) }];
  });

  const outputCounts = asRecord(output?.counts);
  const counts: Record<PlanStepStatus, number> = {
    completed: 0,
    inProgress: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
  };
  if (outputCounts) {
    counts.completed = firstNumber(outputCounts, ['completed']) ?? 0;
    counts.inProgress = firstNumber(outputCounts, ['inProgress', 'in_progress']) ?? 0;
    counts.pending = firstNumber(outputCounts, ['pending']) ?? 0;
    counts.blocked = firstNumber(outputCounts, ['blocked']) ?? 0;
    counts.failed = firstNumber(outputCounts, ['failed']) ?? 0;
  } else {
    for (const step of steps) {
      counts[step.status] += 1;
    }
  }
  const planVersion = firstNumber(output, ['planVersion', 'version']);
  return { explanation, steps, counts, planVersion };
}

function PlanSurface({ node, compact, showCopyActions, scrollable, showInput, headerAction }: {
  readonly node: ToolNode;
  readonly compact: boolean;
  readonly showCopyActions: boolean;
  readonly scrollable: boolean;
  readonly showInput: boolean;
  readonly headerAction?: ReactNode;
}) {
  const { t } = useI18n();
  const { explanation, steps, counts, planVersion } = useMemo(() => extractPlanSurfaceData(node), [node]);
  const progressParts = PLAN_STATUS_ORDER.flatMap((status) => (
    counts[status] > 0 ? [t(`ai.workspace.tasks.${status}`, { count: counts[status] })] : []
  ));
  const progressText = progressParts.join(t('ai.workspace.turnProcess.separator'));
  const hasStructuredContent = Boolean(explanation || steps.length > 0 || progressText);
  if (node.state === 'failed' || node.state === 'rejected' || !hasStructuredContent) {
    return <IoSurface node={node} compact={compact} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} headerAction={headerAction} />;
  }

  const copyLines: string[] = [];
  if (explanation) copyLines.push(explanation);
  for (const step of steps) {
    const statusLabel = t(`ai.workspace.tasks.status.${step.status}`);
    copyLines.push(`- [${statusLabel}] ${step.title}`);
    if (step.detail) copyLines.push(`  ${step.detail}`);
  }
  if (copyLines.length === 0 && progressText) copyLines.push(progressText);
  const copyText = copyLines.join('\n');

  return (
    <div className="ai-plan-block my-1 ml-1 min-w-0 max-w-[calc(100%-4px)] overflow-hidden" data-ai-tool-view="plan">
      <ToolSurfaceHeader
        title={(
          <span className="inline-flex min-w-0 items-baseline gap-1.5">
            <span className="truncate">{progressText || t('ai.workspace.tasks.title')}</span>
            {planVersion !== null && (
              <span className="ai-plan-version shrink-0 text-[11px] tabular-nums">
                v{planVersion}
              </span>
            )}
          </span>
        )}
        copyText={showCopyActions && copyText ? copyText : undefined}
        copyLabel={t('ai.workspace.tool.copyOutput')}
      >
        {headerAction}
      </ToolSurfaceHeader>
      {(explanation || steps.length > 0) && (
        <ToolScrollArea
          className="ai-plan-content max-h-65 min-w-0 max-w-full"
          contentClassName="flex min-w-0 flex-col gap-2 px-3.5 pt-1 pb-3"
          viewportClassName={TOOL_OUTPUT_FADE_CLASS}
          scrollable={scrollable}
          horizontal={false}
          label={t('ai.workspace.tasks.title')}
        >
          {explanation && (
            <p className="ai-plan-explanation m-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-xs leading-5">
              {explanation}
            </p>
          )}
          {steps.length > 0 && (
            <ul className="ai-plan-steps m-0 flex list-none flex-col gap-1.5 p-0">
              {steps.map((step) => (
                <li
                  key={step.id}
                  className="ai-plan-step flex min-w-0 items-start gap-1"
                  data-status={step.status}
                >
                  <span className="ai-plan-step-status mt-0.5 grid size-4 shrink-0 place-items-center" aria-hidden="true">
                    <PlanStepStatusIcon status={step.status} />
                  </span>
                  <span className="sr-only">{t(`ai.workspace.tasks.status.${step.status}`)}: </span>
                  <div className="min-w-0 flex-1">
                    <div className="ai-plan-step-title [overflow-wrap:anywhere] text-xs leading-5">
                      {step.title}
                    </div>
                    {step.detail && (
                      <div className="ai-plan-step-detail mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] leading-4">
                        {step.detail}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ToolScrollArea>
      )}
    </div>
  );
}

function IoSurface({ node, showCopyActions, scrollable, showInput = true, headerAction }: {
  node: ToolNode;
  compact: boolean;
  showCopyActions: boolean;
  scrollable: boolean;
  showInput?: boolean;
  headerAction?: ReactNode;
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
      {(output || Boolean(headerAction)) && (
        <div className="ai-io-section min-w-0 shrink-0 overflow-hidden">
          {(showInput || showCopyActions || Boolean(headerAction)) && (
            <ToolSurfaceHeader title={t('ai.workspace.tool.outputLabel')} titleClassName={showInput ? 'ai-io-label' : undefined}>
              {headerAction}
            </ToolSurfaceHeader>
          )}
          {output && (
            <AiToolContentRegion text={showCopyActions ? outputText(node) : undefined} label={t('ai.workspace.tool.copyOutput')}>
              <ToolScrollArea className="ai-io-output max-h-65 min-w-0 max-w-full" scrollable={scrollable}>
                <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-io-text whitespace-pre-wrap [overflow-wrap:anywhere]')} data-error={node.state === 'failed' || undefined}>
                  {output}
                </pre>
              </ToolScrollArea>
            </AiToolContentRegion>
          )}
        </div>
      )}
    </div>
  );
}

function TrashSurface({ node, showCopyActions, scrollable, showInput, headerAction }: { readonly node: ToolNode; readonly showCopyActions: boolean; readonly scrollable: boolean; readonly showInput: boolean; readonly headerAction?: ReactNode }) {
  if (node.state !== 'succeeded') return <IoSurface node={node} compact={false} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} headerAction={headerAction} />;
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
  hideHeader = false,
  foldContext = false,
  scrollable = true,
  diffModel: precomputedDiff,
  diffCopyAction,
  headerAction,
}: {
  readonly node: ToolNode;
  readonly compact?: boolean;
  readonly showCopyActions?: boolean;
  readonly showInput?: boolean;
  readonly hideHeader?: boolean;
  readonly foldContext?: boolean;
  readonly scrollable?: boolean;
  readonly diffModel?: DiffModel;
  readonly diffCopyAction?: ReactNode;
  readonly headerAction?: ReactNode;
}) {
  const variant = classifyAiTool(node.name, node.nativeName);
  const diagnostic = failureOnly(node);
  if (diagnostic && !httpProbeTimeoutKind(diagnostic)) {
    return <FailureSurface node={node} diagnostic={diagnostic} showCopyActions={showCopyActions} scrollable={scrollable} headerAction={headerAction} />;
  }
  if (node.name === 'trash_file') return <TrashSurface node={node} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} headerAction={headerAction} />;
  switch (variant) {
    case 'terminal': return <TerminalSurface node={node} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} headerAction={headerAction} />;
    case 'read': return <ReadSurface node={node} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} headerAction={headerAction} />;
    case 'search': return <SearchSurface node={node} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} headerAction={headerAction} />;
    case 'web': return <WebSurface node={node} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} headerAction={headerAction} />;
    case 'write':
    case 'edit': return <DiffSurface node={node} compact={compact} model={precomputedDiff} showCopyActions={showCopyActions} scrollable={scrollable} copyAction={diffCopyAction} showInput={showInput} hideHeader={hideHeader} foldContext={foldContext} headerAction={headerAction} />;
    case 'code': return <CodeSurface node={node} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} headerAction={headerAction} />;
    case 'plan': return <PlanSurface node={node} compact={compact} showCopyActions={showCopyActions} scrollable={scrollable} showInput={showInput} headerAction={headerAction} />;
    case 'generic': return <IoSurface node={node} compact={compact} showCopyActions={showCopyActions} showInput={showInput} scrollable={scrollable} headerAction={headerAction} />;
  }
}

export function AiToolRow({
  node,
  onOpenStoredOutput: _onOpenStoredOutput,
}: {
  readonly node: ToolNode;
  readonly onOpenStoredOutput?: (node: ToolNode, artifactId: string) => void;
}) {
  if (isSubagentDelegationTool(node.name, node.nativeName)) {
    return <AiSubagentToolCard node={node} />;
  }
  return <StandardAiToolRow node={node} />;
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

function extractAppActionFromToolOutput(node: ToolNode): {
  readonly action: AppUiAction;
  readonly labelKey: LocaleKey;
  readonly linkedSessionId: string | null;
  readonly initialSessionStatus: AgentSessionRuntimeStatus | null;
} | null {
  if (node.state !== 'succeeded') return null;
  if (
    node.name !== 'app_navigate'
    && node.name !== 'app_propose_action'
    && node.name !== 'app_terminal'
    && node.name !== 'app_session'
  ) {
    return null;
  }
  const record = asRecord(node.output);
  const action = asRecord(record?.action);
  if (!action || typeof action.type !== 'string') return null;
  const labelKey: LocaleKey = node.name === 'app_propose_action' || action.type === 'openProposalDraft'
    ? 'ai.workspace.appAction.openDraft'
    : node.name === 'app_session' || action.type === 'openAgentSession'
      ? 'ai.workspace.appAction.openSession'
      : node.name === 'app_terminal'
        ? 'ai.workspace.appAction.openTerminal'
        : 'ai.workspace.appAction.open';
  const linkedSessionId = action.type === 'openAgentSession' && typeof action.agentSessionId === 'string'
    ? action.agentSessionId
    : null;
  const initialSessionStatus: AgentSessionRuntimeStatus | null = linkedSessionId
    ? (record?.started === true ? 'running' : record?.requiresManualStart === true ? 'idle' : null)
    : null;
  return {
    action: action as unknown as AppUiAction,
    labelKey,
    linkedSessionId,
    initialSessionStatus,
  };
}

function sessionStatusBadgeVariant(
  status: AgentSessionRuntimeStatus,
): React.ComponentProps<typeof Badge>['variant'] {
  if (status === 'failed') return 'destructive';
  if (status === 'running' || status === 'waiting') return 'secondary';
  return 'outline';
}

function AppActionCardBar({
  action,
  labelKey,
  linkedSessionId,
  initialSessionStatus,
}: {
  readonly action: AppUiAction;
  readonly labelKey: LocaleKey;
  readonly linkedSessionId: string | null;
  readonly initialSessionStatus: AgentSessionRuntimeStatus | null;
}) {
  const { t } = useI18n();
  const liveStatus = useLinkedAgentSessionStatus(linkedSessionId, initialSessionStatus);
  return (
    <div className="ml-[22px] mt-1 flex flex-wrap items-center gap-1.5" data-app-action-card="">
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="gap-1"
        onClick={() => dispatchAppAction(action, { source: 'user' })}
      >
        <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
        <span>{t(labelKey)}</span>
      </Button>
      {liveStatus && (
        <Badge
          variant={sessionStatusBadgeVariant(liveStatus)}
          className="h-5 gap-1 px-1.5 text-[11px]"
          data-app-session-status={liveStatus}
        >
          {liveStatus === 'running' && (
            <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
          )}
          <span>{t(`ai.workspace.appAction.sessionStatus.${liveStatus}` as LocaleKey)}</span>
        </Badge>
      )}
    </div>
  );
}

function StandardAiToolRow({
  node,
}: {
  readonly node: ToolNode;
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
  const subagentAction = subagentToolAction(node.name, node.nativeName);
  const subagentContext = subagentAction ? use(AiSubagentContext) : null;
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
  const linkedJob = node.linkedBackgroundJob;
  const linkedJobSummary = linkedJob
    ? node.state === 'running'
      ? t('ai.workspace.tool.running')
      : linkedJob.observedState === 'exited' && linkedJob.exitCode !== null && linkedJob.exitCode !== 0
        ? t('ai.workspace.tool.exitCode', { code: linkedJob.exitCode })
        : linkedJob.observedState === 'exited'
          ? t('ai.workspace.tool.backgroundJob.completed')
          : linkedJob.observedState === 'running'
            ? t('ai.workspace.tool.execution.running')
            : linkedJob.observedState === 'rejected'
              ? t('ai.workspace.tool.execution.notStarted')
              : linkedJob.observedState === 'uncertain'
                ? t('ai.workspace.tool.uncertain')
                : t(stateKey)
    : null;
  const summary = linkedJobSummary
    ?? (subagentSummary
      ? readableSubagentTitle ?? subagentRoleLabel(subagentSummary.role, t)
      : toolDisplaySummary(node, t));
  const hasError = !node.recoveredByToolKey && (node.state === 'failed' || node.state === 'rejected');
  const statusLabel = hasError ? t(stateKey) : null;
  const showStatusLabel = Boolean(statusLabel && summary !== statusLabel);
  const title = linkedJob
    ? t(linkedJob.action === 'kill' ? 'ai.workspace.tool.title.stopBackgroundJob' : 'ai.workspace.tool.title.checkBackgroundJob')
    : toolTitle(node, variant, t);
  const model = useMemo(() => variant === 'write' || variant === 'edit' ? diffModel(node) : null, [node, variant]);
  const changeStat = model ? diffStat(model) : null;
  const appActionCard = useMemo(() => extractAppActionFromToolOutput(node), [node]);
  if (linkedJob && !hasError && node.state !== 'uncertain') {
    return (
      <div
        className="ai-tool-row-root flex min-w-0 flex-col"
        data-tool-state={node.state}
        data-tool-variant={variant}
        data-tool-linked-background-job={linkedJob.processHandle}
      >
        <span className="sr-only" role="status">{t(stateKey)}</span>
        <div className={AI_TOOL_ROW_CLASS}>
          <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
            {node.state === 'running' ? <LoaderCircleIcon className="animate-spin" /> : <Icon />}
          </span>
          <span className={AI_DISCLOSURE_TITLE_CLASS}>{title}</span>
          <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
          <span className={AI_DISCLOSURE_SUMMARY_CLASS}>{summary}</span>
          {node.durationMs !== null && (
            <span className="ai-tool-meta ml-2 inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap">
              <span className="ai-tool-duration">{formatToolDuration(node.durationMs, t)}</span>
            </span>
          )}
        </div>
      </div>
    );
  }
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
          {(changeStat || showStatusLabel || node.durationMs !== null) && (
            <span className="ai-tool-meta ml-2 inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap">
              {changeStat && <span className="ai-tool-diff-stat">{changeStat}</span>}
              {showStatusLabel && (
                <span className="ai-subagent-row-meta" data-state="failed">{statusLabel}</span>
              )}
              {node.durationMs !== null && (
                <span className="ai-tool-duration">{formatToolDuration(node.durationMs, t)}</span>
              )}
            </span>
          )}
        </CollapsibleTrigger>
        {appActionCard && (
          <AppActionCardBar
            action={appActionCard.action}
            labelKey={appActionCard.labelKey}
            linkedSessionId={appActionCard.linkedSessionId}
            initialSessionStatus={appActionCard.initialSessionStatus}
          />
        )}
        <CollapsibleContent>
          <div className="ai-tool-body flex min-w-0 max-w-full flex-col">
            <AiToolExpandedContent
              node={node}
              compact
              diffModel={model ?? undefined}
            />
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
