import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { splitStreamingMarkdown } from '@/lib/streaming-markdown';
import type { AgentSessionAssistantContentBlock } from '@/types/agent-session';
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
  const deferredAnswer = useDeferredValue(answer);
  const renderedAnswer = streaming ? deferredAnswer : answer;
  const answerChunks = useMemo(() => splitStreamingMarkdown(renderedAnswer), [renderedAnswer]);

  if (!renderedAnswer) {
    return streaming
      ? <span className="ai-turn-status shimmer" role="status">{t('ai.thinking.inProgress')}</span>
      : null;
  }

  return (
    <div className="ai-assistant-content" data-streaming={streaming || undefined}>
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
    </div>
  );
};

export const AssistantMessageContent = React.memo(AssistantMessageContentComponent);
AssistantMessageContent.displayName = 'AssistantMessageContent';
