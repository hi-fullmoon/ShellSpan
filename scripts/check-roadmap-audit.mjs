import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const auditPath = resolve(root, 'docs/roadmap-audit.json');
const roadmapPath = resolve(root, 'ROADMAP.md');
const allowedPhases = new Set(['NOW', 'NEXT', 'LATER', 'EXPLORE']);
const allowedStatuses = new Set(['planned', 'in-progress', 'verified', 'blocked', 'deferred', 'researching']);
const requiredPhases = ['NOW', 'NEXT', 'LATER', 'EXPLORE'];
const exploreCriteria = [
  'userGroup',
  'maintenanceCost',
  'crossPlatformImplementation',
  'securityModel',
  'upgradeStrategy',
  'automatedTesting',
];
const allowedExploreCriterionStatuses = new Set(['met', 'not-met', 'unknown']);
const allowedExploreDecisions = new Set(['candidate', 'admit', 'defer']);
const maximumReviewAgeDays = 35;

function fail(message) {
  throw new Error(`roadmap audit: ${message}`);
}

async function assertEvidenceExists(item, path) {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}\\`) && !absolute.startsWith(`${root}/`)) {
    fail(`${item.id} evidence escapes the repository: ${path}`);
  }
  await access(absolute).catch(() => fail(`${item.id} evidence does not exist: ${path}`));
}

const [rawAudit, roadmap] = await Promise.all([
  readFile(auditPath, 'utf8'),
  readFile(roadmapPath, 'utf8'),
]);
const audit = JSON.parse(rawAudit);

if (audit.schemaVersion !== 1) fail('schemaVersion must be 1');
if (!Array.isArray(audit.items) || audit.items.length === 0) fail('items must not be empty');

const reviewedAt = new Date(`${audit.reviewedAt}T00:00:00Z`);
if (Number.isNaN(reviewedAt.getTime())) fail('reviewedAt must use YYYY-MM-DD');
const reviewAgeDays = Math.floor((Date.now() - reviewedAt.getTime()) / 86_400_000);
if (reviewAgeDays > maximumReviewAgeDays) {
  fail(`review is stale (${reviewAgeDays} days); refresh reviewedAt and reassess every item`);
}

const ids = new Set();
for (const item of audit.items) {
  for (const field of ['id', 'phase', 'title', 'status', 'owner', 'risk', 'failurePath', 'recovery', 'testStrategy']) {
    if (typeof item[field] !== 'string' || item[field].trim() === '') {
      fail(`${item.id ?? '<unknown>'} is missing ${field}`);
    }
  }
  if (ids.has(item.id)) fail(`duplicate id: ${item.id}`);
  ids.add(item.id);
  if (!allowedPhases.has(item.phase)) fail(`${item.id} has invalid phase ${item.phase}`);
  if (!allowedStatuses.has(item.status)) fail(`${item.id} has invalid status ${item.status}`);
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    fail(`${item.id} needs at least one evidence path`);
  }
  await Promise.all(item.evidence.map((path) => assertEvidenceExists(item, path)));
  if (item.status === 'verified') {
    if (!item.verifiedAt || !Array.isArray(item.tests) || item.tests.length === 0) {
      fail(`${item.id} is verified without verifiedAt and test evidence`);
    }
    await Promise.all(item.tests.map((path) => assertEvidenceExists(item, path)));
  }
  if (item.status === 'researching' && item.phase !== 'EXPLORE') {
    fail(`${item.id} uses researching outside EXPLORE`);
  }
  if (item.phase === 'EXPLORE') {
    if (!allowedExploreDecisions.has(item.decision)) {
      fail(`${item.id} has invalid EXPLORE decision ${item.decision}`);
    }
    if (typeof item.decisionRationale !== 'string' || item.decisionRationale.trim() === '') {
      fail(`${item.id} is missing decisionRationale`);
    }
    if (typeof item.necessary !== 'boolean') {
      fail(`${item.id} is missing the EXPLORE necessity decision`);
    }
    if (typeof item.necessityFinding !== 'string' || item.necessityFinding.trim() === '') {
      fail(`${item.id} is missing necessityFinding`);
    }
    if (!item.criteria || typeof item.criteria !== 'object' || Array.isArray(item.criteria)) {
      fail(`${item.id} is missing EXPLORE criteria`);
    }
    for (const criterionName of exploreCriteria) {
      const criterion = item.criteria[criterionName];
      if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) {
        fail(`${item.id} is missing EXPLORE criterion ${criterionName}`);
      }
      if (!allowedExploreCriterionStatuses.has(criterion.status)) {
        fail(`${item.id} ${criterionName} has invalid status ${criterion.status}`);
      }
      if (typeof criterion.finding !== 'string' || criterion.finding.trim() === '') {
        fail(`${item.id} ${criterionName} is missing finding`);
      }
    }
    const unexpectedCriteria = Object.keys(item.criteria).filter(
      (criterionName) => !exploreCriteria.includes(criterionName),
    );
    if (unexpectedCriteria.length > 0) {
      fail(`${item.id} has unknown EXPLORE criteria: ${unexpectedCriteria.join(', ')}`);
    }
    if (item.decision === 'admit'
      && exploreCriteria.some((criterionName) => item.criteria[criterionName].status !== 'met')) {
      fail(`${item.id} cannot be admitted before every EXPLORE criterion is met`);
    }
    if (item.decision === 'admit' && (!item.necessary || item.status !== 'verified')) {
      fail(`${item.id} admission requires explicit necessity and verified test evidence`);
    }
    if (item.decision === 'candidate' && item.status !== 'researching') {
      fail(`${item.id} candidate decision must use researching status`);
    }
    if (item.decision === 'defer' && item.status !== 'deferred') {
      fail(`${item.id} defer decision must use deferred status`);
    }
  }
}

for (const phase of requiredPhases) {
  if (!roadmap.includes(`## ${phase}`)) fail(`ROADMAP.md is missing phase ${phase}`);
  if (!audit.items.some((item) => item.phase === phase)) fail(`audit has no ${phase} items`);
}

const totals = Object.fromEntries(
  [...allowedStatuses].map((status) => [status, audit.items.filter((item) => item.status === status).length]),
);
console.log(`Roadmap audit valid: ${audit.items.length} workstreams (${JSON.stringify(totals)})`);
