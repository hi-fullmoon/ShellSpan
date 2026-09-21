import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parse as parseToml } from 'smol-toml';
import semver from 'semver';
import {
  command, readVersions, validVersion, latestStable, assertBaseline,
  REPOSITORY, REVIEW_MARKER, VERSION_FILES,
} from './release-notes.mjs';

// Use the TOML parser to identify the intended value while preserving all comments
// and formatting. Candidate edits are accepted only when the parsed root version changes.
export function editTomlVersion(source, current, next, selectVersion) {
  if (selectVersion(parseToml(source)) !== current) throw new Error('Unexpected TOML version');
  for (const match of source.matchAll(/(["'])([^"'\r\n]*)\1/g)) {
    if (match[2] !== current) continue;
    const edited = source.slice(0, match.index) + JSON.stringify(next) + source.slice(match.index + match[0].length);
    if (selectVersion(parseToml(edited)) === next) return edited;
  }
  throw new Error('Cannot update the TOML root version without changing other content');
}

export function generateCandidates(baseSha, headSha, cwd = process.cwd()) {
  const cli = fileURLToPath(import.meta.resolve('git-cliff/cli'));
  return command(process.execPath, [
    cli, '--offline', '--ignore-tags', '.*', '--strip', 'all', `${baseSha}..${headSha}`,
  ], cwd);
}

export async function prepareVersion(requested) {
  const { version: current } = readVersions();
  if (command('git', ['status', '--porcelain'])) throw new Error('Commit or move pending changes before preparing a release');
  let next = requested;
  if (!next) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      next = await rl.question(`当前版本 ${current}，输入 patch / minor / major 或完整版本号：`);
    } finally {
      rl.close();
    }
  }
  if (['patch', 'minor', 'major'].includes(next)) next = semver.inc(current, next);
  validVersion(next);
  if (!semver.gt(next, current)) throw new Error('The next version must be greater than the current version');
  if (command('git', ['tag', '--list', `v${next}`])) throw new Error('The release tag already exists locally');
  if (command('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${next}`])) throw new Error('The release tag already exists remotely');
  const baseTag = latestStable();
  command('git', ['fetch', 'origin', `refs/tags/${baseTag}:refs/tags/${baseTag}`]);
  const baseSha = command('git', ['rev-parse', `${baseTag}^{commit}`]);
  const headSha = command('git', ['rev-parse', 'HEAD']);
  command('git', ['merge-base', '--is-ancestor', baseSha, headSha]);
  const meta = { version: next, repository: REPOSITORY, baseTag, baseSha, headSha, date: new Date().toISOString().slice(0, 10) };
  assertBaseline(meta, baseTag);
  const candidates = generateCandidates(baseSha, headSha);
  writePreparedVersion(next, meta, candidates);
  console.log(`已准备 v${next}，变更范围 ${baseTag}..${headSha.slice(0, 7)}。\n编辑 release-notes/${next}.md 后运行 pnpm changelog 和 pnpm release:check。\n未创建提交、标签或推送。`);
}

export function writePreparedVersion(next, meta, candidates, root = process.cwd()) {
  validVersion(next);
  const { version: current, packageName } = readVersions(root);
  if (meta.version !== next || !semver.gt(next, current)) throw new Error('Invalid prepared version');
  const notesDirectory = path.join(root, 'release-notes');
  const notesPath = path.join(notesDirectory, `${next}.md`);
  const metaPath = path.join(notesDirectory, `${next}.json`);
  if (existsSync(notesPath) || existsSync(metaPath)) throw new Error('Release notes already exist; refusing to overwrite reviewed content');

  const files = VERSION_FILES.map(file => path.join(root, file));
  const original = new Map(files.map(file => [file, readFileSync(file)]));
  const changes = new Map();
  for (const file of files.slice(0, 2)) {
    const json = JSON.parse(original.get(file).toString('utf8'));
    json.version = next;
    changes.set(file, JSON.stringify(json, null, 2) + '\n');
  }
  changes.set(files[2], editTomlVersion(original.get(files[2]).toString('utf8'), current, next, doc => doc.package.version));
  changes.set(files[3], editTomlVersion(original.get(files[3]).toString('utf8'), current, next,
    doc => doc.package.find(pkg => pkg.name === packageName && !pkg.source)?.version));
  const additions = new Map([
    [notesPath, `${REVIEW_MARKER}\n\n<!-- 合并同一功能的提交，核实用户影响，补充兼容性和安全说明；完成后删除上面的审核标记。 -->\n\n${candidates || '### 维护更新\n\n- TODO: 说明本次发布对用户的影响。'}\n`],
    [metaPath, JSON.stringify(meta, null, 2) + '\n'],
  ]);
  const touched = [];
  const created = [];
  let createdDirectory = false;
  try {
    for (const [file, content] of changes) {
      touched.push(file);
      writeFileSync(file, content);
    }
    if (!existsSync(notesDirectory)) {
      mkdirSync(notesDirectory);
      createdDirectory = true;
    }
    for (const [file, content] of additions) {
      const descriptor = openSync(file, 'wx');
      created.push(file);
      try {
        writeFileSync(descriptor, content);
      } finally {
        closeSync(descriptor);
      }
    }
    command('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1', '--manifest-path', files[2]], root);
    readVersions(root);
  } catch (error) {
    const failures = [];
    for (const file of touched.reverse()) {
      try {
        if (!readFileSync(file).equals(original.get(file))) writeFileSync(file, original.get(file));
      } catch (restoreError) {
        failures.push(`${file}: ${restoreError.message}`);
      }
    }
    // Only files exclusively created by this attempt are removed. Existing notes
    // and unrelated files are never included in cleanup.
    for (const file of created.reverse()) {
      try {
        unlinkSync(file);
      } catch (cleanupError) {
        failures.push(`${file}: ${cleanupError.message}`);
      }
    }
    if (createdDirectory) {
      try {
        rmdirSync(notesDirectory);
      } catch (cleanupError) {
        failures.push(`${notesDirectory}: ${cleanupError.message}`);
      }
    }
    if (failures.length) throw new Error(`${error.message}\nRelease rollback requires attention:\n${failures.join('\n')}`, { cause: error });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareVersion(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
