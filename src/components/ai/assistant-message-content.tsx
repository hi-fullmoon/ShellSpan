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
import { toast } from 'sonner';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { invokeOpenPath, invokeOpenUrl, invokeRevealPath, isTauriRuntime } from '@/lib/ipc/tauri';
import { getPlatform } from '@/lib/platform';
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

function MarkdownLink({ children, href }: { children: React.ReactNode; href?: string }) {
  const { t } = useI18n();
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

  const copy = (value: string): void => {
    if (!navigator.clipboard) {
      toast.error(t('ai.link.copyFailed'));
      return;
    }
    void navigator.clipboard.writeText(value)
      .then(() => toast.success(t('common.copied')))
      .catch(() => toast.error(t('ai.link.copyFailed')));
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
          <ContextMenuItem onClick={() => copy(href)}>{t('ai.link.copyAddress')}</ContextMenuItem>
          {label && label !== href && (
            <ContextMenuItem onClick={() => copy(label)}>{t('ai.link.copyText')}</ContextMenuItem>
          )}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MarkdownInlineCode({ children, className }: { children: React.ReactNode; className?: string }) {
  const { t } = useI18n();
  const path = textFromNode(children).trim();
  const isLocalPath = !className && /^(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]+$/u.test(path);
  const openPath = (): void => {
    void invokeOpenPath(path).catch(() => toast.error(t('ai.path.openFailed')));
  };
  const revealPath = (): void => {
    void invokeRevealPath(path).catch(() => toast.error(t('ai.path.revealFailed')));
  };
  const platform = getPlatform();
  const revealLabel = platform === 'macos'
    ? t('ai.path.revealFinder')
    : platform === 'windows'
      ? t('ai.path.revealExplorer')
      : t('ai.path.revealFileManager');
  const openShortcut = platform === 'macos'
    ? t('ai.path.openWithCommand')
    : t('ai.path.openWithCtrl');
  const code = (
    <code
      className={cn(!className && 'ai-markdown-inline-code', isLocalPath && 'ai-markdown-local-path', className)}
      role={isLocalPath ? 'link' : undefined}
      tabIndex={isLocalPath ? 0 : undefined}
      title={isLocalPath ? openShortcut : undefined}
      onClick={isLocalPath ? (event) => {
        if (platform === 'macos' ? event.metaKey : event.ctrlKey) openPath();
      } : undefined}
      onKeyDown={isLocalPath ? (event) => {
        if (event.key === 'Enter') openPath();
      } : undefined}
    >
      {children}
    </code>
  );
  if (!isLocalPath) return code;

  const copyPath = (): void => {
    if (!navigator.clipboard) {
      toast.error(t('ai.path.copyFailed'));
      return;
    }
    void navigator.clipboard.writeText(path)
      .then(() => toast.success(t('common.copied')))
      .catch(() => toast.error(t('ai.path.copyFailed')));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger render={code} />
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onClick={openPath}>{t('ai.path.open')}</ContextMenuItem>
          <ContextMenuItem onClick={revealPath}>{revealLabel}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={copyPath}>{t('ai.path.copy')}</ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
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
    <div className="ai-code-block relative my-4 min-w-0 max-w-full overflow-hidden" data-language={language || undefined}>
      <div className="ai-code-block-banner flex min-w-0 items-center justify-between gap-3 px-3.5 py-[9px]">
        <span className="ai-code-block-language min-w-0 truncate">{language}</span>
        {showActions && (
          <button
            type="button"
            className="ai-code-block-copy m-0 shrink-0 cursor-pointer p-0"
            aria-label={copied ? copiedLabel : copyLabel}
            onClick={copy}
          >
            {copied ? copiedLabel : copyLabel}
          </button>
        )}
      </div>
      <pre className="ai-code-block-pre m-0 max-w-full overflow-x-auto p-4 whitespace-pre-wrap break-all">{children}</pre>
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
    <div className="ai-assistant-markdown min-w-0 max-w-full [overflow-wrap:anywhere]">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children: linkChildren, href }) => <MarkdownLink href={href}>{linkChildren}</MarkdownLink>,
          blockquote: ({ children: quoteChildren }) => (
            <blockquote>{quoteChildren}</blockquote>
          ),
          code: ({ children: codeChildren, className }) => (
            <MarkdownInlineCode className={className}>{codeChildren}</MarkdownInlineCode>
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
            <div className="ai-markdown-table-scroll my-4 max-w-full overflow-x-auto overscroll-x-contain" tabIndex={0}>
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
      ? <span className="ai-turn-status shimmer inline-flex min-h-6.5 self-start items-center gap-2 whitespace-nowrap" role="status">{t('ai.thinking.inProgress')}</span>
      : null;
  }

  return (
    <div className="ai-assistant-content flex min-w-0 max-w-full flex-col gap-4" data-streaming={streaming || undefined}>
      <div className="ai-assistant-answer flex min-w-0 max-w-full flex-col gap-4">
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
