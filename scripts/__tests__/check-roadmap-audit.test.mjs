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

  it('requires every committed ROADMAP bullet to map exactly and in order', () => {
    withChangedAudit(
      (audit) => { audit.roadmapMapping.NOW[0].items.pop(); },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('items are not an exact ordered ROADMAP mapping');
      },
    );
  });

  it('requires an explicit existing product roadmap audit source', () => {
    withChangedAudit(
      (audit) => { audit.roadmapSource = 'docs/missing-product-roadmap.md'; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('roadmapSource does not exist');
      },
    );
  });

  it('maps every P0 exit criterion exactly and in order', () => {
    withChangedAudit(
      (audit) => { audit.p0ExecutionFoundation.exitCriteria.pop(); },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('exitCriteria is not an exact ordered P0 design mapping');
      },
    );
  });

  it('does not let the P0 audit status get ahead of the agent roadmap', () => {
    withChangedAudit(
      (audit) => { audit.p0ExecutionFoundation.status = 'verified'; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('P0 status mismatch');
      },
    );
  });

  it('keeps P1 admission blocked until P0 is verified', () => {
    withChangedAudit(
      (audit) => { audit.p0ExecutionFoundation.p1Admission.status = 'eligible'; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('P1 admission must stay blocked until P0 is verified');
      },
    );
  });

  it('rejects a committed workstream that is merely in progress', () => {
    withChangedAudit(
      (audit) => { audit.items.find((item) => item.id === 'now-quality-gates').status = 'in-progress'; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('is a committed workstream and must be verified');
      },
    );
  });

  it('requires an exact mapping for every phase exit condition', () => {
    withChangedAudit(
      (audit) => { audit.phaseExitCriteria.NEXT[0].roadmapItem += '（近似文本）'; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('phaseExitCriteria is not an exact ordered ROADMAP mapping');
      },
    );
  });

  it('does not allow critical security closure to disappear or become unverified', () => {
    withChangedAudit(
      (audit) => { audit.securityClosure.knownHostsFailClosed.status = 'in-progress'; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('securityClosure.knownHostsFailClosed must be verified');
      },
    );
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

  it('requires user value evidence independently from the user group', () => {
    withChangedAudit(
      (audit) => { delete audit.items.find((item) => item.phase === 'EXPLORE').criteria.userValue; },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('is missing EXPLORE criterion userValue');
      },
    );
  });

  it('does not allow a stable extension contract before admission evidence is complete', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('插件 API'));
        item.extensionGates.dataContract = 'stable';
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('cannot record a stable data contract');
      },
    );
  });

  it('keeps plugin API evaluation blocked until the data contract is stable', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('插件 API'));
        item.extensionGates.pluginApi = 'candidate';
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('plugin API evaluation requires a stable data contract');
      },
    );
  });

  it('requires the protocol EXPLORE item to record its single-direction gate', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('一次只验证一个方向'));
        delete item.protocolGates;
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('is missing protocolGates');
      },
    );
  });

  it('does not allow multiple protocol directions to be validated together', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('一次只验证一个方向'));
        item.protocolGates.directionsUnderValidation.push('serial');
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('must validate exactly its one selected protocol direction');
      },
    );
  });

  it('requires a named protocol instead of a generic other direction', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('一次只验证一个方向'));
        item.protocolGates.selectedDirection = 'other';
        item.protocolGates.directionsUnderValidation = ['other'];
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('has invalid selected protocol direction other');
      },
    );
  });

  it('blocks a protocol candidate foundation until every admission gate is complete', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('一次只验证一个方向'));
        item.protocolGates.implementationGate = 'eligible';
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('cannot enable a protocol candidate foundation');
      },
    );
  });

  it('requires the team EXPLORE item to record its workspace and discovery gates', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('团队共享'));
        delete item.teamDiscoveryGates;
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('is missing teamDiscoveryGates');
      },
    );
  });

  it('requires all three team service problems to be compared independently', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('团队共享'));
        item.teamDiscoveryGates.comparedObjects = ['team-sharing', 'central-audit'];
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('must compare team sharing, central policy, and central audit independently');
      },
    );
  });

  it('does not mark the personal workspace stable while a prerequisite is unmet', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('团队共享'));
        item.teamDiscoveryGates.personalWorkspaceModel = 'stable';
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('cannot mark the personal workspace stable');
      },
    );
  });

  it('requires every named personal workspace prerequisite', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('团队共享'));
        delete item.teamDiscoveryGates.prerequisites.knownHosts;
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('is missing personal workspace prerequisite knownHosts');
      },
    );
  });

  it('blocks team product discovery until the personal workspace is stable', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('团队共享'));
        item.teamDiscoveryGates.productDiscoveryGate = 'eligible';
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('cannot enter team product discovery');
      },
    );
  });

  it('blocks independent team review until discovery and admission are complete', () => {
    withChangedAudit(
      (audit) => {
        const item = audit.items.find((candidate) => candidate.roadmapItem?.includes('团队共享'));
        for (const prerequisite of Object.values(item.teamDiscoveryGates.prerequisites)) {
          prerequisite.status = 'met';
        }
        item.teamDiscoveryGates.personalWorkspaceModel = 'stable';
        item.teamDiscoveryGates.productDiscoveryGate = 'eligible';
        item.teamDiscoveryGates.independentReviewGate = 'eligible';
      },
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('cannot enter independent team review');
      },
    );
  });
});
