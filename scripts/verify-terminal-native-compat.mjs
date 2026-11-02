// The compatibility gate stays nonzero while known display/copy failures exist.
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const shellIndex=args.indexOf('--shell');
const bridgeIndex=args.indexOf('--bridge');
const host=process.platform==='darwin'?'darwin':'linux';
const build=JSON.parse(readFileSync(path.join(root,`.native-input-p0/build-${host}.json`),'utf8'))['5.3'];
const shell=shellIndex>=0?args[shellIndex+1]:build.shell;
const bridge=bridgeIndex>=0?args[bridgeIndex+1]:build.bridge;
if(!shell)throw new Error('Provide --shell with a built GNU Bash executable');
const output=path.join(root,'.native-input-p0/dependency-compatibility',new Date().toISOString().replaceAll(':','-'));
mkdirSync(output,{recursive:true});
const sources=['scripts/native-input-p0/terminal-compat.py','scripts/native-input-p0/terminal-compat.browser.mjs',
  'scripts/native-input-p0/ownership-window.py','scripts/native-input-p0/acceptance.py',
  'scripts/native-input-p0/background-causality.py','scripts/native-input-p0/xterm-cursor-reflow.patch',
  'scripts/verify-terminal-native-compat.mjs'];
const sourceHashes=()=>Object.fromEntries(sources.map(name=>[name,createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]));
const before=sourceHashes();
writeFileSync(path.join(output,'sources-before.json'),JSON.stringify(before,null,2));
function run(command,parameters,log) {
  const result=spawnSync(command,parameters,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
  writeFileSync(path.join(output,log),`${result.stdout??''}${result.stderr??''}\nexit=${result.status}\n`);
  if(result.error)throw result.error;
  return result.status??1;
}
for(const baseline of [true,false]) {
  const code=run('node',['scripts/native-input-p0/build-xterm-lab.mjs',...(baseline?['--baseline']:[])],baseline?'baseline-build.log':'candidate-build.log');
  if(code)process.exit(code);
}
const captures=path.join(output,'captures');
const native=run('python3',['scripts/native-input-p0/terminal-compat.py','--output',captures,'--native','--shell',shell],'native.log');
if(native)process.exit(native);
const status=run('node',['scripts/native-input-p0/terminal-compat.browser.mjs',captures],'browser.log');
const ownership=path.join(output,'ownership');
const ownershipNative=run('python3',['scripts/native-input-p0/ownership-window.py','--output',ownership,
  '--shell',shell,'--bridge',bridge],'ownership-native.log');
const ownershipBrowser=ownershipNative?ownershipNative:run('node',['scripts/native-input-p0/terminal-compat.browser.mjs',ownership],'ownership-browser.log');
const after=sourceHashes();
writeFileSync(path.join(output,'sources-after.json'),JSON.stringify(after,null,2));
const sourceStable=JSON.stringify(before)===JSON.stringify(after);
writeFileSync(path.join(output,'result.json'),JSON.stringify({library:status,ownershipNative,ownershipBrowser,sourceStable},null,2));
console.log(`P0 dependency compatibility: ${status||ownershipBrowser?'FAIL':'PASS'}; ${output}`);
process.exitCode=status||ownershipBrowser||Number(!sourceStable);
