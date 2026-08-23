import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const auditPath = resolve(root, process.env.TERMBRIDGE_ROADMAP_AUDIT_PATH ?? 'docs/roadmap-audit.json');
const roadmapPath = resolve(root, 'ROADMAP.md');
const allowedPhases = new Set(['NOW', 'NEXT', 'LATER', 'EXPLORE']);
const allowedStatuses = new Set(['planned', 'in-progress', 'verified', 'blocked', 'deferred', 'researching']);
const requiredPhases = ['NOW', 'NEXT', 'LATER', 'EXPLORE'];
const exploreCriteria = [
  'userGroup',
  'userValue',
  'maintenanceCost',
  'crossPlatformImplementation',
  'securityModel',
  'upgradeStrategy',
  'automatedTesting',
];
const allowedExploreCriterionStatuses = new Set(['met', 'not-met', 'unknown']);
const allowedExploreDecisions = new Set(['candidate', 'admit', 'defer']);
const singleProtocolRoadmapItem = '基于真实使用场景评估动态 SOCKS 转发、串口、Mosh 或其他协议，一次只验证一个方向。';
const allowedProtocolDirections = new Set(['dynamic-socks', 'serial', 'mosh']);
const teamDiscoveryRoadmapItem = '团队共享、集中策略与审计服务仅在个人工作区模型稳定后进入产品发现。';
const teamWorkspacePrerequisites = [
  'connectionCredentials',
  'knownHosts',
  'sessionWorkspaceRecovery',
  'runbookMultiHost',
  'operationHistory',
  'redactedExport',
  'localDatabase',
  'authorizationApproval',
  'crossPlatform',
  'automatedTesting',
];
const teamDiscoveryObjects = ['team-sharing', 'central-policy', 'central-audit'];
const maximumReviewAgeDays = 35;
const committedPhases = ['NOW', 'NEXT', 'LATER'];
const requiredSecurityClosures = [
  'knownHostsFailClosed',
  'aiApiKeyKeychainOnly',
  'terminalWorkspaceContract',
];
const rustWorkflowPaths = [
  '.github/workflows/quality-gate.yml',
  '.github/workflows/cache-warm.yml',
  '.github/workflows/release.yml',
];

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

