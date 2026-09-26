import { describe, expect, it } from 'vitest';
import { createLogParser } from '../parser';

describe('incremental log parsing', () => {
  it('preserves complete records and extends partial multiline records without mutating prior results', () => {
    const parse = createLogParser();
    const first = '[2026-09-26][12:00:00][INFO][app] ready\r\n';
    const partial = `${first}[2026-09-26][12:00:01][ERROR][app] fail`;
    const before = parse(partial);
    const after = parse(`${partial}ed\r\n  stack trace\r\n`);
    expect(after[0]).toBe(before[0]);
    expect(before[1].message).toBe('fail');
    expect(after[1].message).toBe('failed\n  stack trace');
    expect(parse(`${partial}ed\r\n  stack trace\r\n`)).toBe(after);
    expect(parse('')).toEqual([]);
    expect(parse(first)).toHaveLength(1);
  });

  it('matches a fresh parse at every possible text chunk boundary', () => {
    const content = 'startup\r\n[2026-09-26][12:00:00][INFO][app] 中文\r\n  details\n[2026-09-26][12:00:01][WARN] retry\n';
    const incremental = createLogParser();
    for (let end = 1; end <= content.length; end += 1) {
      const prefix = content.slice(0, end);
      expect(incremental(prefix)).toEqual(createLogParser()(prefix));
    }
    expect(incremental('replacement\n')).toEqual([{ raw: 'replacement' }]);
  });
});
