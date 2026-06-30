import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { useContextMenu } from '../hooks/useContextMenu';
import { useSnippetsStore } from '../stores/snippetsStore';
import { t } from '../lib/i18n';

interface TerminalContextMenuProps {
  terminalRef: React.RefObject<Terminal | null>;
  sessionId: string;
  writeToSession: (data: string) => void;
  onCopyFeedback: (feedback: 'copied' | 'failed') => void;
  onFind: () => void;
}

export function TerminalContextMenu({
  terminalRef,
  sessionId,
  writeToSession,
  onCopyFeedback,
  onFind,
}: TerminalContextMenuProps) {
  const {
    isOpen: menuOpen,
    position: menuPosition,
    open: openMenu,
    close: closeMenu,
    menuRef,
  } = useContextMenu(`terminal-pane-${sessionId}`);
  const [menuHasSelection, setMenuHasSelection] = useState(false);
  const [snippetSubmenuOpen, setSnippetSubmenuOpen] = useState(false);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const snippets = useSnippetsStore((state) => state.snippets);

  // Bind the context menu to the xterm element.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !terminal.element) {
      return;
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setMenuHasSelection(!!terminal.getSelection());
      openMenu(event.clientX, event.clientY);
    };

    terminal.element.addEventListener('contextmenu', handleContextMenu);
    return () => {
      terminal.element?.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [terminalRef, openMenu]);

  useEffect(() => {
    if (!menuOpen) {
      setSnippetSubmenuOpen(false);
    }
  }, [menuOpen]);

  // Adjust submenu horizontal/vertical position to avoid overflowing the viewport.
  useEffect(() => {
    if (!snippetSubmenuOpen || !menuRef.current || !submenuRef.current || !menuPosition) {
      return;
    }

    const menuRect = menuRef.current.getBoundingClientRect();
    const submenuRect = submenuRef.current.getBoundingClientRect();
    const edge = 8;

    const wouldOverflowRight = menuRect.right + submenuRect.width + edge > window.innerWidth;
    if (wouldOverflowRight) {
      submenuRef.current.style.left = 'auto';
      submenuRef.current.style.right = '100%';
      submenuRef.current.style.marginLeft = '0';
      submenuRef.current.style.marginRight = '4px';
    } else {
      submenuRef.current.style.left = '100%';
      submenuRef.current.style.right = 'auto';
      submenuRef.current.style.marginLeft = '4px';
      submenuRef.current.style.marginRight = '0';
    }

    const wouldOverflowBottom = menuRect.top + submenuRect.height + edge > window.innerHeight;
    if (wouldOverflowBottom) {
      submenuRef.current.style.top = 'auto';
      submenuRef.current.style.bottom = '0';
    } else {
      submenuRef.current.style.top = '0';
      submenuRef.current.style.bottom = 'auto';
    }
  }, [snippetSubmenuOpen, menuPosition, menuRef]);

  const handleContextMenuCopy = async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const selection = terminal.getSelection();
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection);
      onCopyFeedback('copied');
    } catch {
      onCopyFeedback('failed');
    }
    closeMenu();
  };

  const handleContextMenuPaste = async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      writeToSession(text);
    } catch {
      onCopyFeedback('failed');
    }
    closeMenu();
  };

  const handleContextMenuSelectAll = () => {
    terminalRef.current?.selectAll();
    closeMenu();
  };

  const handleContextMenuClear = () => {
    terminalRef.current?.clear();
    closeMenu();
  };

  const handleContextMenuFind = () => {
    onFind();
    closeMenu();
  };

  const handleSendSnippet = (command: string) => {
    writeToSession(`${command}\r`);
    closeMenu();
  };

  if (!menuOpen || !menuPosition) {
    return null;
  }

  return (
    <>
      {createPortal(
        <div
          className="themed-menu fixed z-50 min-w-28 rounded-lg p-1 backdrop-blur"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          ref={menuRef}
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          <div className="flex flex-col">
            <button
              className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
              disabled={!menuHasSelection}
              onClick={handleContextMenuCopy}
              type="button"
            >
              {t('terminal.contextMenu.copy')}
            </button>
            <button
              className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
              onClick={handleContextMenuPaste}
              type="button"
            >
              {t('terminal.contextMenu.paste')}
            </button>
            <div className="themed-menu-divider my-1 h-px" />
            <button
              className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
              onClick={handleContextMenuSelectAll}
              type="button"
            >
              {t('terminal.contextMenu.selectAll')}
            </button>
            <div className="themed-menu-divider my-1 h-px" />
            <button
              className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
              onClick={handleContextMenuClear}
              type="button"
            >
              {t('terminal.contextMenu.clear')}
            </button>
            <div className="themed-menu-divider my-1 h-px" />
            <button
              className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
              onClick={handleContextMenuFind}
              type="button"
            >
              {t('terminal.contextMenu.find')}
            </button>
            <div
              className="relative"
              onMouseEnter={() => setSnippetSubmenuOpen(true)}
              onMouseLeave={() => setSnippetSubmenuOpen(false)}
            >
              <button
                className="themed-menu-item flex w-full items-center justify-between whitespace-nowrap px-2 py-1 text-left text-xs transition"
                disabled={snippets.length === 0}
                type="button"
              >
                <span>{t('terminal.contextMenu.snippets')}</span>
                <span className="text-[10px] text-slate-400">▸</span>
              </button>
              {snippetSubmenuOpen && (
                <div
                  className="themed-menu absolute top-0 z-50 min-w-28 rounded-lg p-1 backdrop-blur"
                  ref={submenuRef}
                  style={{ left: '100%', marginLeft: '4px' }}
                >
                  {snippets.length === 0 ? (
                    <div className="px-2 py-1 text-[11px] text-slate-400">{t('terminal.contextMenu.noSnippets')}</div>
                  ) : (
                    <div className="flex max-h-60 flex-col overflow-auto">
                      {snippets.map((snippet) => (
                        <button
                          className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                          key={snippet.id}
                          onClick={() => handleSendSnippet(snippet.command)}
                          title={snippet.command}
                          type="button"
                        >
                          {snippet.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
