import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import { useTerminalSession } from '../hooks/useTerminalSession';
import { TerminalSearch } from './TerminalSearch';
import { TerminalContextMenu } from './TerminalContextMenu';
import { t } from '../lib/i18n';
import { formatTerminalPrefixedText } from '../lib/terminal';
import { cn } from '../lib/ui';
import type { SessionState, TerminalTheme, CursorStyle } from '../types';

export interface TerminalPaneRef {
  sendData: (data: string) => void;
  exportBuffer: () => string;
}

interface TerminalPaneProps {
  session: SessionState;
  active: boolean;
  onReconnect: () => void;
  fontSize?: number;
  lineHeight?: number;
  terminalTheme?: TerminalTheme;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean;
  copyOnSelect?: boolean;
}

type CopyFeedback = 'copied' | 'failed';

export const TerminalPane = forwardRef<TerminalPaneRef, TerminalPaneProps>(function TerminalPane(
  {
    session,
    active,
    onReconnect,
    fontSize = 14,
    lineHeight = 1.25,
    terminalTheme = 'default',
    cursorStyle = 'block',
    cursorBlink = true,
    copyOnSelect = false,
  },
  ref,
) {
  const [showSearch, setShowSearch] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);

  const handleOpenSearch = useCallback(() => {
    setShowSearch(true);
  }, []);

  const handleCloseSearch = useCallback(() => {
    setShowSearch((current) => {
      if (!current) {
        return current;
      }
      return false;
    });
  }, []);

  const showCopyFeedback = useCallback((feedback: CopyFeedback) => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopyFeedback(feedback);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      setCopyFeedback(null);
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
    };
  }, []);

  const handleCopyFeedback = useCallback(
    (feedback: CopyFeedback) => {
      showCopyFeedback(feedback);
    },
    [showCopyFeedback],
  );

  const { shellRef, terminalRef, searchAddonRef, focus, isAlive } = useTerminal({
    sessionId: session.sessionId,
    status: session.status,
    active,
    fontSize,
    lineHeight,
    terminalTheme,
    cursorStyle,
    cursorBlink,
    copyOnSelect,
    onOpenSearch: handleOpenSearch,
    onCloseSearch: handleCloseSearch,
    onCopyFeedback: handleCopyFeedback,
  });

  const { writeToSession } = useTerminalSession({
    terminalRef,
    isAlive,
    session,
    onReconnect,
  });

  // Write the initial preparation line once the terminal is created.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isAlive()) {
      return;
    }
    terminal.writeln(formatTerminalPrefixedText(t('terminal.notice.preparing')));
  }, [session.sessionId, terminalRef, isAlive]);

  useImperativeHandle(
    ref,
    () => ({
      sendData: (data: string) => {
        writeToSession(data);
      },
      exportBuffer: () => {
        const terminal = terminalRef.current;
        if (!terminal || !isAlive()) {
          return '';
        }
        const lines: string[] = [];
        const buffer = terminal.buffer.active;
        for (let y = 0; y < buffer.length; y++) {
          const line = buffer.getLine(y);
          if (line) {
            lines.push(line.translateToString(true));
          }
        }
        return lines.join('\n');
      },
    }),
    [writeToSession, terminalRef],
  );

  return (
    <section className={cn('absolute inset-0 flex flex-col', active ? 'opacity-100' : 'pointer-events-none opacity-0')}>
      <TerminalSearch
        terminalRef={terminalRef}
        searchAddonRef={searchAddonRef}
        showSearch={showSearch}
        onCloseSearch={() => {
          setShowSearch(false);
          focus();
        }}
      />
      <div className="terminal-shell themed-terminal-shell min-h-0 flex-1 overflow-hidden" ref={shellRef} />
      {copyFeedback && (
        <div
          aria-live="polite"
          className={cn(
            'terminal-copy-feedback absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-sm px-2 py-1 text-xs',
            copyFeedback === 'failed' && 'terminal-copy-feedback-error',
          )}
          role="status"
        >
          {copyFeedback === 'copied' ? t('terminal.feedback.copied') : t('terminal.feedback.copyFailed')}
        </div>
      )}
      <TerminalContextMenu
        shellRef={shellRef}
        terminalRef={terminalRef}
        sessionId={session.sessionId}
        writeToSession={writeToSession}
        onCopyFeedback={handleCopyFeedback}
        onFind={handleOpenSearch}
      />
    </section>
  );
});
