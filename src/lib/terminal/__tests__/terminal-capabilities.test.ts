import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';
import { hostname, userInfo } from 'node:os';
import { getTerminalGroups, equalizeTerminalPanes, swapTerminalPane, type TerminalSplitState } from '@/components/terminal/terminal-split';
import { terminalInputReadiness } from '@/components/terminal/terminal-input-readiness';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { getTerminalBroadcastTargets, useTerminalBroadcastStore } from '@/stores/terminalBroadcastStore';
import { cleanTerminalTitle, formatTabTitle, resolveTabTitleValues } from '../tab-title';
import { decodeTerminalClipboardWrite, OSC52_MAX_BYTES } from '../terminal-osc52';
import { terminalFontSizeAfterKey, terminalFontStack } from '../terminal-font';
import { findFileLinksInLine, findHttpLinksInBuffer, parseTerminalFileLink, terminalHttpUrl } from '../terminal-links';
import { quoteTerminalDropPaths } from '../terminal-file-drop';
import { fillSnippetTemplate, parseSnippetTemplate } from '../snippet-template';
import { createTerminalCommandBlocks, readTerminalCommandOutput, shouldNotifyTerminalCommand } from '../terminal-command-blocks';
import { serializeTerminalWorkspace } from '../terminal-workspace';

const originalTerminal = useTerminalStore.getState();
const originalSection = useAppStore.getState().activeSection;

afterEach(() => {
  useTerminalBroadcastStore.getState().configure('off');
  useTerminalStore.setState(originalTerminal, true);
  useAppStore.getState().setActiveSection(originalSection);
});

