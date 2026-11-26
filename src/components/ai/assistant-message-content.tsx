import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { defaultUrlTransform, type Components, type ExtraProps, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import { toast } from 'sonner';
import { Check, Copy, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AiContentTitle } from './workspace/ai-content-title';
import { AiNativeCodeFade } from './workspace/ai-native-code-fade';
import { AI_CONTENT_CODE_CLASS, AI_CONTENT_HEADER_CLASS } from './workspace/ai-style-classes';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { aiLocalFileReference } from '@/lib/ai/file-reference';
import { isTerminalInsertLanguage, sanitizeSingleLineTerminalCommand } from '@/lib/ai/terminal-insert';
import { invokeOpenUrl, isTauriRuntime } from '@/lib/ipc/tauri';
import { createStreamingMarkdownSplitter } from '@/lib/streaming-markdown';
import type { AgentSessionAssistantContentBlock, AgentSessionTarget } from '@/types/agent-session';
import { cn } from '@/lib/utils';
import { CopyMenuItem } from '@/components/ui/copy-menu-item';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { AiFileReferenceMenu } from './ai-file-reference-menu';
import { useMessageLayoutCommit } from './message-layout-context';
import { rehypeStreamingText, StreamingText, StreamingTextBoundaryContext, StreamingTextContext } from './streaming-text';

function textFromNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textFromNode(node.props.children);
  }
  return '';
}

function languageFromNode(node: React.ReactNode): string {
  const child = React.Children.toArray(node).find(React.isValidElement);
  if (!React.isValidElement<{ className?: string }>(child)) return '';
  return /language-([^\s]+)/u.exec(child.props.className ?? '')?.[1] ?? '';
}

function codeClassNameFromNode(node: React.ReactNode): string | undefined {
  const child = React.Children.toArray(node).find(React.isValidElement);
  if (!React.isValidElement<{ className?: string }>(child)) return undefined;
  return child.props.className;
}

const HIGHLIGHT_CODE_LIMIT = 32 * 1024;
const HIGHLIGHT_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  vue: 'xml',
  svg: 'xml',
  mjs: 'javascript',
  cjs: 'javascript',
  docker: 'dockerfile',
  dotenv: 'ini',
  env: 'ini',
  conf: 'ini',
  cfg: 'ini',
  shellsession: 'bash',
  console: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
};

function resolveHighlightLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  if (hljs.getLanguage(normalized)) return normalized;
  const alias = HIGHLIGHT_LANGUAGE_ALIASES[normalized];
  return alias && hljs.getLanguage(alias) ? alias : null;
}

