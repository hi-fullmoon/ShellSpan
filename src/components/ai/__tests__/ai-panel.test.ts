import { describe, expect, it } from 'vitest';
import { extractSingleLineCommand } from '../ai-panel';

describe('extractSingleLineCommand', () => {
  it('extracts a single-line fenced shell command', () => {
    expect(extractSingleLineCommand('Use this:\n```bash\ndf -h\n```')).toBe('df -h');
  });

  it('rejects multi-line command blocks so insertion cannot execute earlier lines', () => {
    expect(extractSingleLineCommand('```bash\ncd /tmp\nrm file\n```')).toBeUndefined();
  });
});
