import { describe, expect, it } from 'vitest';
import { parseTerminalWorkspace, serializeTerminalWorkspace } from '../terminal-workspace';
import type { TerminalSession } from '@/stores/terminalStore';

describe('terminal workspace serialization', () => {
  it('persists only profile-backed restorable metadata', () => {
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

    expect(JSON.parse(serializeTerminalWorkspace(sessions))).toEqual([{
      title: 'Production',
      host: 'prod.example.com',
      port: 22,
      username: 'alice',
      profileId: 'profile-1',
      pinned: true,
      color: '#22d3ee',
    }]);
  });

  it('ignores corrupt and invalid workspace entries', () => {
    expect(parseTerminalWorkspace('not-json')).toEqual([]);
    expect(parseTerminalWorkspace(JSON.stringify([
      { title: 'Missing profile', host: 'example.com', port: 22, username: 'alice' },
      {
        title: 'Valid',
        host: 'example.com',
        port: 22,
        username: 'alice',
        profileId: 'profile-1',
      },
    ]))).toEqual([{
      title: 'Valid',
      host: 'example.com',
      port: 22,
      username: 'alice',
      profileId: 'profile-1',
    }]);
  });
});
