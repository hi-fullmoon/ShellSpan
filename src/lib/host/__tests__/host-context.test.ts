import { describe, expect, it } from 'vitest';
import { buildChangeDirectoryCommand } from '../host-context';

describe('buildChangeDirectoryCommand', () => {
  it('quotes spaces and apostrophes as a single shell argument', () => {
    expect(buildChangeDirectoryCommand("/srv/Release Candidate/O'Brien")).toBe(
      "cd -- '/srv/Release Candidate/O'\\''Brien'\r",
    );
  });

  it('rejects empty paths and line-control characters', () => {
    expect(buildChangeDirectoryCommand('')).toBeUndefined();
    expect(buildChangeDirectoryCommand('/tmp\nwhoami')).toBeUndefined();
    expect(buildChangeDirectoryCommand('/tmp\rwhoami')).toBeUndefined();
    expect(buildChangeDirectoryCommand('/tmp\0whoami')).toBeUndefined();
  });
});
