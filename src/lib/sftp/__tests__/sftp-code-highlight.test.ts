import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { highlightSftpSource } from '../sftp-code-highlight-core';
import { getSftpCodeLanguage, highlightSftpCode } from '../sftp-code-highlight';

const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('SFTP source highlighting', () => {
  it.each([
    ['button.tsx', 'typescript'], ['index.ts', 'typescript'],
    ['component.jsx', 'javascript'], ['module.mjs', 'javascript'],
    ['config.JSON', 'json'], ['events.jsonl', 'json'], ['events.ndjson', 'json'],
    ['deploy.sh', 'bash'], ['script.py', 'python'], ['lib.rs', 'rust'],
    ['main.go', 'go'], ['query.sql', 'sql'], ['config.yml', 'yaml'],
    ['Cargo.toml', 'ini'], ['page.html', 'xml'], ['component.vue', 'xml'],
    ['main.dart', 'dart'], ['Dockerfile', 'dockerfile'], ['Makefile', 'makefile'],
  ])('chooses the language for %s', (fileName, language) => {
    expect(getSftpCodeLanguage(fileName)).toBe(language);
  });

  it.each([
    ['src/lib/ai/retry-policy.json', 'json', '.hljs-attr', '.hljs-number'],
    ['src/components/ui/button.tsx', 'typescript', '.hljs-keyword', '.hljs-tag'],
    ['src-tauri/src/lib.rs', 'rust', '.hljs-keyword', '.hljs-string'],
  ])('highlights the real source in %s without changing its text', (path, language, firstToken, secondToken) => {
    const source = readSource(path);
    const html = highlightSftpSource(source, language);
    expect(html).not.toBeNull();
    const code = document.createElement('code');
    code.innerHTML = html!;
    expect(code.textContent).toBe(source);
    expect(code.querySelector(firstToken)).not.toBeNull();
    expect(code.querySelector(secondToken)).not.toBeNull();
  });

  it('displays markup from a real HTML file as source instead of executable elements', () => {
    const source = readSource('index.html');
    const code = document.createElement('code');
    code.innerHTML = highlightSftpSource(source, 'xml')!;
    expect(code.textContent).toBe(source);
    expect(code.querySelector('script, img, iframe, link')).toBeNull();
    expect(code.querySelector('.hljs-tag')).not.toBeNull();
  });

  it('keeps a truncated JSON source readable', () => {
    const source = readSource('src/lib/ai/retry-policy.json').slice(0, 100);
    const code = document.createElement('code');
    code.innerHTML = highlightSftpSource(source, 'json')!;
    expect(code.textContent).toBe(source);
  });

  it('leaves unsupported filenames and languages as plain source', async () => {
    expect(getSftpCodeLanguage('readme.txt')).toBeUndefined();
    expect(getSftpCodeLanguage('file.constructor')).toBeUndefined();
    expect(getSftpCodeLanguage('file.__proto__')).toBeUndefined();
    expect(getSftpCodeLanguage()).toBeUndefined();
    expect(highlightSftpSource(readSource('README.md'), 'unknown-language')).toBeNull();
    expect(await highlightSftpCode(readSource('README.md'), 'readme.txt')).toBeNull();
  });

  it('does not start a cancelled highlighting request', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await highlightSftpCode(readSource('src/lib/ai/retry-policy.json'), 'config.json', controller.signal)).toBeNull();
  });
});
