import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BrainCircuitIcon, CheckIcon, ChevronRightIcon, ClipboardIcon } from 'lucide-react';
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
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyCode = useCallback((code: string): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopiedCode(code);
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopiedCode(null), 1600);
    }).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children: linkChildren, href }) => (
          <a href={href} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
            {linkChildren}
          </a>
        ),
        blockquote: ({ children: quoteChildren }) => (
          <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
            {quoteChildren}
          </blockquote>
        ),
        code: ({ children: codeChildren, className }) => (
          <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)}>
            {codeChildren}
          </code>
        ),
        h1: ({ children: headingChildren }) => (
          <h1 className="text-base font-semibold leading-6">{headingChildren}</h1>
        ),
        h2: ({ children: headingChildren }) => (
          <h2 className="text-sm font-semibold leading-6">{headingChildren}</h2>
        ),
        h3: ({ children: headingChildren }) => (
          <h3 className="text-sm font-medium leading-6">{headingChildren}</h3>
        ),
        hr: () => <Separator />,
        img: ({ alt }) => <span className="text-muted-foreground">[{alt || 'image'}]</span>,
        ol: ({ children: listChildren }) => (
          <ol className="flex list-decimal flex-col gap-1 pl-5">{listChildren}</ol>
        ),
        p: ({ children: paragraphChildren }) => (
          <p className="leading-6">{paragraphChildren}</p>
        ),
        pre: ({ children: codeChildren }) => {
          const code = textFromNode(codeChildren).replace(/\n$/, '');
          const copied = copiedCode === code;
          return (
            <div className="group/code-block relative">
              {showCodeBlockActions && (
                <Button
                  variant="outline"
                  size="xs"
                  className={cn(
                    'absolute right-1.5 top-1.5 size-6 p-0 transition-opacity',
                    !copied && 'pointer-events-none opacity-0 group-hover/code-block:pointer-events-auto group-hover/code-block:opacity-100 group-focus-within/code-block:pointer-events-auto group-focus-within/code-block:opacity-100',
                  )}
                  onClick={() => copyCode(code)}
                  aria-label={copied ? copiedLabel : copyLabel}
                >
                  {copied
                    ? <CheckIcon data-icon="inline-start" />
                    : <ClipboardIcon data-icon="inline-start" />}
                  <span className="sr-only" aria-live="polite">
                    {copied ? copiedLabel : copyLabel}
                  </span>
                </Button>
              )}
              <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 text-xs leading-5 [&_code]:bg-transparent [&_code]:p-0">
                {codeChildren}
              </pre>
            </div>
          );
        },
        table: ({ children: tableChildren }) => (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-left text-xs">{tableChildren}</table>
          </div>
        ),
        td: ({ children: cellChildren }) => (
          <td className="border-t border-border px-2 py-1.5 align-top">{cellChildren}</td>
        ),
        th: ({ children: cellChildren }) => (
          <th className="bg-muted px-2 py-1.5 font-medium">{cellChildren}</th>
        ),
        ul: ({ children: listChildren }) => (
          <ul className="flex list-disc flex-col gap-1 pl-5">{listChildren}</ul>
        ),
      }}
    >
      {children}
    </Markdown>
  );
});

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
  const [reasoningOpen, setReasoningOpen] = useState(!hasAnswer && hasReasoning);

  useEffect(() => {
    if (!hadReasoning.current && hasReasoning && !hasAnswer) setReasoningOpen(true);
    if (!hadAnswer.current && hasAnswer) setReasoningOpen(false);
    hadReasoning.current = hasReasoning;
    hadAnswer.current = hasAnswer;
  }, [hasAnswer, hasReasoning]);

  if (!renderedContent) {
    return <span className="shimmer text-xs">{t('ai.thinking.inProgress')}</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {reasoning && (
        <Collapsible open={reasoningOpen} onOpenChange={setReasoningOpen}>
          <CollapsibleTrigger
            render={<Button variant="ghost" size="xs" className="group justify-start" />}
          >
            <ChevronRightIcon
              data-icon="inline-start"
              className={cn('transition-transform', reasoningOpen && 'rotate-90')}
            />
            <BrainCircuitIcon data-icon="inline-start" />
            <span className={cn(streaming && !reasoningComplete && 'shimmer')}>
              {streaming && !reasoningComplete
                ? t('ai.thinking.inProgress')
                : t('ai.thinking')}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pl-3">
            <div className="border-l border-border py-1 pl-3 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
              {reasoning}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      {hasAnswer && (
        <div className="flex min-w-0 flex-col gap-3 [&>*]:min-w-0">
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