function parseRoadmap(markdown) {
  const phases = Object.fromEntries(requiredPhases.map((phase) => [phase, {
    sections: new Map(),
    exitCriteria: [],
    candidates: [],
  }]));
  let phase = null;
  let section = null;
  let inExitCriteria = false;
  for (const line of markdown.split(/\r?\n/)) {
    const phaseMatch = line.match(/^## (NOW|NEXT|LATER|EXPLORE)\b/);
    if (phaseMatch) {
      phase = phaseMatch[1];
      section = null;
      inExitCriteria = false;
      continue;
    }
    if (line.startsWith('## ')) {
      phase = null;
      section = null;
      inExitCriteria = false;
      continue;
    }
    if (!phase) continue;
    if (line === '### 退出条件') {
      section = null;
      inExitCriteria = true;
      continue;
    }
    const sectionMatch = line.match(/^### (\d+\. .+)$/);
    if (sectionMatch && phase !== 'EXPLORE') {
      section = sectionMatch[1];
      inExitCriteria = false;
      if (phases[phase].sections.has(section)) fail(`ROADMAP.md has duplicate section ${phase}/${section}`);
      phases[phase].sections.set(section, []);
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const item = line.slice(2);
    if (phase === 'EXPLORE') phases.EXPLORE.candidates.push(item);
    else if (inExitCriteria) phases[phase].exitCriteria.push(item);
    else if (section) phases[phase].sections.get(section).push(item);
  }
  return phases;
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

const [rawAudit, roadmap] = await Promise.all([
  readFile(auditPath, 'utf8'),
  readFile(roadmapPath, 'utf8'),
]);
const audit = JSON.parse(rawAudit);
const parsedRoadmap = parseRoadmap(roadmap);
const roadmapItems = new Set(
  roadmap
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2)),
);

if (audit.schemaVersion !== 1) fail('schemaVersion must be 1');
if (!Array.isArray(audit.items) || audit.items.length === 0) fail('items must not be empty');
if (!audit.roadmapMapping || typeof audit.roadmapMapping !== 'object' || Array.isArray(audit.roadmapMapping)) {
  fail('roadmapMapping must map every committed ROADMAP section');
}
if (!audit.phaseExitCriteria || typeof audit.phaseExitCriteria !== 'object' || Array.isArray(audit.phaseExitCriteria)) {
  fail('phaseExitCriteria must map every phase exit condition');
}

const reviewedAt = new Date(`${audit.reviewedAt}T00:00:00Z`);
if (Number.isNaN(reviewedAt.getTime())) fail('reviewedAt must use YYYY-MM-DD');
const reviewAgeDays = Math.floor((Date.now() - reviewedAt.getTime()) / 86_400_000);
if (reviewAgeDays > maximumReviewAgeDays) {
  fail(`review is stale (${reviewAgeDays} days); refresh reviewedAt and reassess every item`);
}

const ids = new Set();
const exploreRoadmapItems = new Set();
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
  if (item.phase !== 'EXPLORE' && item.status !== 'verified') {
    fail(`${item.id} is a committed workstream and must be verified, not ${item.status}`);
  }
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
    if (typeof item.roadmapItem !== 'string' || item.roadmapItem.trim() === '') {
      fail(`${item.id} is missing roadmapItem`);
    }
    if (!roadmapItems.has(item.roadmapItem)) {
      fail(`${item.id} roadmapItem is not an exact ROADMAP item: ${item.roadmapItem}`);
    }
    if (exploreRoadmapItems.has(item.roadmapItem)) {
      fail(`duplicate EXPLORE roadmapItem: ${item.roadmapItem}`);
    }
    exploreRoadmapItems.add(item.roadmapItem);
    if (!Array.isArray(item.tests) || item.tests.length === 0) {
      fail(`${item.id} needs existing test evidence while researching EXPLORE`);
    }
    await Promise.all(item.tests.map((path) => assertEvidenceExists(item, path)));
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
    if (item.roadmapItem.includes('插件 API')) {
      const gates = item.extensionGates;
      if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
        fail(`${item.id} is missing extensionGates`);
      }
      if (!['not-established', 'stable'].includes(gates.dataContract)) {
        fail(`${item.id} has invalid data-contract gate ${gates.dataContract}`);
      }
      if (!['blocked', 'candidate'].includes(gates.pluginApi)) {
        fail(`${item.id} has invalid plugin API gate ${gates.pluginApi}`);
      }
      if (typeof gates.finding !== 'string' || gates.finding.trim() === '') {
        fail(`${item.id} extensionGates is missing finding`);
      }
      if (gates.dataContract === 'stable'
        && (!item.necessary
          || item.status !== 'verified'
          || exploreCriteria.some((criterionName) => item.criteria[criterionName].status !== 'met'))) {
        fail(`${item.id} cannot record a stable data contract before EXPLORE admission evidence is complete`);
      }
      if (gates.pluginApi !== 'blocked' && gates.dataContract !== 'stable') {
        fail(`${item.id} plugin API evaluation requires a stable data contract`);
      }
    }
    if (item.roadmapItem === singleProtocolRoadmapItem) {
      const gates = item.protocolGates;
      if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
        fail(`${item.id} is missing protocolGates`);
      }
      if (!allowedProtocolDirections.has(gates.selectedDirection)) {
        fail(`${item.id} has invalid selected protocol direction ${gates.selectedDirection}`);
      }
      if (!Array.isArray(gates.directionsUnderValidation)
        || gates.directionsUnderValidation.length !== 1
        || gates.directionsUnderValidation[0] !== gates.selectedDirection) {
        fail(`${item.id} must validate exactly its one selected protocol direction`);
      }
      if (!['blocked', 'eligible'].includes(gates.implementationGate)) {
        fail(`${item.id} has invalid protocol implementation gate ${gates.implementationGate}`);
      }
      if (typeof gates.finding !== 'string' || gates.finding.trim() === '') {
        fail(`${item.id} protocolGates is missing finding`);
      }
      if (gates.implementationGate === 'eligible'
        && (item.decision !== 'admit'
          || !item.necessary
          || item.status !== 'verified'
          || exploreCriteria.some((criterionName) => item.criteria[criterionName].status !== 'met'))) {
        fail(`${item.id} cannot enable a protocol candidate foundation before EXPLORE admission evidence is complete`);
      }
    }
    if (item.roadmapItem === teamDiscoveryRoadmapItem) {
      const gates = item.teamDiscoveryGates;
      if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
        fail(`${item.id} is missing teamDiscoveryGates`);
      }
      if (!['not-stable', 'stable'].includes(gates.personalWorkspaceModel)) {
        fail(`${item.id} has invalid personal workspace model ${gates.personalWorkspaceModel}`);
      }
      if (!['blocked', 'eligible'].includes(gates.productDiscoveryGate)) {
        fail(`${item.id} has invalid product discovery gate ${gates.productDiscoveryGate}`);
      }
      if (!['blocked', 'eligible'].includes(gates.independentReviewGate)) {
        fail(`${item.id} has invalid independent review gate ${gates.independentReviewGate}`);
      }
      if (gates.firstDiscoveryObject !== 'secret-free-team-artifact-sharing') {
        fail(`${item.id} has invalid first team discovery object ${gates.firstDiscoveryObject}`);
      }
      if (!Array.isArray(gates.comparedObjects)
        || gates.comparedObjects.length !== teamDiscoveryObjects.length
        || new Set(gates.comparedObjects).size !== teamDiscoveryObjects.length
        || teamDiscoveryObjects.some((object) => !gates.comparedObjects.includes(object))) {
        fail(`${item.id} must compare team sharing, central policy, and central audit independently`);
      }
      if (typeof gates.finding !== 'string' || gates.finding.trim() === '') {
        fail(`${item.id} teamDiscoveryGates is missing finding`);
      }
      if (!gates.prerequisites || typeof gates.prerequisites !== 'object' || Array.isArray(gates.prerequisites)) {
        fail(`${item.id} is missing personal workspace prerequisites`);
      }
      for (const prerequisiteName of teamWorkspacePrerequisites) {
        const prerequisite = gates.prerequisites[prerequisiteName];
        if (!prerequisite || typeof prerequisite !== 'object' || Array.isArray(prerequisite)) {
          fail(`${item.id} is missing personal workspace prerequisite ${prerequisiteName}`);
        }
        if (!allowedExploreCriterionStatuses.has(prerequisite.status)) {
          fail(`${item.id} ${prerequisiteName} has invalid status ${prerequisite.status}`);
        }
        if (typeof prerequisite.finding !== 'string' || prerequisite.finding.trim() === '') {
          fail(`${item.id} ${prerequisiteName} is missing finding`);
        }
      }
      const unexpectedPrerequisites = Object.keys(gates.prerequisites).filter(
        (prerequisiteName) => !teamWorkspacePrerequisites.includes(prerequisiteName),
      );
      if (unexpectedPrerequisites.length > 0) {
        fail(`${item.id} has unknown personal workspace prerequisites: ${unexpectedPrerequisites.join(', ')}`);
      }
      if (gates.personalWorkspaceModel === 'stable'
        && teamWorkspacePrerequisites.some(
          (prerequisiteName) => gates.prerequisites[prerequisiteName].status !== 'met',
        )) {
        fail(`${item.id} cannot mark the personal workspace stable before every prerequisite is met`);
      }
      if (gates.productDiscoveryGate === 'eligible' && gates.personalWorkspaceModel !== 'stable') {
        fail(`${item.id} cannot enter team product discovery before the personal workspace is stable`);
      }
      if (gates.independentReviewGate === 'eligible'
        && (gates.productDiscoveryGate !== 'eligible'
          || item.decision !== 'admit'
          || !item.necessary
          || item.status !== 'verified'
          || exploreCriteria.some((criterionName) => item.criteria[criterionName].status !== 'met'))) {
        fail(`${item.id} cannot enter independent team review before discovery and EXPLORE admission are complete`);
      }
    }
  }
}

