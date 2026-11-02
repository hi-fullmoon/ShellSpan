// Separate, explicitly experimental display transport. No production routing.
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw new Error('This isolated module build is verified only on macOS');
const args=process.argv.slice(2),index=args.indexOf('--captures');
const output=path.join(root,'.native-input-p0/inband-runs',new Date().toISOString().replaceAll(':','-'));
mkdirSync(output,{recursive:true});
const sources=['scripts/native-input-p0/bridge.c','scripts/native-input-p0/inband-display.patch',
  'scripts/native-input-p0/build-inband-lab.py','scripts/native-input-p0/ownership-window.py',
  'scripts/native-input-p0/acceptance.py','scripts/native-input-p0/terminal-compat.browser.mjs',
  'scripts/native-input-p0/xterm-cursor-reflow.patch','scripts/verify-terminal-inband-display.mjs'];
const hashes=()=>Object.fromEntries(sources.map(name=>[name,createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]));
const before=hashes();writeFileSync(path.join(output,'sources-before.json'),JSON.stringify(before,null,2));
function run(command,parameters,log,env={}) {
  const result=spawnSync(command,parameters,{cwd:root,env:{...process.env,...env},encoding:'utf8',maxBuffer:32*1024*1024});
  writeFileSync(path.join(output,log),`${result.stdout??''}${result.stderr??''}\nexit=${result.status}\n`);
  if(result.error)throw result.error;
  return result.status??1;
}
for(const baseline of [true,false])if(run('node',['scripts/native-input-p0/build-xterm-lab.mjs',...(baseline?['--baseline']:[])],baseline?'baseline-build.log':'candidate-build.log'))process.exit(1);
if(run('python3',['scripts/native-input-p0/build-inband-lab.py'],'native-build.log'))process.exit(1);
const build=JSON.parse(readFileSync(path.join(root,'.native-input-p0/build-darwin.json'),'utf8'))['5.3'];
const bridge=path.join(root,'.native-input-p0/inband-display-lab/bridge.so');
const captures=index>=0?path.resolve(root,args[index+1]):path.join(output,'captures');
let native;
if(index>=0) {
  const manifest=JSON.parse(readFileSync(path.join(captures,'manifest.json'),'utf8'));
  if(manifest.inputs.bridge.sha256!==createHash('sha256').update(readFileSync(bridge)).digest('hex'))throw new Error('Capture module differs from this experimental build');
  native=Number(manifest.nativeFailures.length>0);
} else native=run('python3',['scripts/native-input-p0/ownership-window.py','--shell',build.shell,'--bridge',bridge,
  '--output',captures,'--inband'],'native.log');
const parsed=run('node',['scripts/native-input-p0/terminal-compat.browser.mjs',captures],'parsed.log',
  {SHELLSPAN_P0_QUEUE_RESIZE:'0',SHELLSPAN_P0_FRAGMENT_BYTES:'0'});
const queuedFragmented=run('node',['scripts/native-input-p0/terminal-compat.browser.mjs',captures],'queued-fragmented.log',
  {SHELLSPAN_P0_QUEUE_RESIZE:'1',SHELLSPAN_P0_FRAGMENT_BYTES:'1'});
const after=hashes(),sourceStable=JSON.stringify(before)===JSON.stringify(after);
writeFileSync(path.join(output,'sources-after.json'),JSON.stringify(after,null,2));
writeFileSync(path.join(output,'result.json'),JSON.stringify({captures,native,parsed,queuedFragmented,sourceStable},null,2));
console.log(`P0 in-band display experiment: ${native||parsed||queuedFragmented||!sourceStable?'FAIL':'PASS'}; ${output}`);
process.exitCode=native||parsed||queuedFragmented||Number(!sourceStable);
