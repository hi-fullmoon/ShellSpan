// P0 only. This entry never enables a production execution path.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  upstream: { type: 'boolean' },
  'browser-only': { type: 'boolean' },
  'native-only': { type: 'boolean' },
  ssh: { type: 'boolean' },
} });

if (args['browser-only'] && args['native-only']) {
  throw new Error('Choose either --browser-only or --native-only; their combination would run no local checks');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.native-input-p0');
mkdirSync(output, { recursive: true });
function run(command, parameters, logName) {
  const result = spawnSync(command, parameters, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (logName) writeFileSync(path.join(output, logName), `${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result.status ?? 1;
}
let failed = false;
const runDirectory=path.join(output,'runs',new Date().toISOString().replaceAll(':','-'));
mkdirSync(runDirectory,{recursive:true});
if (!args['browser-only']) {
  const buildArgs = ['scripts/native-input-p0/build.py'];
  if (args.upstream) buildArgs.push('--upstream');
  if (run('python3', buildArgs, 'build-entry.log')) process.exit(1);
  const host = process.platform === 'darwin' ? 'darwin' : 'linux';
  const builds = JSON.parse(readFileSync(path.join(output, `build-${host}.json`), 'utf8'));
  for (const [version, build] of Object.entries(builds)) {
    const captures=path.join(runDirectory,`${host}-${version}`);
    failed = Boolean(run('python3', ['scripts/native-input-p0/acceptance.py', '--shell', build.shell,
      '--bridge', build.bridge, '--output', captures,'--display-profile','legacy'], `${host}-${version}.log`)) || failed;
    process.env.SHELLSPAN_P0_CAPTURE_ROOT=captures;
  }
}
if (!args['native-only']) {
  failed = Boolean(run('node', ['scripts/native-input-p0/browser.mjs'], 'browser-entry.log')) || failed;
}
if (args.ssh) {
  failed = Boolean(run('python3', ['scripts/native-input-p0/ssh.py','--display-profile','legacy'], 'ssh-entry.log')) || failed;
}
process.exitCode = failed ? 1 : 0;