for (const phase of committedPhases) {
  const mappings = audit.roadmapMapping[phase];
  if (!Array.isArray(mappings)) fail(`roadmapMapping is missing phase ${phase}`);
  const expectedSections = parsedRoadmap[phase].sections;
  if (mappings.length !== expectedSections.size) {
    fail(`${phase} roadmapMapping has ${mappings.length} sections; ROADMAP.md has ${expectedSections.size}`);
  }
  const mappedSections = new Set();
  const mappedAuditIds = new Set();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      fail(`${phase} roadmapMapping contains an invalid mapping`);
    }
    if (mappedSections.has(mapping.section)) fail(`${phase} has duplicate mapped section ${mapping.section}`);
    if (mappedAuditIds.has(mapping.auditId)) fail(`${phase} has duplicate mapped auditId ${mapping.auditId}`);
    mappedSections.add(mapping.section);
    mappedAuditIds.add(mapping.auditId);
    const expectedItems = expectedSections.get(mapping.section);
    if (!expectedItems) fail(`${phase} mapping section is not exact: ${mapping.section}`);
    if (!sameStrings(mapping.items, expectedItems)) {
      fail(`${phase}/${mapping.section} items are not an exact ordered ROADMAP mapping`);
    }
    const auditItem = audit.items.find((item) => item.id === mapping.auditId);
    if (!auditItem) fail(`${phase}/${mapping.section} maps unknown auditId ${mapping.auditId}`);
    if (auditItem.phase !== phase) fail(`${mapping.auditId} is mapped to ${phase} but belongs to ${auditItem.phase}`);
    if (auditItem.status !== 'verified') fail(`${mapping.auditId} mapping is not verified`);
  }
}

