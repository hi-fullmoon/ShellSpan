import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const auditPath = resolve(root, 'docs/roadmap-audit.json');
const roadmapPath = resolve(root, 'ROADMAP.md');
const allowedPhases = new Set(['NOW', 'NEXT', 'LATER']);
const allowedStatuses = new Set(['planned', 'in-progress', 'verified', 'blocked', 'deferred']);
const requiredPhases = ['NOW', 'NEXT', 'LATER'];
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
}

for (const phase of requiredPhases) {
  if (!roadmap.includes(`## ${phase}`)) fail(`ROADMAP.md is missing phase ${phase}`);
  if (!audit.items.some((item) => item.phase === phase)) fail(`audit has no ${phase} items`);
}

const totals = Object.fromEntries(
  [...allowedStatuses].map((status) => [status, audit.items.filter((item) => item.status === status).length]),
);
console.log(`Roadmap audit valid: ${audit.items.length} workstreams (${JSON.stringify(totals)})`);
