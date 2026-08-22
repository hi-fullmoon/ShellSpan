import { describe, expect, it } from 'vitest';
import { parseTerminalWorkspace, serializeTerminalWorkspace } from '../terminal-workspace';
import type { TerminalSession } from '@/stores/terminalStore';
import type { TerminalSplitState } from '@/components/terminal/terminal-split';

describe('terminal workspace serialization', () => {
  it('persists only profile-backed restorable metadata and layout', () => {
    const sessions: TerminalSession[] = [
      {
        sessionId: 'session-1',
        title: 'Production',
        host: 'prod.example.com',
        port: 22,
        username: 'alice',
        status: 'connected',
        statusMessage: 'ready',
        profileId: 'profile-1',
        pinned: true,
        color: '#22d3ee',
      },
      {
        sessionId: 'local-1',
        title: 'Local',
        host: '',
        port: 0,
        username: '',
        status: 'connected',
      },
    ];

    const layout: TerminalSplitState = {
      kind: 'split',
      orientation: 'horizontal',
      first: {
        kind: 'group',
        id: 'first',
        sessionIds: ['session-1'],
        activeSessionId: 'session-1',
      },
      second: {
        kind: 'group',
        id: 'second',
        sessionIds: [],
        activeSessionId: '',
      },
    };

    expect(JSON.parse(serializeTerminalWorkspace(sessions, layout))).toEqual({
      sessions: [{
        sessionId: 'session-1',
        title: 'Production',
        host: 'prod.example.com',
        port: 22,
        username: 'alice',
        profileId: 'profile-1',
        pinned: true,
        color: '#22d3ee',
      }],
      layout,
    });
  });

  it('round-trips workspace snapshot including layout', () => {
    const sessions: TerminalSession[] = [{
      sessionId: 'session-1',
      title: 'Production',
      host: 'prod.example.com',
      port: 22,
      username: 'alice',
      status: 'connected',
      profileId: 'profile-1',
      conversationId: 'conversation-1',
      conversationStartedAt: '2026-08-22T09:00:00.000Z',
    }];
    const layout: TerminalSplitState = {
      kind: 'split',
      orientation: 'vertical',
      split: 0.37,
      first: {
        kind: 'group',
        id: 'first',
        sessionIds: ['session-1'],
        activeSessionId: 'session-1',
      },
      second: {
        kind: 'group',
        id: 'second',
        sessionIds: ['session-2'],
        activeSessionId: 'session-2',
      },
    };

    const serialized = serializeTerminalWorkspace(sessions, layout);
    const parsed = parseTerminalWorkspace(serialized);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      title: 'Production',
      profileId: 'profile-1',
      conversationId: 'conversation-1',
      conversationStartedAt: '2026-08-22T09:00:00.000Z',
    });
    expect(parsed.layout).toEqual(layout);
  });

  it('ignores corrupt and invalid workspace entries', () => {
    expect(parseTerminalWorkspace('not-json')).toEqual({ sessions: [], layout: null });
    expect(parseTerminalWorkspace(JSON.stringify({
      sessions: [
        { title: 'Missing profile', host: 'example.com', port: 22, username: 'alice' },
        {
          sessionId: 's1',
          title: 'Valid',
          host: 'example.com',
          port: 22,
          username: 'alice',
          profileId: 'profile-1',
        },
      ],
      layout: { kind: 'invalid' },
    }))).toEqual({
      sessions: [{
        sessionId: 's1',
        title: 'Valid',
        host: 'example.com',
        port: 22,
        username: 'alice',
        profileId: 'profile-1',
      }],
      layout: null,
    });
  });

  it('rejects malformed layout nodes', () => {
    const raw = JSON.stringify({
      sessions: [{
        sessionId: 's1',
        title: 'Valid',
        host: 'example.com',
        port: 22,
        username: 'alice',
        profileId: 'profile-1',
      }],
      layout: {
        kind: 'split',
        orientation: 'horizontal',
        first: { kind: 'group', id: 'first', sessionIds: ['s1'], activeSessionId: 's1' },
        second: { kind: 'group', id: 'second', sessionIds: [1], activeSessionId: 's2' },
      },
    });
    const parsed = parseTerminalWorkspace(raw);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.layout).toBeNull();
  });

  it('rejects an invalid persisted split ratio', () => {
    const parsed = parseTerminalWorkspace(JSON.stringify({
      sessions: [],
      layout: {
        kind: 'split',
        orientation: 'horizontal',
        split: 1.5,
        first: { kind: 'group', id: 'first', sessionIds: [], activeSessionId: '' },
        second: { kind: 'group', id: 'second', sessionIds: [], activeSessionId: '' },
      },
    }));

    expect(parsed.layout).toBeNull();
  });
});
