import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { captureValidationSources } from '../native-input-p2/frozen-validation.mjs';

const root = path.resolve(import.meta.dirname, '../..');

async function validationSources() {
  const files = Object.keys(captureValidationSources(root))
    .filter(file => file.startsWith('scripts/') && /\.(?:mjs|py|ps1)$/.test(file) && !file.includes('/__tests__/'));
  return Promise.all(files.map(async file => ({
    file,
    source: await readFile(path.join(root, file), 'utf8'),
  })));
}

function scriptNodes({ file, source }) {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return { syntax, nodes };
}

function dockerLabelKey(node, syntax, namespace) {
  for (const span of node.templateSpans) {
    expect(ts.isIdentifier(span.expression)).toBe(true);
    expect(['namespace', 'id']).toContain(span.expression.text);
  }
  const id = randomUUID();
  const label = new Script(node.getText(syntax)).runInNewContext({ namespace, id });
  expect(label.endsWith(`=${id}`)).toBe(true);
  return label.slice(0, -(id.length + 1));
}

describe('native validation identity contracts', () => {
  it('keeps application identifiers and credential services separate from artifact paths', async () => {
    const sources = await validationSources();
    for (const { file, source } of sources) {
      expect(source, file).not.toMatch(/\bshellspan(?:\.validation)?\.artifacts\//);
    }
    const runner = scriptNodes(sources.find(({ file }) => file === 'scripts/verify-ai-session-stream.mjs'));
    const patterns = runner.nodes.filter(node => node.kind === ts.SyntaxKind.RegularExpressionLiteral
      && node.getText(runner.syntax).includes('shellspan')
      && node.getText(runner.syntax).includes('validation'));
    expect(patterns).toHaveLength(1);
    const acceptsIdentifier = new Script(patterns[0].getText(runner.syntax)).runInNewContext();
    const identifiers = sources.filter(({ file }) => file.endsWith('.mjs'))
      .flatMap(source => scriptNodes(source).nodes)
      .filter(node => ts.isStringLiteral(node) && node.text.startsWith('com.shellspan.validation.'))
      .map(node => node.text);
    expect(identifiers).toEqual(expect.arrayContaining([
      'com.shellspan.validation.native-input-p2',
      'com.shellspan.validation.native-input-p3',
      'com.shellspan.validation.native-input-p2-release',
    ]));
    for (const identifier of identifiers) expect(acceptsIdentifier.test(identifier), identifier).toBe(true);

    for (const file of [
      'scripts/native-input-p3/windows-desktop-worker.ps1',
      'scripts/native-input-p3/windows-credential-worker.ps1',
    ]) {
      expect(sources.find(source => source.file === file).source)
        .toContain("'com.shellspan.validation.native-input-p3'");
    }
    expect(sources.find(({ file }) => file === 'scripts/native-input-p3/linux-run.py').source)
      .toContain('com.shellspan.native-input-p3.fixture');
    expect(sources.find(({ file }) => file === 'scripts/native-input-p3/scoped-linux-baseline.py').source)
      .toContain('父Shell');
  });

  it('keeps fixed and dynamic Docker labels consistent with ownership checks and cleanup', async () => {
    const sources = await validationSources();
    const peer = scriptNodes(sources.find(({ file }) => file === 'scripts/native-input-p3/linux-peer.mjs'));
    const dynamic = peer.nodes.filter(node => ts.isTemplateExpression(node) && node.head.text.startsWith('shellspan.'));
    expect(dynamic).toHaveLength(1);
    const keys = ['p2', 'p3'].map(namespace => dockerLabelKey(dynamic[0], peer.syntax, namespace));
    expect(keys).toEqual(['shellspan.native-input-p2', 'shellspan.native-input-p3']);

    for (const file of ['scripts/native-input-p2/ssh.mjs', 'scripts/native-input-p3/linux-fixture.mjs']) {
      const producer = scriptNodes(sources.find(source => source.file === file));
      const fixed = producer.nodes.filter(node => ts.isTemplateExpression(node) && node.head.text.startsWith('shellspan.'));
      expect(fixed.length, file).toBeGreaterThan(0);
      for (const label of fixed) expect(keys).toContain(dockerLabelKey(label, producer.syntax));
    }
    const consumers = sources.filter(({ file }) => file.endsWith('.mjs'))
      .flatMap(source => scriptNodes(source).nodes)
      .filter(ts.isStringLiteral).map(node => node.text)
      .filter(value => value.startsWith('{{index .Config.Labels ') && value.includes('native-input-'));
    expect(consumers.length).toBeGreaterThan(0);
    for (const format of consumers) expect(keys.some(key => format.includes(JSON.stringify(key))), format).toBe(true);
    for (const file of ['scripts/native-input-p3/linux-run.py', 'scripts/native-input-p3/scoped-linux-baseline.py']) {
      expect(sources.find(source => source.file === file).source, file)
        .toContain('{{index .Config.Labels ' + JSON.stringify(keys[1]) + '}}');
    }
    const cleanup = await readFile(path.join(root, 'scripts/native-input-p3/scoped-fixture-stop.mjs'), 'utf8');
    expect(cleanup).toContain(JSON.stringify(keys[1]));
  });
});
