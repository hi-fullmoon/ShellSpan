import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const integration = [
  'src/components/terminal/registry/terminal-registry.ts',
  'src/components/terminal/terminal-controller-layer.tsx',
];
const displayDirectories = [
  ['src/components/terminal/registry', 'terminal-command-'],
  ['src/lib/terminal', 'native-input-display'],
];
const retired = new Set(['terminal-command-source', 'terminal-command-typing', 'terminal-command-redraw']);
const projectedMetadata = new Set(['commandDisplay', 'commandSubmission']);
const protectedMembers = new Set([
  'getLine', 'getCell', 'translateToString', 'getSelection', 'getSelectionPosition',
  'select', 'selectAll', 'selectLines', 'clearSelection', 'findNext', 'findPrevious',
  'write', 'writeln', 'refresh', 'render', 'cursorX', 'cursorY',
]);

function propertyKey(name, checker) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  const value = checker.getTypeAtLocation(name.expression);
  return value.isStringLiteral() || value.isNumberLiteral() ? String(value.value) : undefined;
}

function memberName(node, checker) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return undefined;
  const value = checker.getTypeAtLocation(node.argumentExpression);
  return value.isStringLiteral() || value.isNumberLiteral() ? String(value.value) : undefined;
}

function isXterm(node, checker) {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return isXterm(node.expression, checker);
  const type = checker.getTypeAtLocation(node);
  const types = type.isUnionOrIntersection() ? type.types : [type];
  return types.some(type => type.getProperties().some(property => property.declarations?.some(declaration =>
    declaration.getSourceFile().fileName.includes('/@xterm/'))));
}

function assigned(node) {
  const parent = node.parent;
  return ts.isBinaryExpression(parent) && parent.left === node
      && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    || ts.isDeleteExpression(parent)
    || (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
}

/** AST + semantic types; no runtime terminal, browser, PTY or dependency build. */
export async function checkTerminalCommandBoundary() {
  const files = [...integration];
  const displayFiles = new Set();
  for (const [directory, prefix] of displayDirectories) {
    for (const entry of await readdir(resolve(root, directory))) {
      if (!entry.startsWith(prefix) || !/\.tsx?$/.test(entry)) continue;
      const file = `${directory}/${entry}`;
      assert(!retired.has(entry.replace(/\.tsx?$/, '')), `Retired projection module returned: ${file}`);
      displayFiles.add(resolve(root, file));
      files.push(file);
    }
  }
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  assert(!config.error, 'Cannot read TypeScript configuration');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  // Follow display helpers, so moving an override to an imported module cannot
  // bypass the boundary. Type-only imports and third-party implementations are
  // outside the application display implementation.
  for (const file of displayFiles) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = [];
    const collect = node => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, collect);
    };
    collect(source);
    for (const name of imports) {
      const resolved = ts.resolveModuleName(name, file, parsed.options, ts.sys).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport || resolved.resolvedFileName.endsWith('.d.ts')) continue;
      const dependency = resolve(resolved.resolvedFileName);
      if (!dependency.startsWith(resolve(root, 'src') + '/')) continue;
      if (!displayFiles.has(dependency)) {
        displayFiles.add(dependency);
        files.push(dependency);
      }
    }
  }
  const program = ts.createProgram(files.map(file => resolve(root, file)), parsed.options);
  const checker = program.getTypeChecker();
  const failures = [];
  for (const file of files) {
    const source = program.getSourceFile(resolve(root, file));
    assert(source, `Missing boundary source: ${file}`);
    const fail = (node, rule) => {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${file}:${position.line + 1}: ${rule}`);
    };
    const visit = node => {
      if (displayFiles.has(resolve(root, file))) {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) fail(node, 'JSX command projection');
        if (ts.isPropertyAssignment(node) && ['textContent', 'innerText', 'innerHTML', 'outerHTML'].includes(propertyKey(node.name, checker))) {
          fail(node, 'DOM text projection property');
        }
      }
      if (ts.isBindingElement(node) && projectedMetadata.has(propertyKey(node.propertyName ?? node.name, checker))) {
        fail(node, 'command text destructuring in terminal presentation');
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const name = node.moduleSpecifier.text.split('/').at(-1)?.replace(/\.ts$/, '');
        if (retired.has(name)) fail(node, 'retired projection import');
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const name = memberName(node, checker);
        if (name?.startsWith('_')) fail(node, 'private state access');
        if (projectedMetadata.has(name)) fail(node, 'command text must not enter terminal presentation');
        if (name === undefined && isXterm(node.expression, checker)) fail(node, 'dynamic xterm member access');
        if (assigned(node) && (protectedMembers.has(name) || isXterm(node.expression, checker))) {
          // Public options/provider state is the documented same-stream binding.
          const receiver = node.expression;
          const parentMember = memberName(receiver, checker);
          if (parentMember !== 'options' && !(parentMember === 'unicode' && name === 'activeVersion')) {
            fail(node, 'xterm method/buffer/cursor replacement');
          }
        }
        if (displayFiles.has(resolve(root, file)) && assigned(node)
          && ['textContent', 'innerText', 'innerHTML', 'outerHTML'].includes(name)) {
          fail(node, 'DOM text projection');
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const owner = node.expression.expression;
        const method = node.expression.name.text;
        if (ts.isIdentifier(owner) && ['Object', 'Reflect'].includes(owner.text)
          && ['defineProperty', 'defineProperties', 'assign', 'set', 'setPrototypeOf'].includes(method)) {
          const [target, key] = node.arguments;
          const keyType = key && checker.getTypeAtLocation(key);
          if (target && isXterm(target, checker) || keyType?.isStringLiteral()
            && (protectedMembers.has(keyType.value) || keyType.value.startsWith('_'))) {
            fail(node, 'reflective xterm replacement');
          }
        }
        if (displayFiles.has(resolve(root, file))
          && ['fillText', 'strokeText', 'createTextNode', 'insertAdjacentText', 'insertAdjacentHTML'].includes(method)) {
          fail(node, 'painted text projection');
        }
        if (displayFiles.has(resolve(root, file)) && ['append', 'prepend', 'replaceChildren'].includes(method)
          && node.arguments.some(argument => (checker.getTypeAtLocation(argument).flags & ts.TypeFlags.StringLike) !== 0)) {
          fail(node, 'DOM text projection arguments');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const admission = JSON.parse(await readFile(resolve(root, 'protocol/agent/runtime/native-editor-admission.json'), 'utf8'));
  assert.equal(admission.version, 1);
  assert(Array.isArray(admission.productionProfiles));
  assert.equal(new Set(admission.productionProfiles).size, admission.productionProfiles.length);
  const supportedProfiles = new Set([
    'zsh-5.9-zle-5.9-macos-arm64-native',
    'zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native',
    'powershell-7.6.9-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native',
  ]);
  for (const profile of admission.productionProfiles) {
    assert(supportedProfiles.has(profile), `Unsupported production editor profile: ${profile}`);
  }
  assert.deepEqual(failures, [], `Terminal command boundary violations:\n${failures.join('\n')}`);
  return { files, productionProfiles: admission.productionProfiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkTerminalCommandBoundary();
  console.log(`Terminal command boundary: ${result.files.length} files checked; ${result.productionProfiles.length} production editor profiles.`);
}
