import { useMemo, useState, type ComponentType } from 'react';
import {
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  Code2Icon,
  CopyIcon,
  FilePenLineIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareTerminalIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { cn } from '@/lib/utils';
import type { LocaleKey } from '@/locales';

export type AiToolVariant =
  | 'terminal'
  | 'read'
  | 'search'
  | 'web'
  | 'write'
  | 'edit'
  | 'code'
  | 'generic';

type ToolNode = AiConversationNodeOf<'tool'>;
type UnknownRecord = Record<string, unknown>;

const DETAIL_LIMIT = 64 * 1024;

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
  const direct = firstString(record, [
    'output', 'stdout', 'content', 'text', 'result', 'body', 'data', 'message',
  ]);
  const stderr = firstString(record, ['stderr', 'error']);
  if (direct && stderr && direct !== stderr) return `${direct}\n${stderr}`;
  return direct ?? stderr ?? formatToolValue(node.output);
}

export function classifyAiTool(name: string): AiToolVariant {
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

function iconFor(variant: AiToolVariant): ComponentType<React.SVGProps<SVGSVGElement>> {
  switch (variant) {
    case 'terminal': return SquareTerminalIcon;
    case 'read': return FileTextIcon;
    case 'search': return SearchIcon;
    case 'web': return GlobeIcon;
    case 'write': return FilePenLineIcon;
    case 'edit': return FileSearchIcon;
    case 'code': return Code2Icon;
    case 'generic': return SparklesIcon;
  }
}

function titleKey(variant: AiToolVariant): LocaleKey {
  return `ai.workspace.tool.title.${variant}` as LocaleKey;
}

function toolSummary(node: ToolNode, variant: AiToolVariant): string {
  if (node.error) return node.error.split('\n')[0] ?? node.error;
  if (node.summary) return node.summary.split('\n')[0] ?? node.summary;
  const input = asRecord(node.input);
  const keys: Record<AiToolVariant, readonly string[]> = {
    terminal: ['description', 'explanation', 'command', 'cmd'],
    read: ['path', 'file_path', 'filePath', 'url'],
    search: ['query', 'pattern', 'path'],
    web: ['query', 'url'],
    write: ['path', 'file_path', 'filePath'],
    edit: ['path', 'file_path', 'filePath'],
    code: ['description', 'language'],
    generic: ['description', 'explanation', 'summary', 'intent'],
  };
  return firstString(input, keys[variant])?.split('\n')[0] ?? node.name;
}

function CappedText({ text, maxLines = 8 }: { text: string; maxLines?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => bounded(text).split('\n'), [text]);
  if (expanded || lines.length <= maxLines) {
    return (
      <>
        {lines.map((line, index) => <div key={index} className="ai-block-line">{line || '\u00a0'}</div>)}
        {lines.length > maxLines && (
          <button type="button" className="ai-block-fold" onClick={() => setExpanded(false)}>
            {t('ai.workspace.tool.collapse')}
          </button>
        )}
      </>
    );
  }
  const head = Math.ceil(maxLines / 2);
  const tail = Math.floor(maxLines / 2);
  const hidden = lines.length - head - tail;
  return (
    <>
      {lines.slice(0, head).map((line, index) => (
        <div key={`head-${index}`} className="ai-block-line">{line || '\u00a0'}</div>
      ))}
      <button type="button" className="ai-block-fold" onClick={() => setExpanded(true)}>
        {t('ai.workspace.tool.expand', { count: hidden })}
      </button>
      {lines.slice(-tail).map((line, index) => (
        <div key={`tail-${index}`} className="ai-block-line">{line || '\u00a0'}</div>
      ))}
    </>
  );
}

function CopyTextButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ai-block-copy"
      aria-label={copied ? t('common.copied') : t('common.copy')}
      onClick={() => {
        if (!navigator.clipboard || copied) return;
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_000);
        }).catch(() => undefined);
      }}
    >
      {copied ? t('common.copied') : t('common.copy')}
    </button>
  );
}

function TerminalSurface({ node, compact }: { node: ToolNode; compact: boolean }) {
  const { t } = useI18n();
  const input = asRecord(node.input);
  const output = outputText(node);
  const command = firstString(input, ['command', 'cmd', 'script']) ?? formatToolValue(node.input);
  const outputRecord = asRecord(node.output);
  const exitCode = firstNumber(outputRecord, ['exitCode', 'exit_code', 'code']);
  const cwd = firstString(input, ['cwd', 'workdir', 'workingDirectory'])
    ?? node.target?.cwd
    ?? node.target?.label
    ?? '$';
  return (
    <div className="ai-terminal-block" data-ai-tool-view="terminal" data-running={node.state === 'running' || undefined}>
      <div className="ai-terminal-header">
        <span className="ai-state-dot" data-state={node.state} aria-hidden="true" />
        <span className="ai-terminal-cwd">{cwd}</span>
        <span className="ai-terminal-command">{command || node.name}</span>
        {exitCode !== null && exitCode !== 0 && <span className="ai-terminal-exit">exit {exitCode}</span>}
        {output && <CopyTextButton text={output} />}
      </div>
      {node.state !== 'running' && (
        <div className="ai-terminal-output">
          {output ? <CappedText text={output} maxLines={compact ? 8 : Number.POSITIVE_INFINITY} /> : t('ai.workspace.tool.noOutput')}
        </div>
      )}
    </div>
  );
}

