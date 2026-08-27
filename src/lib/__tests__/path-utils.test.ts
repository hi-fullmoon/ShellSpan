import { describe, expect, it } from 'vitest';
import {
  isPosixRootPath,
  isPortableRootPath,
  normalizePortablePath,
  parentPosixPath,
  parentPortablePath,
  parsePosixPath,
  parsePortablePath,
} from '../path-utils';

describe('portable path utilities', () => {
  it('normalizes Windows drive and verbatim paths to slash-separated paths', () => {
    expect(normalizePortablePath('C:\\Users\\tester')).toBe('C:/Users/tester');
    expect(normalizePortablePath('\\\\?\\C:\\Users\\tester')).toBe('C:/Users/tester');
  });

  it('normalizes Windows UNC paths without losing the network root', () => {
    expect(normalizePortablePath('\\\\?\\UNC\\server\\share\\folder')).toBe(
      '//server/share/folder',
    );
  });

  it('builds navigable segments for drive, UNC, and POSIX paths', () => {
    expect(parsePortablePath('C:/Users/tester')).toMatchObject({
      rootPath: 'C:/',
      segments: [
        { name: 'Users', path: 'C:/Users' },
        { name: 'tester', path: 'C:/Users/tester' },
      ],
    });
    expect(parsePortablePath('//server/share/folder').rootPath).toBe('//server/share/');
    expect(parsePortablePath('/Users/tester').segments[1]?.path).toBe('/Users/tester');
  });

  it('keeps parent navigation inside each platform root', () => {
    expect(parentPortablePath('C:/Users/tester')).toBe('C:/Users');
    expect(parentPortablePath('C:/Users')).toBe('C:/');
    expect(parentPortablePath('//server/share/folder')).toBe('//server/share/');
    expect(parentPortablePath('/Users')).toBe('/');
    expect(isPortableRootPath('C:/')).toBe(true);
    expect(isPortableRootPath('//server/share/')).toBe(true);
  });

  it('preserves remote POSIX backslashes in segment names and targets', () => {
    expect(parsePosixPath('/home/name\\with\\slashes/child')).toMatchObject({
      rootPath: '/',
      segments: [
        { name: 'home', path: '/home' },
        { name: 'name\\with\\slashes', path: '/home/name\\with\\slashes' },
        {
          name: 'child',
          path: '/home/name\\with\\slashes/child',
        },
      ],
    });
    expect(parentPosixPath('/home/name\\with\\slashes/child')).toBe(
      '/home/name\\with\\slashes',
    );
  });

  it('does not reinterpret a leading double slash as a remote UNC root', () => {
    expect(parsePosixPath('//server/share')).toMatchObject({
      rootLabel: '/',
      rootPath: '/',
      segments: [
        { name: 'server', path: '//server' },
        { name: 'share', path: '//server/share' },
      ],
    });
    expect(parentPosixPath('//server/share')).toBe('//server');
    expect(isPosixRootPath('//server/share/')).toBe(false);
  });
});
