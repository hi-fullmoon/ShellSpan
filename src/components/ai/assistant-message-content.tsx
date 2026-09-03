import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { parseAssistantContent } from '@/lib/ai-content';
import { splitStreamingMarkdown } from '@/lib/streaming-markdown';
import { cn } from '@/lib/utils';

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

function MarkdownCodeBlock({
  children,
  copiedLabel,
  copyLabel,
  showActions,
}: {
  children: React.ReactNode;
  copiedLabel: string;
  copyLabel: string;
  showActions: boolean;
}) {
  const code = textFromNode(children).replace(/\n$/, '');
  const language = languageFromNode(children);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copy = useCallback(() => {
    if (copied || !navigator.clipboard) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_000);
    }).catch(() => undefined);
  }, [code, copied]);

  return (
    <div className="ai-code-block" data-language={language || undefined}>
      <div className="ai-code-block-banner">
        <span className="ai-code-block-language">{language}</span>
        {showActions && (
          <button
            type="button"
            className="ai-code-block-copy"
            aria-label={copied ? copiedLabel : copyLabel}
            onClick={copy}
          >
            {copied ? copiedLabel : copyLabel}
          </button>
        )}
      </div>
      <pre className="ai-code-block-pre">{children}</pre>
    </div>
  );
}

const MarkdownContent = React.memo(function MarkdownContent({
  children,
  copiedLabel,
  copyLabel,
  showCodeBlockActions,
}: {
  children: string;
  copiedLabel: string;
  copyLabel: string;
  showCodeBlockActions: boolean;
}): React.JSX.Element {
  return (
    <div className="ai-assistant-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children: linkChildren, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {linkChildren}
            </a>
          ),
          blockquote: ({ children: quoteChildren }) => (
            <blockquote>{quoteChildren}</blockquote>
          ),
          code: ({ children: codeChildren, className }) => (
            <code className={cn(!className && 'ai-markdown-inline-code', className)}>
              {codeChildren}
            </code>
          ),
          hr: () => <Separator />,
          img: ({ alt }) => <span className="ai-markdown-image-alt">[{alt || 'image'}]</span>,
          pre: ({ children: codeChildren }) => (
            <MarkdownCodeBlock
              copiedLabel={copiedLabel}
              copyLabel={copyLabel}
              showActions={showCodeBlockActions}
            >
              {codeChildren}
            </MarkdownCodeBlock>
          ),
          table: ({ children: tableChildren }) => (
            <div className="ai-markdown-table-scroll" tabIndex={0}>
              <table>{tableChildren}</table>
            </div>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
});

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? text;
}

function latestLine(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1] ?? text;
}

const AssistantMessageContentComponent: React.FC<{
  content: string;
  streaming: boolean;
  showCodeBlockActions?: boolean;
}> = ({ content, streaming, showCodeBlockActions = true }) => {
  const { t } = useI18n();
  const deferredContent = useDeferredValue(content);
  const renderedContent = streaming ? deferredContent : content;
  const { answer, reasoning, reasoningComplete } = parseAssistantContent(renderedContent);
  const answerChunks = useMemo(() => splitStreamingMarkdown(answer), [answer]);
  const hasAnswer = Boolean(answer.trim());
  const hasReasoning = Boolean(reasoning);
  const hadAnswer = useRef(hasAnswer);
  const hadReasoning = useRef(hasReasoning);
  const reasoningStartedAt = useRef<number | null>(streaming ? Date.now() : null);
  const [reasoningDurationSeconds, setReasoningDurationSeconds] = useState<number | null>(null);
  const [reasoningOpen, setReasoningOpen] = useState(!hasAnswer && hasReasoning);

  useEffect(() => {
    if (!hadReasoning.current && hasReasoning && !hasAnswer) setReasoningOpen(true);
    if (!hadAnswer.current && hasAnswer) setReasoningOpen(false);
    hadReasoning.current = hasReasoning;
    hadAnswer.current = hasAnswer;
  }, [hasAnswer, hasReasoning]);

  useEffect(() => {
    if (streaming && reasoningStartedAt.current === null) reasoningStartedAt.current = Date.now();
    if (
      !hasReasoning
      || reasoningDurationSeconds !== null
      || reasoningStartedAt.current === null
      || (streaming && !reasoningComplete)
    ) return;

    setReasoningDurationSeconds(Math.max(
      1,
      Math.ceil((Date.now() - reasoningStartedAt.current) / 1_000),
    ));
  }, [hasReasoning, reasoningComplete, reasoningDurationSeconds, streaming]);

  if (!renderedContent) {
    return <span className="ai-turn-status shimmer" role="status">{t('ai.thinking.inProgress')}</span>;
  }

  const reasoningRunning = streaming && !reasoningComplete;
  const reasoningSummary = reasoningRunning ? latestLine(reasoning) : firstLine(reasoning);
  const reasoningLabel = reasoningRunning
    ? t('ai.thinking.inProgress')
    : reasoningDurationSeconds === null
      ? t('ai.thinking')
      : t('ai.thinking.completed', { seconds: reasoningDurationSeconds });

  return (
    <div className="ai-assistant-content" data-streaming={streaming || undefined}>
      {reasoning && (
        <Collapsible open={reasoningOpen} onOpenChange={setReasoningOpen}>
          <div
            className={cn('ai-reasoning-row', reasoningRunning && 'shimmer')}
            data-state={reasoningRunning ? 'running' : 'ok'}
            data-expanded={reasoningOpen || undefined}
          >
            <CollapsibleTrigger
              render={(
                <Button
                  variant="plain"
                  size="sm"
                  className="ai-disclosure-row"
                  aria-label={reasoningLabel}
                />
              )}
            >
              <span className="ai-disclosure-leading" aria-hidden="true">
                <BrainIcon />
              </span>
              <span className="ai-disclosure-title">{reasoningLabel}</span>
              <span className="ai-disclosure-separator" aria-hidden="true" />
              <span className="ai-disclosure-summary">{reasoningSummary}</span>
              <ChevronDownIcon className="ai-disclosure-chevron" aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="ai-reasoning-body">{reasoning}</div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
      {hasAnswer && (
        <div className="ai-assistant-answer">
          {answerChunks.map((chunk, index) => (
            <MarkdownContent
              key={index}
              copiedLabel={t('common.copied')}
              copyLabel={t('common.copy')}
              showCodeBlockActions={showCodeBlockActions}
            >
              {chunk}
            </MarkdownContent>
          ))}
        </div>
      )}
    </div>
  );
};

export const AssistantMessageContent = React.memo(AssistantMessageContentComponent);
AssistantMessageContent.displayName = 'AssistantMessageContent';
