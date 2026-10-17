import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '@/types';
import { readConnectionSort, saveConnectionSort, sortConnections } from '../connection-sort';

const profile = (id: string, name: string, createdAt: number): ConnectionProfile => ({
  id, name, createdAt, updatedAt: createdAt, host: `${id}.example.org`,
  port: 22, username: 'operator', authMethod: 'key',
});

describe('connection sorting', () => {
  beforeEach(() => localStorage.clear());
  const profiles = [profile('a', 'Server 10', 10), profile('b', 'server 2', 30), profile('c', 'Alpha', 20)];

  it('keeps current order by default and never mutates source profiles', () => {
    const original = [...profiles];
    expect(readConnectionSort()).toBe('default');
    expect(sortConnections(profiles, 'default', ['b'], 'en-US')).toEqual(original);
    sortConnections(profiles, 'name', [], 'en-US');
    expect(profiles).toEqual(original);
  });

  it('sorts names naturally and falls back to the host for blank names', () => {
    expect(sortConnections(profiles, 'name', [], 'en-US').map(item => item.id)).toEqual(['c', 'b', 'a']);
    expect(sortConnections([profile('z', ' ', 0), profile('a', '', 0)], 'name', [], 'en-US').map(item => item.id)).toEqual(['a', 'z']);
  });

  it('uses recent activity order and preserves source order for remaining profiles', () => {
    expect(sortConnections(profiles, 'recent', ['deleted', 'b', 'c'], 'en-US').map(item => item.id)).toEqual(['b', 'c', 'a']);
    expect(sortConnections(profiles, 'recent', [], 'en-US')).toEqual(profiles);
  });

  it('sorts creation time newest first and keeps equal dates stable', () => {
    expect(sortConnections(profiles, 'created', [], 'en-US').map(item => item.id)).toEqual(['b', 'c', 'a']);
    const tied = [profile('z', 'Z', 5), profile('a', 'A', 5)];
    expect(sortConnections(tied, 'created', [], 'en-US')).toEqual(tied);
  });

  it('remembers the selected mode and safely falls back for invalid saved values', () => {
    saveConnectionSort('created');
    expect(readConnectionSort()).toBe('created');
    localStorage.setItem('shellspan.connections.sort', 'invalid');
    expect(readConnectionSort()).toBe('default');
  });
});
