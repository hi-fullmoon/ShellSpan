import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main window notification capability', () => {
  it('allows the notification plugin to query permission during initialization', () => {
    const capability = JSON.parse(
      readFileSync(resolve('src-tauri/capabilities/default.json'), 'utf8'),
    ) as { windows: string[]; permissions: string[] };

    expect(capability.windows).toContain('main');
    expect(capability.permissions).toContain('notification:allow-is-permission-granted');
  });
});
