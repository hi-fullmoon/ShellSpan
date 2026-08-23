import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('roadmap audit', () => {
  const root = resolve(import.meta.dirname, '..', '..');

  function runAudit(auditPath) {
    return spawnSync(process.execPath, ['scripts/check-roadmap-audit.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(auditPath ? { TERMBRIDGE_ROADMAP_AUDIT_PATH: auditPath } : {}),
      },
    });
  }

  function withChangedAudit(change, check) {
    const directory = mkdtempSync(join(tmpdir(), 'termbridge-roadmap-audit-'));
    try {
      const audit = JSON.parse(readFileSync(resolve(root, 'docs/roadmap-audit.json'), 'utf8'));
      change(audit);
      const auditPath = join(directory, 'roadmap-audit.json');
      writeFileSync(auditPath, JSON.stringify(audit));
      check(runAudit(auditPath));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('is complete and internally consistent', () => {
    const result = runAudit();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toMatch(/Roadmap audit valid/);
  });

  it('requires every EXPLORE audit to map one exact ROADMAP item', () => {
    withChangedAudit(
      (audit) => { delete audit.items.find((item) => item.phase === 'EXPLORE').roadmapItem; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('is missing roadmapItem');
      },
    );
  });

  it('rejects an EXPLORE roadmapItem that only contains a ROADMAP item', () => {
    withChangedAudit(
      (audit) => { audit.items.find((item) => item.phase === 'EXPLORE').roadmapItem += '（近似文本）'; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('roadmapItem is not an exact ROADMAP item');
      },
    );
  });

  it('requires existing test evidence even while an EXPLORE item is researching', () => {
    withChangedAudit(
      (audit) => { audit.items.find((item) => item.phase === 'EXPLORE').tests = []; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('needs existing test evidence while researching EXPLORE');
      },
    );
  });
});
