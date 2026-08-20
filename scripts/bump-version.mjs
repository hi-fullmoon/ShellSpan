import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const rl = createInterface({ input: stdin, output: stdout });

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function runWithoutOutput(command, args) {
  execFileSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function runSilently(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitOutput(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function assertCleanTrackedWorktree() {
  const status = gitOutput(['status', '--porcelain', '--untracked-files=no']);
  if (status) {
    throw new Error(`工作区存在尚未提交的已跟踪文件，请先提交或暂存处理后再升级版本：\n${status}`);
  }
}

function assertTagAvailable(tag) {
  if (runSilently('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])) {
    throw new Error(`标签 ${tag} 已存在`);
  }
}

function resolveGitCliffCli() {
  try {
    return fileURLToPath(import.meta.resolve('git-cliff/cli'));
  } catch {
    return null;
  }
}

function snapshotFiles(paths) {
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
}

function restoreFiles(snapshot) {
  for (const [path, content] of snapshot) {
    if (content === null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      writeFileSync(path, content);
    }
  }
}

function bumpVersion(current, bump) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`当前版本不是有效的 semver: ${current}`);
  const [, major, minor, patch] = match.map(Number);
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateCargoLockVersion(path, packageName, currentVersion, nextVersion) {
  const content = readFileSync(path, 'utf8');
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(packageName)}"\\r?\\nversion = ")${escapeRegExp(currentVersion)}(")`,
    'g',
  );
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`无法唯一定位 Cargo.lock 中的根包 ${packageName}@${currentVersion}`);
  }
  writeFileSync(path, content.replace(pattern, (_, prefix, suffix) => `${prefix}${nextVersion}${suffix}`));
}

function trimChangelog() {
  const path = 'CHANGELOG.md';
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  const lines = content.split(/\r?\n/);
  const v2Index = lines.findIndex((line) => /^## \[v2\.0\.0\]/.test(line));
  if (v2Index < 0) return;
  const nextVersionIndex = lines.findIndex((line, index) => index > v2Index && /^## \[/.test(line));
  const kept = lines.slice(0, nextVersionIndex < 0 ? lines.length : nextVersionIndex);
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  writeFileSync(path, `${kept.join('\n')}\n`);
}

const pkg = readJson('package.json');
const current = pkg.version;
const managedPaths = [
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'CHANGELOG.md',
];
let snapshot;
let committed = false;

try {
  if (!runSilently('git', ['--version'])) throw new Error('未找到 git');
  if (!runSilently('cargo', ['--version'])) throw new Error('未找到 cargo');
  assertCleanTrackedWorktree();

  console.log(`当前版本: ${current}\n`);
  console.log('选择升级类型:');
  console.log('  1) patch');
  console.log('  2) minor');
  console.log('  3) major');
  console.log('  4) 手动输入版本号\n');

  const choice = await rl.question('输入数字 (1/2/3/4): ');
  const bumps = { 1: 'patch', 2: 'minor', 3: 'major' };
  let next;

  if (choice === '4') {
    next = await rl.question('输入版本号 (格式 x.y.z，可带预发布/构建后缀): ');
    if (!semverPattern.test(next)) {
      throw new Error('无效版本号，需符合严格 semver 格式（如 2.0.7 或 2.0.7-test.1；纯数字标识符不允许前导零，test.01 非法）');
    }
  } else if (bumps[choice]) {
    next = bumpVersion(current, bumps[choice]);
  } else {
    throw new Error('无效选择');
  }

  console.log(`\n新版本: ${next}`);
  assertTagAvailable(`v${next}`);
  const confirm = await rl.question('确认? (y/N): ');
  if (!/^y$/i.test(confirm)) {
    console.log('已取消');
    process.exitCode = 0;
  } else {
    snapshot = snapshotFiles(managedPaths);
    pkg.version = next;
    writeJson('package.json', pkg);

    const cargoPath = 'src-tauri/Cargo.toml';
    const cargo = readFileSync(cargoPath, 'utf8').replace(/^version = ".*"/m, `version = "${next}"`);
    const cargoPackageName = cargo.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (!cargoPackageName) throw new Error('无法读取 Cargo.toml 中的包名');
    writeFileSync(cargoPath, cargo);

    updateCargoLockVersion('src-tauri/Cargo.lock', cargoPackageName, current, next);

    const tauriPath = 'src-tauri/tauri.conf.json';
    const tauri = readJson(tauriPath);
    tauri.version = next;
    writeJson(tauriPath, tauri);

    // 只验证清单和锁文件，不编译依赖（尤其避免 Windows 上触发 vendored OpenSSL 构建）。
    runWithoutOutput('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1', '--manifest-path', cargoPath]);

    const gitCliffCli = resolveGitCliffCli();
    if (gitCliffCli) {
      trimChangelog();
      run(process.execPath, [gitCliffCli, '--unreleased', '--tag', `v${next}`, '--prepend', 'CHANGELOG.md']);
    } else {
      console.log('  [skip] git-cliff not found, CHANGELOG.md not updated');
    }

    run('git', ['add', '--', ...managedPaths]);
    run('git', ['commit', '-m', `chore(release): bump version to ${next}`]);
    committed = true;
    run('git', ['tag', '-a', `v${next}`, '-m', `Release v${next}`]);
    console.log(`\n完成! v${next} 已提交到本地（未推送，推送请手动执行: git push origin main --follow-tags）`);
  }
} catch (error) {
  if (snapshot && !committed) {
    runSilently('git', ['restore', '--staged', '--', ...managedPaths]);
    restoreFiles(snapshot);
    console.error('操作失败，已恢复版本相关文件');
  } else if (committed) {
    console.error('版本提交已经创建，但后续操作失败；请检查提交和标签状态');
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