describe('terminal capabilities', () => {
  it('keeps the original layout when pane zoom is toggled or the workspace changes', () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const store = useTerminalStore.getState();
    for (const sessionId of ids) {
      store.addSession({ sessionId, title: userInfo().shell ?? hostname(), host: hostname(), port: 22, username: userInfo().username },
        crypto.randomUUID());
    }
    const [first, second, third] = ids.map((id) => ({ kind: 'group' as const, id, sessionIds: [id], activeSessionId: id }));
    const layout: TerminalSplitState = {
      kind: 'split', orientation: 'horizontal', first,
      second: { kind: 'split', orientation: 'horizontal', first: second, second: third },
    };
    store.setWorkspaceSplit(layout);
    const saved = serializeTerminalWorkspace(useTerminalStore.getState().sessions, layout);
    store.toggleWorkspaceZoom(first.id);
    expect(useTerminalStore.getState().zoomedGroupSlot).toBe(first.id);
    expect(serializeTerminalWorkspace(useTerminalStore.getState().sessions, useTerminalStore.getState().workspaceSplit)).toBe(saved);
    const balanced = equalizeTerminalPanes(layout);
    expect(balanced.split).toBeCloseTo(1 / 3);
    expect(getTerminalGroups(swapTerminalPane(balanced, first.id)).map(({ id }) => id)).toEqual([second.id, first.id, third.id]);
    store.switchWorkspace('focus');
    expect(useTerminalStore.getState().zoomedGroupSlot).toBeNull();
    store.switchWorkspace('terminal');
    store.toggleWorkspaceZoom(first.id);
    store.setWorkspaceSplit(null);
    expect(useTerminalStore.getState().zoomedGroupSlot).toBeNull();
  });

  it('uses dynamic OSC and CWD titles with a readable fallback', () => {
    const template = '${cwd} · ${title}';
    const source = { title: 'SSH', host: hostname(), port: 22, username: userInfo().username };
    const named = resolveTabTitleValues({ ...source, currentDirectory: '/srv/项目/', oscTitle: '\u001bRunning\u202e' });
    expect(formatTabTitle(template, named)).toBe('项目 · Running');
    expect(formatTabTitle(template, resolveTabTitleValues(source))).toBe('SSH · SSH');
    expect(cleanTerminalTitle('a'.repeat(255) + '🚀', 256)).toHaveLength(255);
  });

  it('prepends a single local font name and clamps keyboard zoom', () => {
    expect(terminalFontStack('menlo', ' Maple Mono ')).toBe('"Maple Mono", Menlo, monospace');
    expect(terminalFontStack('menlo', ' \r\n ')).toBe('Menlo, monospace');
    const size = (key: string, before: number) => terminalFontSizeAfterKey(new KeyboardEvent('keydown', { key, metaKey: true }), 'macos', before);
    expect(size('=', 31)).toBe(32);
    expect(size('+', 32)).toBe(32);
    expect(size('-', 10)).toBe(10);
    expect(size('0', 22)).toBe(14);
  });

  it('rejects clipboard reads, invalid encodings, oversized writes, and disabled writes', () => {
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode('终端')));
    expect(decodeTerminalClipboardWrite('c;' + encoded, 'writeOnly')).toBe('终端');
    expect(decodeTerminalClipboardWrite('c;?', 'writeOnly')).toBeNull();
    expect(decodeTerminalClipboardWrite('c;AB==', 'writeOnly')).toBeNull();
    expect(decodeTerminalClipboardWrite('c;====', 'writeOnly')).toBeNull();
    expect(decodeTerminalClipboardWrite('c;' + encoded, 'disabled')).toBeNull();
    expect(decodeTerminalClipboardWrite('c;' + btoa('a'.repeat(OSC52_MAX_BYTES + 1)), 'writeOnly')).toBeNull();
  });

  it('detects wrapped links and file locations while limiting external protocols', async () => {
    const terminal = new Terminal({ cols: 12, rows: 6, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write('https://example.org/long', resolve));
      expect(findHttpLinksInBuffer(terminal.buffer.active, 2, terminal.cols)[0]?.text).toBe('https://example.org/long');
      expect(findFileLinksInLine('src/main.rs:12:8: error').map(({ text }) => text)).toEqual(['src/main.rs:12:8']);
      expect(parseTerminalFileLink('C:\\src\\main.rs:12:8')).toEqual({ path: 'C:\\src\\main.rs', line: 12, column: 8 });
      expect(terminalHttpUrl('javascript:alert(1)')).toBeNull();
      expect(terminalHttpUrl('file:///etc/hosts')).toBeNull();
    } finally {
      terminal.dispose();
    }
  });

  it('quotes dropped paths without adding executable line breaks', () => {
    expect(quoteTerminalDropPaths(["/tmp/a b's", '/tmp/\\$price'], false)).toBe("'/tmp/a b'\\''s' '/tmp/\\$price'");
    expect(quoteTerminalDropPaths(["C:\\a b's", 'C:\\$price'], true)).toBe("'C:\\a b''s' 'C:\\$price'");
    expect(quoteTerminalDropPaths(['/tmp/a\nb'], false)).toBeNull();
  });

  it('skips protected broadcast participants and removes closed sessions', () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const store = useTerminalStore.getState();
    for (const sessionId of ids) {
      store.addSession({ sessionId, title: hostname(), host: hostname(), port: 22, username: userInfo().username });
      store.setStatus(sessionId, { sessionId, status: 'connected' });
    }
    useAppStore.getState().setActiveSection('terminal');
    const [source, second, third] = ids;
    useTerminalBroadcastStore.getState().configure('custom', ids);
    expect(getTerminalBroadcastTargets(source)).toEqual([second, third]);
    store.toggleReadOnly(second);
    terminalInputReadiness.begin(third);
    try {
      expect(getTerminalBroadcastTargets(source)).toEqual([]);
    } finally {
      terminalInputReadiness.finish(third);
    }
    expect(getTerminalBroadcastTargets(source)).toEqual([third]);
    store.removeSession(third);
    store.removeSession(second);
    expect(useTerminalBroadcastStore.getState().mode).toBe('off');
  });

  it('fills snippet defaults without interpreting parameter contents or accepting control characters', () => {
    expect(parseSnippetTemplate('curl {{url:https://example.org}} -o {{output}}')).toEqual([
      { name: 'url', defaultValue: 'https://example.org' }, { name: 'output', defaultValue: undefined },
    ]);
    expect(fillSnippetTemplate('printf %s {{text}}', { text: '{{literal}}' })).toBe('printf %s {{literal}}');
    expect(fillSnippetTemplate('printf %s {{text}}', { text: 'first\rsecond' })).toBeNull();
    expect(parseSnippetTemplate('ls {{dir:{{nested}}}}')).toBeNull();
  });

  it('reads output between command boundaries and discards coordinates on reflow', async () => {
    const terminal = new Terminal({ cols: 32, rows: 6, allowProposedApi: true });
    const tracker = createTerminalCommandBlocks(terminal);
    try {
      await new Promise<void>((resolve) => terminal.write(
        '\x1b]133;A\x07$ printf hello\r\n\x1b]133;C;ShellSpan=1\x07hello\x1b]133;D;0;ShellSpan=1\x07\r\n$ ', resolve,
      ));
      const completion = { sessionId: crypto.randomUUID(), terminalSessionId: crypto.randomUUID(), terminalGeneration: 1,
        commandId: 1, phase: 'completed' as const, startedAt: Date.now(), durationMs: 11_000, exitCode: 0, cwd: '/tmp' };
      tracker.update(completion);
      expect(readTerminalCommandOutput(terminal, tracker.list()[0])).toBe('hello');
      expect(shouldNotifyTerminalCommand(completion, 10, false)).toBe(true);
      expect(shouldNotifyTerminalCommand(completion, 10, true)).toBe(false);
      expect(shouldNotifyTerminalCommand({ ...completion, exitCode: 7, durationMs: 4 }, 10, false)).toBe(true);
      terminal.resize(24, 6);
      expect(tracker.list()).toEqual([]);
    } finally {
      tracker.dispose();
      terminal.dispose();
    }
  });
});
