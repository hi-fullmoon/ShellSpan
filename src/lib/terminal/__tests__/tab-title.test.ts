import { afterEach, describe, expect, it } from 'vitest';
import { formatTabTitle, MAX_TAB_TITLE_LENGTH, normalizeTabTitleOverrides, validTabTitleTemplate } from '../tab-title';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { parseTerminalWorkspace, serializeTerminalWorkspace } from '../terminal-workspace';

afterEach(() => {
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
  useAppStore.setState({ terminalTabTitleTemplate: '${name}', terminalTabTitleOverrides: {} });
  useProfileStore.setState({ profiles: [] });
});

describe('terminal title templates', () => {
  it('deduplicates the name/host preset but expands custom templates literally', () => {
    const values = { name: '175.178.66.45', host: '175.178.66.45', user: 'root', port: 22, index: 1 };
    expect(formatTabTitle('${name} · ${host}', values)).toBe(values.host);
    expect(formatTabTitle('${name} · ${host}', { ...values, name: '' })).toBe(values.host);
    expect(formatTabTitle('${name} · ${host}', { ...values, name: 'Production' })).toBe(`Production · ${values.host}`);
    expect(formatTabTitle('${name} · ${host}', values, true)).toBe(`${values.host} · ${values.host}`);
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 'dedup', title: values.name, host: values.host, port: 22, username: 'root' }, 'profile');
    useAppStore.getState().setTerminalTabTitleTemplate('${name} · ${host}');
    expect(useTerminalStore.getState().sessions[0].title).toBe(values.host);
    useAppStore.getState().setTerminalTabTitleTemplate('${name} · ${host}', true);
    expect(useTerminalStore.getState().sessions[0].title).toBe(`${values.host} · ${values.host}`);
    useAppStore.getState().setTerminalTabTitleOverride('profile', '${name} · ${host}');
    expect(useTerminalStore.getState().sessions[0].title).toBe(values.host);
    store.updateTitle('dedup', 'Logs');
    useAppStore.getState().setTerminalTabTitleOverride('profile', '${name} · ${host}', true);
    expect(useTerminalStore.getState().sessions[0].title).toBe('Logs');
    store.resetTitle('dedup');
    expect(useTerminalStore.getState().sessions[0].title).toBe(`${values.host} · ${values.host}`);
  });
  it('restores sessions after a valid template expands beyond the workspace title limit', () => {
    useAppStore.getState().setTerminalTabTitleTemplate('${name}'.repeat(36));
    useTerminalStore.getState().addSession({ sessionId: 'long', title: 'n'.repeat(120), host: 'server', port: 22, username: 'root' }, 'profile');
    const snapshot = parseTerminalWorkspace(serializeTerminalWorkspace(useTerminalStore.getState().sessions, null));
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toHaveLength(MAX_TAB_TITLE_LENGTH);
    useTerminalStore.setState({ sessions: [] });
    useTerminalStore.getState().addRestoredSessions(snapshot.sessions);
    expect(useTerminalStore.getState().sessions[0].title).toHaveLength(MAX_TAB_TITLE_LENGTH);
    useAppStore.getState().setTerminalTabTitleTemplate('${name}');
    expect(useTerminalStore.getState().sessions[0].title).toBe('n'.repeat(120));
  });

  it('does not cut a surrogate pair at the title limit', () => {
    const title = formatTabTitle('${name}${host}', { name: 'n'.repeat(4095), host: '😀', user: '', port: 22, index: 1 });
    expect(title).toBe('n'.repeat(4095));
  });
  it('substitutes supported variables once and rejects invalid templates', () => {
    expect(formatTabTitle('${name} · ${user}@${host}:${port} #${index}', {
      name: '${host}', user: 'root', host: 'server', port: 2222, index: 2,
    })).toBe('${host} · root@server:2222 #2');
    for (const value of ['', '${unknown}', '${host', 'a\nb', 'x'.repeat(257), 3]) expect(validTabTitleTemplate(value)).toBe(false);
    expect(normalizeTabTitleOverrides({ one: '${host}', two: '${unknown}' })).toEqual({ one: '${host}' });
  });

  it('updates existing titles, preserves manual names, and restores defaults', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 'one', title: 'Server', host: 'server', port: 22, username: 'root' }, 'profile');
    store.addSession({ sessionId: 'two', title: 'Server', host: 'server', port: 22, username: 'root' }, 'profile');
    useAppStore.getState().setTerminalTabTitleTemplate('${name} #${index}');
    expect(useTerminalStore.getState().sessions.map((session) => session.title)).toEqual(['Server #1', 'Server #2']);
    store.reorderSessions('two', 0);
    expect(useTerminalStore.getState().sessions.map((session) => session.title)).toEqual(['Server #2', 'Server #1']);
    store.updateTitle('one', 'Logs');
    useAppStore.getState().setTerminalTabTitleOverride('profile', '${user}@${host}:${port}');
    expect(useTerminalStore.getState().sessions.map((session) => session.title)).toEqual(['root@server:22', 'Logs']);
    store.resetTitle('one');
    expect(useTerminalStore.getState().sessions[1].title).toBe('root@server:22');
    useAppStore.getState().setTerminalTabTitleOverride('profile', null);
    expect(useTerminalStore.getState().sessions[1].title).toBe('Server #1');
  });

  it('retains title mode and session number through workspace restore and reconnect', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 'one', title: 'Server', host: 'server', port: 22, username: 'root' }, 'profile');
    store.updateTitle('one', 'Logs');
    const snapshot = parseTerminalWorkspace(serializeTerminalWorkspace(useTerminalStore.getState().sessions, null));
    useTerminalStore.setState({ sessions: [] });
    store.addRestoredSessions(snapshot.sessions);
    store.reconnectSession('one', { sessionId: 'new', title: 'Server', host: 'server', port: 22, username: 'root' }, 'profile');
    useAppStore.getState().setTerminalTabTitleTemplate('${host} #${index}');
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({ title: 'Logs', manualTitle: 'Logs', titleIndex: 1 });
    store.resetTitle('new');
    expect(useTerminalStore.getState().sessions[0].title).toBe('server #1');
  });

  it('follows profile names and migrates legacy automatic and manual titles', () => {
    const profile = { id: 'profile', name: 'Server', host: 'server', port: 22, username: 'root', authMethod: 'password' as const, createdAt: 0, updatedAt: 0 };
    useProfileStore.setState({ profiles: [profile] });
    const store = useTerminalStore.getState();
    store.addRestoredSessions([
      { sessionId: 'one', title: 'Server', host: 'server', port: 22, username: 'root', profileId: 'profile' },
      { sessionId: 'two', title: 'Logs', host: 'server', port: 22, username: 'root', profileId: 'profile' },
    ]);
    useProfileStore.setState({ profiles: [{ ...profile, name: '' }] });
    expect(useTerminalStore.getState().sessions.map((session) => session.title)).toEqual(['server', 'Logs']);
    useProfileStore.setState({ profiles: [{ ...profile, name: 'Production' }] });
    expect(useTerminalStore.getState().sessions.map((session) => session.title)).toEqual(['Production', 'Logs']);
  });

  it('keeps the pending connection number when the backend assigns a session id', () => {
    const store = useTerminalStore.getState();
    useAppStore.getState().setTerminalTabTitleTemplate('${name} #${index}');
    const attempt = store.beginConnectionAttempt({ title: 'Server', host: 'server', port: 22, username: 'root' });
    store.resolveConnectionAttempt(attempt, { sessionId: 'connected', title: 'Server', host: 'server', port: 22, username: 'root' });
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({ title: 'Server #1', titleIndex: 1, baseTitle: 'Server' });
    useAppStore.getState().setTerminalTabTitleTemplate('${unknown}');
    expect(useAppStore.getState().terminalTabTitleTemplate).toBe('${name} #${index}');
  });
});
