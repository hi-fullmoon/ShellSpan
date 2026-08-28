import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');

const NARROW_COMMANDS = [
  'agent_terminal_get_snapshot',
  'agent_terminal_resolve_approval',
  'agent_terminal_takeover_and_write',
  'agent_terminal_return_control',
  'agent_terminal_pause',
  'agent_terminal_stop',
];

const DEDICATED_TS_FILES = [
  'src/lib/agent-terminal-control.ts',
  'src/components/ai/agent/use-agent-terminal.ts',
  'src/components/ai/agent/agent-terminal-xterm.tsx',
  'src/components/ai/agent/agent-terminal-workspace.tsx',
  'src/stores/agentTerminalStore.ts',
];

export const AGENT_TERMINAL_AUDIT_ALLOWLIST = Object.freeze({
  ordinaryWriteSessionRegistration: 'The pre-existing write_session command remains registered for ordinary UserTerminal sessions; SessionManager rejects AgentPty.',
  xtermDisplaySettingsStore: 'AgentTerminalXterm reads display-only font/theme/cursor settings from appStore; it does not register a terminal or persist output.',
  xtermReadResizeTransport: 'The dedicated xterm may listen to PTY output/status and send ready/resize hints; raw input still uses only takeover-and-write.',
  terminalThemeRegistry: 'The dedicated xterm reuses immutable font/theme resolver functions, not the ordinary terminal controller or store.',
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parseTypeScript(root, relativePath) {
  const source = read(root, relativePath);
  return {
    source,
    tree: ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
}

function interfaceFields(tree, interfaceName) {
  let fields;
  visit(tree, (node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== interfaceName) return;
    fields = node.members
      .filter(ts.isPropertySignature)
      .map((member) => member.name?.getText(tree).replace(/["']/g, ''))
      .filter(Boolean);
  });
  invariant(fields, `missing TypeScript interface ${interfaceName}`);
  return fields;
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function importedNames(node) {
  const clause = node.importClause;
  if (!clause) return [];
  const names = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push(element.name.text);
  }
  return names;
}

function auditDedicatedTypeScript(root) {
  const findings = [];
  const forbiddenCalls = new Set([
    'invokeWriteSession',
    'appendTerminalOutput',
    'createTerminalController',
    'recordOperationEvent',
    'saveTerminalWorkspace',
  ]);
  const allowedStoreImports = new Set([
    '@/stores/agentTerminalStore',
    '@/stores/appStore',
  ]);
  for (const relativePath of DEDICATED_TS_FILES) {
    const { tree } = parseTypeScript(root, relativePath);
    visit(tree, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleName = node.moduleSpecifier.text;
        if (moduleName.startsWith('@/stores/')) {
          invariant(
            allowedStoreImports.has(moduleName),
            `${relativePath} imports non-dedicated store ${moduleName}`,
          );
        }
        if (moduleName.includes('/components/terminal/')) {
          invariant(
            moduleName === '@/components/terminal/registry/terminal-registry',
            `${relativePath} imports ordinary terminal component ${moduleName}`,
          );
        }
        if (moduleName === '@/lib/tauri') {
          invariant(
            relativePath.endsWith('agent-terminal-xterm.tsx'),
            `${relativePath} imports generic Tauri transport outside the display-only xterm`,
          );
          const allowed = new Set([
            'invokeMarkSessionReady',
            'invokeResizeSession',
            'listenToSshClosed',
            'listenToSshData',
            'listenToSshStatus',
          ]);
          for (const name of importedNames(node)) {
            invariant(allowed.has(name), `${relativePath} imports forbidden Tauri helper ${name}`);
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(tree);
        const leaf = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : callee;
        invariant(!forbiddenCalls.has(leaf), `${relativePath} calls forbidden ${leaf}`);
        invariant(
          !['localStorage', 'sessionStorage', 'console'].some(
            (owner) => callee === owner || callee.startsWith(`${owner}.`),
          ),
          `${relativePath} calls persistence/logger surface ${callee}`,
        );
      }
    });
    findings.push({ path: relativePath, result: 'pass' });
  }

  const xterm = parseTypeScript(root, 'src/components/ai/agent/agent-terminal-xterm.tsx');
  let onDataCallbackFound = false;
  visit(xterm.tree, (node) => {
    if (
      !ts.isCallExpression(node)
      || !ts.isPropertyAccessExpression(node.expression)
      || node.expression.name.text !== 'onData'
    ) return;
    const callback = node.arguments[0];
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    onDataCallbackFound = true;
    visit(callback.body, (child) => {
      if (!ts.isIdentifier(child) || child.text !== 'data') return;
      if (callback.parameters.some((parameter) => parameter.name === child)) return;
      const parent = child.parent;
      invariant(
        ts.isCallExpression(parent)
          && parent.arguments.includes(child)
          && parent.expression.getText(xterm.tree) === 'onDataRef.current',
        'AgentTerminalXterm raw onData escapes the immediate narrow callback',
      );
    });
  });
  invariant(onDataCallbackFound, 'AgentTerminalXterm onData callback was not found');
  return findings;
}

function extractDelimited(source, marker, open = '[', close = ']') {
  const markerIndex = source.indexOf(marker);
  invariant(markerIndex >= 0, `missing marker ${marker}`);
  const start = source.indexOf(open, markerIndex + marker.length);
  invariant(start >= 0, `missing ${open} after ${marker}`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) depth -= 1;
    if (depth === 0) return source.slice(start + 1, index);
  }
  throw new Error(`unterminated ${marker}`);
}

function stripRustComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function rustStructFields(source, structName) {
  const body = extractDelimited(source, `struct ${structName}`, '{', '}');
  return [...body.matchAll(/pub\(crate\)\s+([a-zA-Z0-9_]+)\s*:/g)].map((match) => match[1]);
}

function auditRustAndSchema(root) {
  const lib = stripRustComments(read(root, 'src-tauri/src/lib.rs'));
  const handler = extractDelimited(lib, 'tauri::generate_handler!');
  const registeredAgentCommands = [...handler.matchAll(
    /agent::terminal_ipc::(agent_terminal_[a-z0-9_]+)/g,
  )].map((match) => match[1]);
  invariant(
    JSON.stringify(registeredAgentCommands) === JSON.stringify(NARROW_COMMANDS),
    `registered Agent terminal commands changed: ${registeredAgentCommands.join(', ')}`,
  );
  invariant(
    handler.includes('commands::write_session'),
    'ordinary write_session registration unexpectedly disappeared',
  );

  const ipc = stripRustComments(read(root, 'src-tauri/src/agent/terminal_ipc.rs'));
  const ipcFunctions = [...ipc.matchAll(
    /pub\(crate\)\s+fn\s+(agent_terminal_[a-z0-9_]+)/g,
  )].map((match) => match[1]);
  invariant(
    JSON.stringify(ipcFunctions) === JSON.stringify(NARROW_COMMANDS),
    `terminal IPC surface changed: ${ipcFunctions.join(', ')}`,
  );
  invariant(!/request\s*\.\s*data\b/.test(ipc), 'terminal IPC reads raw takeover data outside coordinator');

  const coordinator = stripRustComments(read(root, 'src-tauri/src/agent/terminal_coordinator.rs'));
  const forbiddenPublicFields = [
    'approval_token',
    'approval_challenge',
    'lease_token',
    'raw_input',
    'raw_output',
    'credential',
    'full_transcript',
    'transcript',
    'metadata',
  ];
  for (const structName of ['AgentTerminalSnapshotV1', 'TerminalAuditEventV1']) {
    const fields = rustStructFields(coordinator, structName);
    for (const field of forbiddenPublicFields) {
      invariant(!fields.includes(field), `${structName} exposes forbidden field ${field}`);
    }
  }
  invariant(
    /p2_verified:\s*false/.test(coordinator) && /feature_enabled:\s*false/.test(coordinator),
    'Rust production Agent terminal admission is not fail-closed',
  );

  const db = read(root, 'src-tauri/src/db.rs');
  const tableBody = extractDelimited(
    db,
    'CREATE TABLE IF NOT EXISTS agent_terminal_audit_events',
    '(',
    ')',
  );
  const columns = tableBody
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((entry) => /^[a-z_]+$/.test(entry));
  for (const field of forbiddenPublicFields) {
    invariant(!columns.includes(field), `Agent terminal audit schema exposes forbidden column ${field}`);
  }
  return {
    registeredAgentCommands,
    auditColumns: columns,
  };
}

function auditControlWrapper(root) {
  const { tree } = parseTypeScript(root, 'src/lib/agent-terminal-control.ts');
  const invoked = [];
  let productionAdmission = undefined;
  visit(tree, (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'AGENT_TERMINAL_PRODUCTION_ADMITTED_V1'
    ) {
      productionAdmission = node.initializer?.kind === ts.SyntaxKind.FalseKeyword;
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'invokeTerminalControlV1'
      && ts.isStringLiteral(node.arguments[0])
    ) invoked.push(node.arguments[0].text);
  });
  invariant(productionAdmission === true, 'TypeScript production Agent terminal admission is not false');
  invariant(
    JSON.stringify(invoked) === JSON.stringify(NARROW_COMMANDS),
    `frontend terminal commands changed: ${invoked.join(', ')}`,
  );
  const forbiddenSnapshotFields = new Set([
    'approvalToken',
    'approvalChallenge',
    'leaseToken',
    'rawInput',
    'rawOutput',
    'userInput',
    'credential',
    'secret',
    'fullTranscript',
    'transcript',
  ]);
  for (const interfaceName of [
    'AgentTerminalSnapshotV1',
    'TerminalModelObservationV1',
  ]) {
    for (const field of interfaceFields(tree, interfaceName)) {
      invariant(
        !forbiddenSnapshotFields.has(field),
        `${interfaceName} exposes forbidden field ${field}`,
      );
    }
  }
  const store = parseTypeScript(root, 'src/stores/agentTerminalStore.ts').tree;
  for (const field of interfaceFields(store, 'AgentTerminalProjectionStateV1')) {
    invariant(
      !forbiddenSnapshotFields.has(field),
      `AgentTerminalProjectionStateV1 exposes forbidden field ${field}`,
    );
  }
  return invoked;
}

function auditAcceptanceFixture(root) {
  const fixturePath = 'tests/fixtures/agent-terminal-protocol/v1/terminal-acceptance.json';
  const fixture = JSON.parse(read(root, fixturePath));
  invariant(fixture.schemaVersion === 1, 'terminal acceptance fixture schemaVersion changed');
  invariant(fixture.requirements.length === 10, 'terminal acceptance requirement count changed');
  invariant(new Set(fixture.requirements.map(({ id }) => id)).size === 10, 'duplicate acceptance IDs');
  for (const requirement of fixture.requirements) {
    invariant(requirement.exitCondition.length > 0, `${requirement.id} has no exit condition`);
    for (const location of requirement.codeLocations) {
      invariant(fs.existsSync(path.join(root, location.path)), `${requirement.id} missing ${location.path}`);
    }
    for (const evidence of requirement.automatedEvidence) {
      const evidencePath = path.join(root, evidence.path);
      invariant(fs.existsSync(evidencePath), `${requirement.id} missing evidence ${evidence.path}`);
      if (['rust', 'typescript', 'ui'].includes(evidence.layer)) {
        invariant(
          fs.readFileSync(evidencePath, 'utf8').includes(evidence.test),
          `${requirement.id} evidence symbol missing: ${evidence.test}`,
        );
      }
    }
  }
  return fixture.requirements.map(({ id, result }) => ({ id, result }));
}

export function runAgentTerminalBoundaryAudit(root = DEFAULT_ROOT) {
  const dedicatedTypeScript = auditDedicatedTypeScript(root);
  const rust = auditRustAndSchema(root);
  const frontendCommands = auditControlWrapper(root);
  const acceptance = auditAcceptanceFixture(root);
  return {
    schemaVersion: 1,
    result: 'pass',
    narrowCommands: frontendCommands,
    registeredCommands: rust.registeredAgentCommands,
    auditedDedicatedFiles: dedicatedTypeScript.map(({ path: auditedPath }) => auditedPath),
    auditColumnCount: rust.auditColumns.length,
    acceptance,
    allowlist: AGENT_TERMINAL_AUDIT_ALLOWLIST,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(runAgentTerminalBoundaryAudit(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
