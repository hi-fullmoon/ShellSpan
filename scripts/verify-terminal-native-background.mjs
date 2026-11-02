// Focused causal experiment. It does not run or change production paths.
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const version=args.find(value=>value.startsWith('--version='))?.split('=')[1]??'5.3';
const requested=args.find(value=>value.startsWith('--modes='))?.split('=')[1]?.split(',')??['pure','loaded-user','replace','insert'];
const host=process.platform==='darwin'?'darwin':'linux';
const build=JSON.parse(readFileSync(path.join(root,`.native-input-p0/build-${host}.json`)))[version];
if(!build) throw new Error(`Frozen build ${version} missing; run build.py --upstream`);
const run=path.join(root,'.native-input-p0/background-causality',new Date().toISOString().replaceAll(':','-'));
mkdirSync(run,{recursive:true});
cpSync(path.join(root,'scripts/native-input-p0'),path.join(run,'sources/scripts/native-input-p0'),{recursive:true,
  filter:filename=>!filename.includes('__pycache__')});
cpSync(fileURLToPath(import.meta.url),path.join(run,'sources/scripts/verify-terminal-native-background.mjs'));
cpSync(path.join(root,`.native-input-p0/artifact-manifest-${host}.json`),path.join(run,'build-inputs.json'));
const repeats=Number(args.find(value=>value.startsWith('--repeats='))?.split('=')[1]??35);
if(![35,270].includes(repeats)) throw new Error('Use one of the bounded fixture sizes: 35 or 270');
const source="printf '%s\\n' '"+'中文 é 👩‍💻 resize '.repeat(repeats)+"'";
const graphemes=Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(source),part=>part.segment);
const size=Math.ceil(graphemes.length/16);
const texts=[];
for(let offset=0;offset<graphemes.length;offset+=size) texts.push(graphemes.slice(offset,offset+size).join(''));
const schedule={source,segmenter:process.versions.icu,chunks:texts.map((text,index)=>({text,at_ms:index*1500/(texts.length-1)}))};
writeFileSync(path.join(run,'schedule.json'),JSON.stringify(schedule,null,2));
const results=[];
if(args.includes('--ssh')) {
  const native=spawnSync('python3',['scripts/native-input-p0/ssh.py','--versions',version,
    '--causal-output',run,'--schedule',path.join(run,'schedule.json'),'--modes',requested.join(',')],
    {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
  writeFileSync(path.join(run,'ssh-driver.log'),`${native.stdout??''}${native.stderr??''}\nexit=${native.status}\n`);
  for(const mode of requested) {
    const directory=path.join(run,`ssh-${version}-${mode}`);
    let browserStatus=null;
    try {
      readFileSync(path.join(directory,'native-result.json'));
      const browser=spawnSync('node',['scripts/native-input-p0/browser.mjs'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,
        env:{...process.env,SHELLSPAN_P0_BACKGROUND_ONLY:'1',SHELLSPAN_P0_CAPTURE_ROOT:directory}});
      browserStatus=browser.status;
      writeFileSync(path.join(directory,'browser.log'),`${browser.stdout??''}${browser.stderr??''}\nexit=${browser.status}\n`);
    } catch {}
    results.push({mode,nativeExit:native.status,browserExit:browserStatus,directory});
  }
} else {
for(const mode of requested) {
  const directory=path.join(run,mode);
  const native=spawnSync('python3',['scripts/native-input-p0/background-causality.py',
    '--shell',build.shell,'--bridge',build.bridge,'--output',directory,
    '--schedule',path.join(run,'schedule.json'),'--mode',mode,
    ...(args.includes('--no-resize')?['--no-resize']:[]),...(args.includes('--no-edit')?['--no-edit']:[]),
    '--interval-ms',args.find(value=>value.startsWith('--interval-ms='))?.split('=')[1]??'150'],
    {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
  writeFileSync(path.join(directory,'native.log'),`${native.stdout??''}${native.stderr??''}\nexit=${native.status}\n`);
  let browserStatus=null;
  if(native.status===0) {
    const browser=spawnSync('node',['scripts/native-input-p0/browser.mjs'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,
      env:{...process.env,SHELLSPAN_P0_BACKGROUND_ONLY:'1',SHELLSPAN_P0_CAPTURE_ROOT:directory}});
    browserStatus=browser.status;
    writeFileSync(path.join(directory,'browser.log'),`${browser.stdout??''}${browser.stderr??''}\nexit=${browser.status}\n`);
  }
  results.push({mode,nativeExit:native.status,browserExit:browserStatus,directory});
}
}
writeFileSync(path.join(run,'results.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({run,results},null,2));
process.exitCode=results.some(result=>result.nativeExit!==0||result.browserExit!==0)?1:0;