function ReadSurface({ node, compact }: { node: ToolNode; compact: boolean }) {
  const input = asRecord(node.input);
  const label = firstString(input, ['path', 'file_path', 'filePath']) ?? node.summary ?? node.name;
  const lines = bounded(outputText(node)).split('\n');
  const shown = compact && lines.length > 8
    ? [...lines.slice(0, 4), `… ${lines.length - 8} lines …`, ...lines.slice(-4)]
    : lines;
  return (
    <div className="ai-read-block" data-ai-tool-view="read">
      <div className="ai-block-banner">{label}</div>
      <pre className="ai-read-lines">
        {shown.map((line, index) => (
          <span key={index} className="ai-read-line">
            <span className="ai-read-line-number" aria-hidden="true">{index + 1}</span>
            <span>{line || '\u00a0'}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

function SearchSurface({ node, compact }: { node: ToolNode; compact: boolean }) {
  const input = asRecord(node.input);
  const query = firstString(input, ['query', 'pattern']) ?? node.summary ?? node.name;
  const lines = bounded(outputText(node)).split('\n').filter(Boolean);
  const shown = compact && lines.length > 8
    ? [...lines.slice(0, 4), `… ${lines.length - 8} results …`, ...lines.slice(-4)]
    : lines;
  return (
    <div className="ai-search-block" data-ai-tool-view="search">
      <div className="ai-block-banner"><SearchIcon aria-hidden="true" />{query}</div>
      <div className="ai-search-results">
        {shown.map((line, index) => <div key={index} className="ai-search-result">{line}</div>)}
      </div>
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

function WebSurface({ node }: { node: ToolNode }) {
  const input = asRecord(node.input);
  const sources = webSources(node.output);
  const url = firstString(input, ['url']);
  const answer = firstString(asRecord(node.output), ['answer', 'summary']);
  return (
    <div className="ai-web-block" data-ai-tool-view="web">
      <div className="ai-block-banner"><GlobeIcon aria-hidden="true" />{url ?? node.summary ?? node.name}</div>
      {answer && <p className="ai-web-answer">{answer}</p>}
      {sources.length > 0 ? (
        <div className="ai-web-sources">
          {sources.map((source, index) => (
            <a key={`${source.url}:${index}`} href={source.url} target="_blank" rel="noreferrer" className="ai-web-source">
              <span>{source.title}</span>
              {source.snippet && <small>{source.snippet}</small>}
            </a>
          ))}
        </div>
      ) : (
        <pre className="ai-detail-code">{bounded(outputText(node))}</pre>
      )}
    </div>
  );
}

interface DiffHunk {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

function diffHunks(node: ToolNode): readonly DiffHunk[] {
  const output = asRecord(node.output);
  const diffs = Array.isArray(output?.diffs) ? output.diffs : null;
  if (diffs) {
    return diffs.flatMap((value) => {
      const hunk = asRecord(value);
      const path = firstString(hunk, ['path', 'file_path']);
      const oldText = hunk?.oldText ?? hunk?.old_string ?? null;
      const newText = hunk?.newText ?? hunk?.new_string;
      return path && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
        ? [{ path, oldText, newText }]
        : [];
    });
  }
  const input = asRecord(node.input);
  const path = firstString(input, ['path', 'file_path', 'filePath']);
  const oldText = input?.old_string ?? input?.oldText ?? null;
  const newText = input?.new_string ?? input?.newText ?? input?.content;
  return path && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
    ? [{ path, oldText, newText }]
    : [];
}

function DiffSurface({ node, compact }: { node: ToolNode; compact: boolean }) {
  const hunks = diffHunks(node);
  if (hunks.length === 0) return <IoSurface node={node} compact={compact} />;
  return (
    <div className="ai-diff-block" data-ai-tool-view="diff">
      {hunks.map((hunk, index) => (
        <section key={`${hunk.path}:${index}`}>
          <div className="ai-block-banner">{hunk.path}</div>
          <pre className="ai-diff-body">
            {hunk.oldText?.split('\n').slice(0, compact ? 8 : undefined).map((line, lineIndex) => (
              <span key={`old-${lineIndex}`} data-diff="removed">- {line}</span>
            ))}
            {hunk.newText.split('\n').slice(0, compact ? 8 : undefined).map((line, lineIndex) => (
              <span key={`new-${lineIndex}`} data-diff="added">+ {line}</span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function CodeSurface({ node }: { node: ToolNode }) {
  const input = asRecord(node.input);
  const code = firstString(input, ['code', 'program', 'script']) ?? formatToolValue(node.input);
  const language = firstString(input, ['language', 'lang']) ?? 'code';
  return (
    <div className="ai-code-block ai-tool-code-block" data-ai-tool-view="code">
      <div className="ai-code-block-banner">
        <span className="ai-code-block-language">{language}</span>
        <CopyTextButton text={code} />
      </div>
      <pre className="ai-code-block-pre"><code>{bounded(code)}</code></pre>
      {node.output !== null && (
        <div className="ai-io-section">
          <span className="ai-io-label">OUT</span>
          <pre className="ai-io-text">{bounded(outputText(node))}</pre>
        </div>
      )}
    </div>
  );
}

function IoSurface({ node, compact }: { node: ToolNode; compact: boolean }) {
  const input = bounded(formatToolValue(node.input));
  const output = bounded(outputText(node));
  return (
    <div className="ai-io-card" data-ai-tool-view="generic">
      {input && (
        <div className="ai-io-section">
          <span className="ai-io-label">IN</span>
          <pre className="ai-io-text">{compact ? input.slice(0, 8_192) : input}</pre>
        </div>
      )}
      {input && output && <span className="ai-io-divider" aria-hidden="true" />}
      {output && (
        <div className="ai-io-section">
          <span className="ai-io-label">OUT</span>
          <pre className="ai-io-text" data-error={node.state === 'failed' || undefined}>
            {compact ? output.slice(0, 8_192) : output}
          </pre>
        </div>
      )}
    </div>
  );
}

export function AiToolExpandedContent({
  node,
  compact = false,
}: {
  readonly node: ToolNode;
  readonly compact?: boolean;
}) {
  const variant = classifyAiTool(node.name);
  switch (variant) {
    case 'terminal': return <TerminalSurface node={node} compact={compact} />;
    case 'read': return <ReadSurface node={node} compact={compact} />;
    case 'search': return <SearchSurface node={node} compact={compact} />;
    case 'web': return <WebSurface node={node} />;
    case 'write':
    case 'edit': return <DiffSurface node={node} compact={compact} />;
    case 'code': return <CodeSurface node={node} />;
    case 'generic': return <IoSurface node={node} compact={compact} />;
  }
}

export function AiToolRow({
  node,
  onInspect,
}: {
  readonly node: ToolNode;
  readonly onInspect?: (node: ToolNode) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const variant = classifyAiTool(node.name);
  const Icon = iconFor(variant);
  const stateKey = `ai.workspace.tool.${node.state}` as LocaleKey;
  const summary = toolSummary(node, variant);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn('ai-tool-row-root', node.state === 'running' && 'shimmer')}
        data-tool-state={node.state}
        data-tool-variant={variant}
        data-tool-fallback={variant === 'generic' || undefined}
      >
        <span className="sr-only" role="status">{t(stateKey)}</span>
        <CollapsibleTrigger
          render={(
            <button
              type="button"
              className="ai-tool-row"
              data-ai-node-action=""
              aria-label={`${t(titleKey(variant))}: ${summary}`}
            />
          )}
        >
          <span className="ai-disclosure-leading" aria-hidden="true">
            {node.state === 'failed' || node.state === 'rejected'
              ? <span className="ai-state-dot" data-state="failed" />
              : node.state === 'approval'
                ? <ShieldAlertIcon />
                : <Icon />}
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className="ai-disclosure-title">{t(titleKey(variant))}</span>
          <span className="ai-disclosure-separator" aria-hidden="true" />
          <span className="ai-disclosure-summary" data-error={node.state === 'failed' || undefined}>
            {summary}
          </span>
          {node.durationMs !== null && (
            <span className="ai-tool-duration">{t('ai.workspace.durationMs', { duration: node.durationMs })}</span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ai-tool-body">
            <AiToolExpandedContent node={node} compact />
            {onInspect && (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ai-tool-inspect"
                      onClick={() => onInspect(node)}
                      aria-label={t('ai.workspace.details.openTool', { tool: node.name })}
                    />
                  )}
                >
                  {t('ai.workspace.tool.inspect')}
                </TooltipTrigger>
                <TooltipContent>{t('ai.workspace.details.toolTitle')}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function ToolStateIcon({ node }: { readonly node: ToolNode }) {
  if (node.state === 'succeeded') return <CheckIcon aria-hidden="true" />;
  if (node.state === 'approval') return <ShieldAlertIcon aria-hidden="true" />;
  if (node.state === 'failed' || node.state === 'rejected') {
    return <span className="ai-state-dot" data-state="failed" aria-hidden="true" />;
  }
  return <BracesIcon aria-hidden="true" />;
}

export function toolOutputForCopy(node: ToolNode): string {
  return outputText(node);
}
