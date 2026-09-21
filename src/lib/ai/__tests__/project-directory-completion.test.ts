import { describe, expect, it } from 'vitest';
import { directoryQuery } from '../project-directory-completion';

describe('project directory query boundaries', () => {
  it('splits an absolute directory prefix without losing spaces or Unicode', () => {
    expect(directoryQuery('/Users/项目 space', true)).toEqual({ parent: '/Users/', prefix: '项目 space', separator: '/' });
    expect(directoryQuery('/Users/', false)).toEqual({ parent: '/Users/', prefix: '', separator: '/' });
    expect(directoryQuery('/', true)).toEqual({ parent: '/', prefix: '', separator: '/' });
  });
  it('supports local Windows drive paths without interpreting remote paths as Windows', () => {
    expect(directoryQuery('C:\\Users\\pro', true)).toEqual({ parent: 'C:\\Users\\', prefix: 'pro', separator: '\\' });
    expect(directoryQuery('C:/Users/pro', true)).toEqual({ parent: 'C:/Users/', prefix: 'pro', separator: '/' });
    expect(directoryQuery('C:\\Users\\pro', false)).toBeNull();
  });
  it('does not browse relative paths or paths with control characters', () => {
    for (const value of ['', 'src', '~/src', '/tmp/\n', '/tmp/\0', '/tmp/\x7f']) {
      expect(directoryQuery(value, true)).toBeNull();
      expect(directoryQuery(value, false)).toBeNull();
    }
  });
});