function isFencedCodeBlockClosed(source: string, startOffset?: number, endOffset?: number): boolean {
  if (startOffset === undefined || endOffset === undefined) return false;
  if (endOffset < source.length) return true;
  const slice = source.slice(startOffset, endOffset).replace(/\r?\n$/u, '');
  const firstNewline = slice.indexOf('\n');
  if (firstNewline === -1) return false;
  const openLine = slice.slice(0, firstNewline).replace(/\r$/u, '');
  const openFence = /^ {0,3}(`{3,}|~{3,})/u.exec(openLine)?.[1];
  if (!openFence) return false;
  const lastNewline = slice.lastIndexOf('\n');
  const closeLine = slice.slice(lastNewline + 1).replace(/\r$/u, '');
  const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(closeLine);
  return Boolean(closeMatch && closeMatch[1][0] === openFence[0] && closeMatch[1].length >= openFence.length);
}

function selectionIntersectsElement(element: HTMLElement | null): boolean {
  if (!element || typeof window === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    .some((range) => range.intersectsNode(element));
}

export interface AiTerminalInsertContextValue {
  readonly targetName?: string;
  readonly insert: (code: string) => boolean;
}

const MarkdownLinkContext = createContext(false);
const MarkdownSourceContext = createContext<{ source: string; streaming: boolean }>({ source: '', streaming: false });
export const AiMarkdownTargetContext = createContext<AgentSessionTarget | undefined>(undefined);
export const AiTerminalInsertContext = createContext<AiTerminalInsertContextValue | undefined>(undefined);

function MarkdownLink({ children, href }: { children: React.ReactNode; href?: string }) {
  const { t } = useI18n();
  const target = useContext(AiMarkdownTargetContext);
  const reference = href && aiLocalFileReference(href, 'link', target?.kind);
  if (reference) {
    if (target?.kind === 'remote' && !reference.path.startsWith('/')) return <span>{children}</span>;
    return <AiFileReferenceMenu reference={reference} target={target}>{children}</AiFileReferenceMenu>;
  }
  const label = textFromNode(children).trim();
  if (!href || !/^(https?:\/\/|mailto:)/iu.test(href)) {
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  }

  const openLink = (): void => {
    if (isTauriRuntime()) {
      void invokeOpenUrl(href).catch(() => toast.error(t('ai.link.openFailed')));
    } else {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<a href={href} target="_blank" rel="noreferrer" />}
        onClick={(event) => {
          event.preventDefault();
          openLink();
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onClick={openLink}>{t('ai.link.open')}</ContextMenuItem>
          <ContextMenuSeparator />
          <CopyMenuItem text={href} label={t('ai.link.copyAddress')} errorLabel={t('ai.link.copyFailed')} />
          {label && label !== href && (
            <CopyMenuItem text={label} label={t('ai.link.copyText')} errorLabel={t('ai.link.copyFailed')} />
          )}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MarkdownInlineCode({ children, className }: { children: React.ReactNode; className?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  const target = useContext(AiMarkdownTargetContext);
  const text = !className && !insideLink ? textFromNode(children) : '';
  const reference = !text.includes('\n') && aiLocalFileReference(text.trim(), 'code', target?.kind);
  return reference && (target?.kind !== 'remote' || reference.path.startsWith('/'))
    ? <AiFileReferenceMenu reference={reference} target={target} inlineCode>{children}</AiFileReferenceMenu>
    : <code className={className || 'ai-markdown-inline-code'}>{children}</code>;
}

function MarkdownCodeBlock({
  children,
  copiedLabel,
  copyLabel,
  showActions,
  sourceStart,
  sourceEnd,
  onInsertToTerminal,
  insertLabel,
  insertedLabel,
}: {
  children: React.ReactNode;
  copiedLabel: string;
  copyLabel: string;
  showActions: boolean;
  sourceStart?: number;
  sourceEnd?: number;
  onInsertToTerminal?: (code: string) => boolean;
  insertLabel?: string;
  insertedLabel?: string;
}) {
  const { t } = useI18n();
  const { source, streaming } = useContext(MarkdownSourceContext);
  const terminalInsert = useContext(AiTerminalInsertContext);
  const rawCode = textFromNode(children);
  const code = rawCode.replace(/\n$/, '');
  const language = languageFromNode(children);
  const effectiveInsert = onInsertToTerminal ?? terminalInsert?.insert;
  const canInsertCode = Boolean(
    effectiveInsert
    && sanitizeSingleLineTerminalCommand(code)
    && (onInsertToTerminal || isTerminalInsertLanguage(language)),
  );
  const resolvedInsertLabel = insertLabel ?? (
    terminalInsert?.targetName
      ? t('ai.workspace.question.actionInsertCommandToTarget', { target: terminalInsert.targetName })
      : t('ai.workspace.question.actionInsertCommand')
  );
  const resolvedInsertedLabel = insertedLabel ?? t('ai.workspace.question.actionInsertedCommand');
  const codeClassName = codeClassNameFromNode(children);
  const { copied, copy } = useCopyFeedback();
  const [inserted, setInserted] = useState(false);
  const insertTimerRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLPreElement>(null);
  const highlightedRef = useRef(false);
  const isStable = !streaming || isFencedCodeBlockClosed(source, sourceStart, sourceEnd);
  const [selectionDeferred, setSelectionDeferred] = useState(false);
  const deferHighlight = selectionDeferred
    || (isStable && !highlightedRef.current && selectionIntersectsElement(viewportRef.current));
  const shouldHighlight = isStable && !deferHighlight;
  const highlightedHtml = useMemo(() => {
    if (!shouldHighlight || !code || rawCode.length > HIGHLIGHT_CODE_LIMIT) return null;
    const resolved = resolveHighlightLanguage(language);
    if (!resolved) return null;
    try {
      return hljs.highlight(rawCode, { language: resolved, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [shouldHighlight, code, rawCode, language]);
  useLayoutEffect(() => {
    highlightedRef.current = highlightedHtml !== null;
    if (deferHighlight && !selectionDeferred) setSelectionDeferred(true);
  }, [deferHighlight, highlightedHtml, selectionDeferred]);
  useEffect(() => {
    if (!selectionDeferred || typeof document === 'undefined') return;
    const onSelectionChange = (): void => {
      if (!selectionIntersectsElement(viewportRef.current)) setSelectionDeferred(false);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [selectionDeferred]);
  useEffect(() => () => {
    if (insertTimerRef.current !== null) window.clearTimeout(insertTimerRef.current);
  }, []);
  const handleInsert = (): void => {
    if (!effectiveInsert?.(code)) return;
    setInserted(true);
    if (insertTimerRef.current !== null) window.clearTimeout(insertTimerRef.current);
    insertTimerRef.current = window.setTimeout(() => {
      setInserted(false);
      insertTimerRef.current = null;
    }, 1500);
  };

  return (
    <div className="ai-code-block ai-markdown-code-block relative my-3 min-w-0 max-w-full overflow-hidden" data-language={language || undefined}>
      {language && <div className={cn(AI_CONTENT_HEADER_CLASS, 'ai-markdown-code-toolbar')}>
        <AiContentTitle className="ai-code-block-language flex-1">{language}</AiContentTitle>
      </div>}
      <div className="relative min-w-0" data-ai-copy-region>
        {showActions && (canInsertCode ? (
          <div className="ai-markdown-code-actions absolute top-1 right-3.5 z-10 flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ai-markdown-code-insert ai-markdown-code-copy ai-content-copy"
                    aria-label={inserted ? resolvedInsertedLabel : resolvedInsertLabel}
                    onClick={handleInsert}
                  />
                )}
              >
                {inserted ? <Check data-icon="inline-start" /> : <Terminal data-icon="inline-start" />}
              </TooltipTrigger>
              <TooltipContent>{inserted ? resolvedInsertedLabel : resolvedInsertLabel}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ai-markdown-code-copy ai-content-copy"
                    aria-label={copied ? copiedLabel : copyLabel}
                    onClick={() => { void copy(code); }}
                  />
                )}
              >
                {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              </TooltipTrigger>
              <TooltipContent>{copied ? copiedLabel : copyLabel}</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="ai-markdown-code-copy ai-content-copy absolute top-1 right-3.5 z-10"
                  aria-label={copied ? copiedLabel : copyLabel}
                  onClick={() => { void copy(code); }}
                />
              )}
            >
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            </TooltipTrigger>
            <TooltipContent>{copied ? copiedLabel : copyLabel}</TooltipContent>
          </Tooltip>
        ))}
        <pre ref={viewportRef} tabIndex={0} className={cn(AI_CONTENT_CODE_CLASS, 'ai-code-block-pre max-h-65 overflow-auto overscroll-x-contain whitespace-pre')}>
          {/* Only highlight.js-generated, escaped markup is inserted; unknown languages stay plain text. */}
          {highlightedHtml !== null ? (
            <code className={codeClassName || undefined} data-highlighted="true" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          ) : children}
        </pre>
        <AiNativeCodeFade viewportRef={viewportRef} text={code} />
      </div>
    </div>
  );
}

// Locale or code-toolbar labels may rebuild the components map. Keep this
// element type stable so existing streaming fragments and selections survive.
function MarkdownStreamingSpan({ children, node, ...props }: React.ComponentProps<'span'> & ExtraProps) {
  return node?.properties.dataStreamText && typeof children === 'string'
    ? <StreamingText sourceStart={node.position?.start.offset}>{children}</StreamingText>
    : <span {...props}>{children}</span>;
}

export const MarkdownContent = React.memo(function MarkdownContent({
  children,
  copiedLabel,
  copyLabel,
  showCodeBlockActions,
  initialSource = '',
  streaming = false,
  onInsertToTerminal,
  insertLabel,
  insertedLabel,
}: {
  children: string;
  copiedLabel: string;
  copyLabel: string;
  showCodeBlockActions: boolean;
  /** Previously displayed source moved here by a streaming chunk split. */
  initialSource?: string;
  streaming?: boolean;
  onInsertToTerminal?: (code: string) => boolean;
  insertLabel?: string;
  insertedLabel?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const targetKind = useContext(AiMarkdownTargetContext)?.kind;
  const markdownUrlTransform: UrlTransform = (value, key) =>
    key === 'href' && aiLocalFileReference(value, 'link', targetKind) ? value : defaultUrlTransform(value);
  const previousSource = useRef(initialSource);
  const fallbackImageAlt = t('ai.workspace.images.fallbackAlt');
  const revealFrom = children.startsWith(previousSource.current) ? previousSource.current.length : children.length;
  useLayoutEffect(() => { previousSource.current = children; }, [children]);
  const markdownSource = useMemo(() => ({ source: children, streaming }), [children, streaming]);
  // Stable element types preserve code/table DOM (focus and horizontal scroll)
  // when the growing chunk is parsed again.
  const components = useMemo<Components>(() => ({
    span: MarkdownStreamingSpan,
    a: ({ children: linkChildren, href }) => (
      <MarkdownLinkContext.Provider value={true}>
        <MarkdownLink href={href}>{linkChildren}</MarkdownLink>
      </MarkdownLinkContext.Provider>
    ),
    blockquote: ({ children: quoteChildren }) => <blockquote>{quoteChildren}</blockquote>,
    code: ({ children: codeChildren, className }) => (
      <MarkdownInlineCode className={className}>{codeChildren}</MarkdownInlineCode>
    ),
    hr: () => <Separator />,
    img: ({ alt }) => <span className="ai-markdown-image-alt">[{alt || fallbackImageAlt}]</span>,
    pre: ({ children: codeChildren, node }) => (
      <MarkdownCodeBlock
        copiedLabel={copiedLabel}
        copyLabel={copyLabel}
        showActions={showCodeBlockActions}
        sourceStart={node?.position?.start.offset}
        sourceEnd={node?.position?.end.offset}
        onInsertToTerminal={onInsertToTerminal}
        insertLabel={insertLabel}
        insertedLabel={insertedLabel}
      >
        {codeChildren}
      </MarkdownCodeBlock>
    ),
    table: ({ children: tableChildren }) => (
      <div className="ai-markdown-table-scroll my-4 max-w-full overflow-x-auto overscroll-x-contain" tabIndex={0}>
        <table>{tableChildren}</table>
      </div>
    ),
  }), [copiedLabel, copyLabel, showCodeBlockActions, fallbackImageAlt, onInsertToTerminal, insertLabel, insertedLabel]);
  return (
    <div className="ai-assistant-markdown min-w-0 max-w-full [overflow-wrap:anywhere]">
      <MarkdownSourceContext.Provider value={markdownSource}>
        <StreamingTextBoundaryContext.Provider value={revealFrom}>
          <Markdown
            remarkPlugins={MARKDOWN_PLUGINS}
            rehypePlugins={STREAMING_TEXT_PLUGINS}
            urlTransform={markdownUrlTransform}
            skipHtml
            components={components}
          >
            {children}
          </Markdown>
        </StreamingTextBoundaryContext.Provider>
      </MarkdownSourceContext.Provider>
    </div>
  );
});

const MARKDOWN_PLUGINS = [remarkGfm];
const STREAMING_TEXT_PLUGINS = [rehypeStreamingText];

const LARGE_MARKDOWN_CHUNK = 8_192;
const MARKDOWN_UPDATE_INTERVAL_MS = 80;

export const StreamingMarkdownContent = React.memo(function StreamingMarkdownContent({
  children, streaming, animateText = true, initialSource, ...props
}: React.ComponentProps<typeof MarkdownContent> & { streaming: boolean; animateText?: boolean }) {
  const [layoutRevision, publish] = useState(0);
  const initialSourceRef = useRef(initialSource);
  const published = useRef(children);
  const latest = useRef(children);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttled = streaming && children.length >= LARGE_MARKDOWN_CHUNK;
  const shown = throttled && children.startsWith(published.current) ? published.current : children;
  useLayoutEffect(() => {
    latest.current = children;
    published.current = shown;
    if (!throttled) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    if (children === shown || timer.current !== null) return;
    // Keep one deadline while tokens arrive, so continuous output cannot starve
    // the preview. A final commit bypasses the timer in the render below.
    timer.current = setTimeout(() => {
      timer.current = null;
      published.current = latest.current;
      publish((revision) => revision + 1);
    }, MARKDOWN_UPDATE_INTERVAL_MS);
  }, [children, shown, throttled]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useMessageLayoutCommit(layoutRevision);
  return (
    <StreamingTextContext.Provider value={streaming && animateText}>
      <MarkdownContent {...props} initialSource={initialSourceRef.current} streaming={streaming}>{shown}</MarkdownContent>
    </StreamingTextContext.Provider>
  );
});

function answerFromBlocks(blocks: readonly AgentSessionAssistantContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

const AssistantMessageContentComponent: React.FC<{
  blocks: readonly AgentSessionAssistantContentBlock[];
  streaming: boolean;
  showCodeBlockActions?: boolean;
}> = ({ blocks, streaming, showCodeBlockActions = true }) => {
  const { t } = useI18n();
  const answer = useMemo(() => answerFromBlocks(blocks), [blocks]);
  const splitMarkdown = useMemo(() => createStreamingMarkdownSplitter(), []);
  const answerChunks = useMemo(() => splitMarkdown(answer), [answer, splitMarkdown]);
  const previousSource = useRef('');
  const previous = answer.startsWith(previousSource.current) ? previousSource.current : '';
  useLayoutEffect(() => { previousSource.current = answer; }, [answer]);
  let offset = 0;

  if (!answer) {
    return streaming
      ? <span className="ai-turn-status shimmer inline-flex min-h-6.5 self-start items-center gap-2 whitespace-nowrap" role="status">{t('ai.thinking.inProgress')}</span>
      : null;
  }

  return (
    <div className="ai-assistant-content flex min-w-0 max-w-full flex-col gap-4" data-streaming={streaming || undefined}>
      <div className="ai-assistant-answer flex min-w-0 max-w-full flex-col gap-4">
        {answerChunks.map((chunk, index) => {
          // Splitting moves already displayed text into a newly mounted chunk.
          // Only source beyond its previous position should animate again.
          const initialSource = previous.slice(offset, offset + chunk.length);
          offset += chunk.length;
          return (
            <StreamingMarkdownContent
              key={index}
              initialSource={initialSource}
              copiedLabel={t('common.copied')}
              copyLabel={t('common.copy')}
              showCodeBlockActions={showCodeBlockActions}
              streaming={streaming && index === answerChunks.length - 1}
            >
              {chunk}
            </StreamingMarkdownContent>
          );
        })}
      </div>
    </div>
  );
};

export const AssistantMessageContent = React.memo(AssistantMessageContentComponent);
AssistantMessageContent.displayName = 'AssistantMessageContent';