const unexpectedMappedPhases = Object.keys(audit.roadmapMapping)
  .filter((phase) => !committedPhases.includes(phase));
if (unexpectedMappedPhases.length > 0) {
  fail(`roadmapMapping has unknown phases: ${unexpectedMappedPhases.join(', ')}`);
}

for (const phase of committedPhases) {
  const criteria = audit.phaseExitCriteria[phase];
  const expectedCriteria = parsedRoadmap[phase].exitCriteria;
  if (!Array.isArray(criteria) || criteria.length !== expectedCriteria.length) {
    fail(`${phase} phaseExitCriteria must map all ${expectedCriteria.length} ROADMAP exit conditions`);
  }
  const actualCriteria = criteria.map((criterion) => criterion?.roadmapItem);
  if (!sameStrings(actualCriteria, expectedCriteria)) {
    fail(`${phase} phaseExitCriteria is not an exact ordered ROADMAP mapping`);
  }
  for (const [index, criterion] of criteria.entries()) {
    const label = { id: `${phase} exit criterion ${index + 1}` };
    if (!['verified', 'pending-external'].includes(criterion.status)) {
      fail(`${label.id} has invalid status ${criterion.status}`);
    }
    if (typeof criterion.finding !== 'string' || criterion.finding.trim() === '') {
      fail(`${label.id} is missing finding`);
    }
    if (!Array.isArray(criterion.evidence) || criterion.evidence.length === 0
      || !Array.isArray(criterion.tests) || criterion.tests.length === 0) {
      fail(`${label.id} needs evidence and test paths`);
    }
    await Promise.all([...criterion.evidence, ...criterion.tests]
      .map((path) => assertEvidenceExists(label, path)));
  }
}

const unexpectedExitPhases = Object.keys(audit.phaseExitCriteria)
  .filter((phase) => !committedPhases.includes(phase));
if (unexpectedExitPhases.length > 0) {
  fail(`phaseExitCriteria has unknown phases: ${unexpectedExitPhases.join(', ')}`);
}

if (!sameStrings([...exploreRoadmapItems], parsedRoadmap.EXPLORE.candidates)) {
  fail('EXPLORE audits must map every candidate ROADMAP item exactly once and no non-candidate bullet');
}

if (!audit.securityClosure || typeof audit.securityClosure !== 'object' || Array.isArray(audit.securityClosure)) {
  fail('securityClosure is missing');
}
for (const closureName of requiredSecurityClosures) {
  const closure = audit.securityClosure[closureName];
  const label = { id: `securityClosure.${closureName}` };
  if (!closure || closure.status !== 'verified') fail(`${label.id} must be verified`);
  if (typeof closure.finding !== 'string' || closure.finding.trim() === '') {
    fail(`${label.id} is missing finding`);
  }
  if (!Array.isArray(closure.evidence) || closure.evidence.length === 0
    || !Array.isArray(closure.tests) || closure.tests.length === 0) {
    fail(`${label.id} needs evidence and test paths`);
  }
  await Promise.all([...closure.evidence, ...closure.tests]
    .map((path) => assertEvidenceExists(label, path)));
}
const unexpectedClosures = Object.keys(audit.securityClosure)
  .filter((closureName) => !requiredSecurityClosures.includes(closureName));
