import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

const SHELLSPAN_ROOT = process.env.SHELLSPAN_PHASE0_ROOT
  ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_ROOT = process.env.SHELLSPAN_DEEPSEEK_HARNESS_ROOT
  ?? join(SHELLSPAN_ROOT, '..', 'deepseek-harness');
const READY_FILE = process.env.SHELLSPAN_PHASE0_TARGET_READY
  ?? '/tmp/shellspan-phase0-target-ready.json';
const DONE_FILE = process.env.SHELLSPAN_PHASE0_TARGET_DONE
  ?? '/tmp/shellspan-phase0-target-done';

test('holds the keyless DeepSeek Harness seeded-history target for Phase 0 capture', async () => {
  const scaffoldModule = await import(pathToFileURL(join(
    REFERENCE_ROOT,
    'apps/web/tests/scaffold.ts',
  )).href);
  const scaffold = await scaffoldModule.launchWebScaffold({});
  try {
    const raw = await readFile(join(
      SHELLSPAN_ROOT,
      'docs/ai-panel-phase0/fixtures/deepseek-target-hello.session.jsonl',
    ), 'utf8');
    await scaffoldModule.seedSession(scaffold, raw, 'shellspan-phase0-target');
    await unlink(DONE_FILE).catch(() => {});
    await writeFile(READY_FILE, `${JSON.stringify({
      authenticatedUrl: scaffold.authenticatedUrl,
      sessionTitle: 'Phase 0 hello',
    })}\n`);

    const deadline = Date.now() + 180_000;
    while (!existsSync(DONE_FILE) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(DONE_FILE)).toBe(true);
  } finally {
    await unlink(READY_FILE).catch(() => {});
    await unlink(DONE_FILE).catch(() => {});
    await scaffold.close();
  }
}, 200_000);
