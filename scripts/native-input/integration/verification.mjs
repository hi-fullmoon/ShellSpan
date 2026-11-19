// Complete P2 gate. Every native/SSH/editor/model receipt comes from a real
// target. This does not commit, tag, publish or connect to business hosts.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {openSync,closeSync,writeSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import { cargoLibraryTests, repositoryRoot as root, terminalFrontendTests, verifyRuntimeComponents } from '../verification-steps.mjs';

export async function verifyIntegration(args) {
  const {values}=parseArgs({args,options:{fixture:{type:'string'},'components-only':{type:'boolean'}}});
  const directory=resolve(root,'artifacts/tests/native-input/integration/validation',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
  const steps=[];let current;let fixture;let createdFixture=false;let failure;
  for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>current?.kill(signal));
  async function run(name,command,args,environment={}){
    const logPath=resolve(directory,`${name}.log`);const log=openSync(logPath,'wx',0o600);const started=Date.now();let stdout='';
    current=spawn(command,args,{cwd:root,env:{...process.env,...environment},stdio:['ignore','pipe',log]});
    current.stdout.on('data',bytes=>{stdout+=bytes;writeSync(log,bytes);});
    const code=await new Promise((resolve,reject)=>{current.once('error',reject);current.once('close',resolve);});closeSync(log);
    steps.push({name,command,args,exitCode:code,elapsedMs:Date.now()-started,logPath});
    await writeFile(resolve(directory,'summary.json'),JSON.stringify({phase:'P2',result:'RUNNING',steps},null,2));
    assert.equal(code,0,`${name} failed; ${logPath}`);console.log(`${name}: passed`);return stdout.trim();
  }
  try{
    await run('freeze',process.execPath,['scripts/native-input/freeze.mjs','integration']);
    await run('frozen-assets',process.execPath,['scripts/native-input/integration/verify-frozen-validation.mjs','--page','history']);
    await run('producer-host','python3',['-B','scripts/native-input/integration/build.py'],{SHELLSPAN_NATIVE_BUILD_ROOT:'artifacts/tests'});
    if(!values['components-only']){
      if(values.fixture)fixture=resolve(values.fixture);
      else{
        await run('fixture-image','docker',['build','-t','shellspan-native-input-p2:local','-f','scripts/native-input/integration/Dockerfile','scripts/native-input/integration']);
        fixture=await run('fixture-start',process.execPath,['scripts/native-input/integration/ssh.mjs']);createdFixture=true;
      }
      assert(fixture.startsWith(resolve(root,'artifacts/tests/native-input/integration/ssh')+'/'));
      const owned=JSON.parse(await readFile(fixture,'utf8'));
      await run('producer-ssh','docker',['exec','-e','SHELLSPAN_NATIVE_BUILD_ROOT=artifacts/tests',owned.container,'python3','-B','scripts/native-input/integration/build.py']);
      await run('fixture-refresh',process.execPath,['scripts/native-input/integration/ssh.mjs','--refresh',fixture]);
    }
    await verifyRuntimeComponents(run);
    await run('legacy-interactive','cargo',[...cargoLibraryTests,'agent_runtime::native::terminal_interactive::tests','--','--include-ignored','--test-threads=1']);
    await run('native-producer','cargo',[...cargoLibraryTests,'native_production_','--','--ignored','--test-threads=1']);
    await run('browser',process.execPath,['scripts/native-input/integration/browser.mjs']);
    if(!values['components-only']){
      const owned=JSON.parse(await readFile(fixture,'utf8'));
      await run('linux-geometry-inputs','cargo',[...cargoLibraryTests,'native_linux_geometry_inputs','--','--ignored']);
      const inputs=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input/integration/linux-geometry-inputs.json'),'utf8'));
      await run('linux-geometry','docker',['exec',owned.container,'python3','-B','scripts/native-input/integration/linux-geometry.py',inputs.linuxInputs]);
      await run('linux-widget-signal','docker',['exec',owned.container,'python3','-B','scripts/native-input/integration/linux-geometry.py','--widget',inputs.linuxInputs.replace(/\/inputs\.json$/,'/widget-inputs.json')]);
      await run('linux-browser',process.execPath,['scripts/native-input/integration/browser.mjs','--linux']);
    }
    await run('frontend','pnpm',['exec','vitest','run', ...terminalFrontendTests,
      'src/lib/ipc/__tests__/tauri-core.test.ts','scripts/__tests__/release-pipeline.test.mjs']);
    if(!values['components-only']){
      await run('resources',process.execPath,['scripts/native-input/prepare-resources.mjs','--acceptance','--no-build','--require-ssh']);
      await run('source-reconstruction',process.execPath,['scripts/native-input/integration/source-rebuild.mjs']);
      await run('release-resources',process.execPath,['scripts/native-input/integration/release-smoke.mjs']);
      await run('actual-app-matrix',process.execPath,['scripts/native-input/integration/matrix.mjs',fixture]);
      await run('actual-ssh-fault',process.execPath,['scripts/native-input/integration/app.mjs','5.3',fixture,'ssh-fault']);
      await run('actual-native-interactive',process.execPath,['scripts/native-input/integration/app.mjs','5.3','-','interactive']);
      for(const scenario of['close','contention','delegation'])await run(`actual-app-${scenario}`,process.execPath,['scripts/native-input/integration/app.mjs','5.3','-',scenario]);
      await run('legacy-and-p1',process.execPath,['scripts/native-input/verify.mjs','protocol']);
      await run('typescript-build','pnpm',['build']);
    }
  }catch(error){failure=String(error);}
  finally{if(createdFixture&&fixture)try{await run('fixture-cleanup',process.execPath,['scripts/native-input/integration/ssh.mjs','--stop',fixture]);}catch(error){failure??=String(error);}}
  await writeFile(resolve(directory,'summary.json'),JSON.stringify({phase:'P2',scope:values['components-only']?'COMPONENTS ONLY — not complete P2 acceptance':'Full local/owned SSH application gate',result:failure?'FAIL':'PASS',steps,failure},null,2));
  if(failure)throw new Error(failure);
  console.log(JSON.stringify({directory,result:'PASS',componentsOnly:Boolean(values['components-only'])}));
}