if (unexpectedClosures.length > 0) fail(`securityClosure has unknown entries: ${unexpectedClosures.join(', ')}`);

const knownHostsSources = await Promise.all([
  'src-tauri/src/commands.rs',
  'src-tauri/src/remote_fs.rs',
  'src-tauri/src/session.rs',
  'src-tauri/src/port_forward.rs',
].map((path) => readFile(resolve(root, path), 'utf8')));
if (knownHostsSources.some((source) => /known_hosts_path\([^)]*\)\s*\.ok\(\)/.test(source))) {
  fail('Known Hosts path resolution must never be downgraded with .ok()');
}
if (!knownHostsSources[3].includes('known_hosts_path: String')) {
  fail('port forwarding must require a resolved Known Hosts path');
}

const [aiSource, aiTypes, aiSettingsStore, databaseSource, terminalWorkspaceSource] = await Promise.all([
  readFile(resolve(root, 'src-tauri/src/ai.rs'), 'utf8'),
  readFile(resolve(root, 'src/types/ai.ts'), 'utf8'),
  readFile(resolve(root, 'src/stores/aiSettingsStore.ts'), 'utf8'),
  readFile(resolve(root, 'src-tauri/src/db.rs'), 'utf8'),
  readFile(resolve(root, 'src/lib/terminal-workspace.ts'), 'utf8'),
]);
if (/\bapiKey\b/.test(aiTypes) || /\bapiKey\b/.test(aiSettingsStore)) {
  fail('AI provider metadata must not contain apiKey');
}
const migrationStart = aiSource.indexOf('fn migrate_legacy_api_keys_with');
const migrationEnd = aiSource.indexOf('#[tauri::command]', migrationStart);
const migrationSource = aiSource.slice(migrationStart, migrationEnd);
if (migrationStart < 0 || migrationEnd < 0
  || !migrationSource.includes('provider.remove("apiKey")')
  || !migrationSource.includes('credentials.set_api_key')
  || migrationSource.includes('delete_api_key')) {
  fail('AI legacy migration must move SQLite secrets to keychain without deleting the secure copy');
}
if (!databaseSource.includes('AI provider preferences may only contain non-sensitive metadata')) {
  fail('database must reject sensitive AI provider metadata');
}
if (!terminalWorkspaceSource.includes('TERMINAL_WORKSPACE_VERSION = 1')
  || !databaseSource.includes('validate_terminal_workspace')) {
  fail('terminal workspace must have a versioned, bounded frontend and database contract');
}

const toolchainToml = await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8');
const toolchainMatch = toolchainToml.match(/^channel\s*=\s*"([^"]+)"/m);
if (!toolchainMatch) fail('rust-toolchain.toml is missing a channel');
const pinnedToolchain = toolchainMatch[1];
for (const workflowPath of rustWorkflowPaths) {
  const workflowLines = (await readFile(resolve(root, workflowPath), 'utf8')).split(/\r?\n/);
  workflowLines.forEach((line, index) => {
    if (!line.includes('uses: dtolnay/rust-toolchain@')) return;
    const actionBlock = workflowLines.slice(index, index + 8).join('\n');
    if (!actionBlock.includes(`toolchain: ${pinnedToolchain}`)) {
      fail(`${workflowPath} must install the pinned Rust ${pinnedToolchain} toolchain explicitly`);
    }
  });
}

for (const phase of requiredPhases) {
  if (!roadmap.includes(`## ${phase}`)) fail(`ROADMAP.md is missing phase ${phase}`);
  if (!audit.items.some((item) => item.phase === phase)) fail(`audit has no ${phase} items`);
}

const totals = Object.fromEntries(
  [...allowedStatuses].map((status) => [status, audit.items.filter((item) => item.status === status).length]),
);
console.log(`Roadmap audit valid: ${audit.items.length} workstreams (${JSON.stringify(totals)})`);
