import {afterEach,expect,it} from 'vitest';
import {mkdir,writeFile,readFile,readdir,realpath,lstat,rm,mkdtemp,symlink} from 'node:fs/promises';
import {resolve,relative,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {writeFileSync,statSync,utimesSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {digest,inventory,reuseDecision,verifyRetainedArtifacts,hashFile,dependencyInventory,stageToolchains,fingerprints,buildInputRoots} from '../native-input-p3/acceptance-inputs.mjs';
import {withLease,boundedQueue,runInstalledCases,backgroundQueue,watchBatchCancellation} from '../native-input-p3/acceptance-queue.mjs';
import {summarize,evidenceMatches,sealCase,retainSealedCase,referenceEvidence,modelEvidenceMetrics} from '../native-input-p3/acceptance-evidence.mjs';
import {packageCases,checklistObligations} from '../native-input-p3/acceptance-plan.mjs';
import {allocateCase,packageLoader,packageCargoLocation,reservePackageCargo,retainUninstallResidue,requireVisiblePackageViewport} from '../native-input-p3/package-launch.mjs';
import {scopePackageStyles,assertPackageModuleInput} from '../native-input-p3/package-frontend.mjs';
import {selectSnapshotResources,verifySnapshotResourceCopy} from '../native-input-p3/acceptance-snapshot-resources.mjs';
import {legacyTiming,compareTimings} from '../native-input-p3/acceptance-timings.mjs';
import {productionDependencyInputs,assertReusableBuild,assertArtifactSourceContext} from '../native-input-p3/acceptance-package-reuse.mjs';
import {foreignNativeValidations} from '../native-input-p3/acceptance-gui-readiness.mjs';

const base=resolve(import.meta.dirname,'../../artifacts/tests/acceptance-batch-regression');
const roots=[];
async function fresh(){await mkdir(base,{recursive:true});const root=await mkdtemp(resolve(base,'case-'));roots.push(root);return root;}
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const contract=()=>packageCases({hosts:['powerShell7'],selected:['ordinary'],artifact:{sha256:'a'.repeat(64)},inputs:{sourceManifestSha256:'b'.repeat(64)}})[0];
function input(files,extra={}){const value={version:1,stage:'native',target:'windows-x64',toolchain:{rustc:'fixed'},configuration:{profile:'release'},files,...extra};return {...value,sha256:digest(value)};}

it('reuses only identical stage inputs and refuses source/config/toolchain/target changes or a tampered manifest',()=>{
  const previous=input({'src/lib.rs':'a'});expect(reuseDecision(previous,input({'src/lib.rs':'a'})).reuse).toBe(true);
  for(const changed of [input({'src/lib.rs':'b'}),input({'src/lib.rs':'a','new-file':'b'}),input({}),
    input(previous.files,{configuration:{profile:'debug'}}),input(previous.files,{toolchain:{rustc:'changed'}}),input(previous.files,{target:'other'})])
    expect(reuseDecision(previous,changed).reuse).toBe(false);
  expect(()=>reuseDecision({...previous,files:{injected:'x'}},previous)).toThrow('tampered');
  expect(reuseDecision(undefined,previous)).toEqual({reuse:false,reason:'missing-provenance'});
});

it('does not invalidate native Core inputs for unrelated JS tooling or report changes',()=>{
  const common={node:'fixed',rustc:'fixed',cargo:'fixed',lockSha256:'first',installedDependencySha256:'first',cargoLockSha256:'main'};
  const before=stageToolchains(common,'native-lock'),after=stageToolchains({...common,lockSha256:'changed',installedDependencySha256:'changed'},'native-lock');
  expect(after.native).toEqual(before.native);expect(after.frontend).not.toEqual(before.frontend);expect(after.package).not.toEqual(before.package);
});

it('streams retained binary verification and refuses changed or missing bytes',async()=>{
  const root=await fresh(),path=resolve(root,'image.exe');await writeFile(path,Buffer.alloc(2*1024*1024,0x61));
  const record={path,role:'compiled',sha256:await hashFile(path)};await verifyRetainedArtifacts([record]);
  await writeFile(path,'tampered');await expect(verifyRetainedArtifacts([record])).rejects.toThrow('changed');
  await rm(path);await expect(verifyRetainedArtifacts([record])).rejects.toThrow();
});

it('inventories explicit roots including unexpected file names and rejects missing inputs or link escapes',async()=>{
  const root=await fresh();await mkdir(resolve(root,'src'));await writeFile(resolve(root,'src/no-extension'),'source');
  const before=await inventory(root,['src']);await writeFile(resolve(root,'report.md'),'report only');expect(await inventory(root,['src'])).toEqual(before);
  await writeFile(resolve(root,'src/other.unknown'),'actual input');expect(await inventory(root,['src'])).not.toEqual(before);
  await expect(inventory(root,['../escape'])).rejects.toThrow('owned root');await expect(inventory(root,['missing'])).rejects.toThrow();
  const outside=await fresh();await symlink(outside,resolve(root,'linked'),'junction');await expect(inventory(root,['linked'])).rejects.toThrow('Linked');
});

it('keeps complete deterministic inventories across bounded hash widths and cancels before file discovery',async()=>{
  const root=await fresh();await mkdir(resolve(root,'src/deep'),{recursive:true});const expected={};
  for(let index=0;index<140;index++){
    const name=`src/deep/input-${index}.data`,bytes=Buffer.alloc(index*7,index%256);
    await writeFile(resolve(root,name),bytes);expected[name]=createHash('sha256').update(bytes).digest('hex');
  }
  const before=await inventory(root,['src'],{concurrency:1});expect(before).toEqual(expected);
  expect(await inventory(root,['src'],{concurrency:4})).toEqual(before);
  const cancellation=new AbortController();cancellation.abort(new Error('cancelled before discovery'));
  await expect(inventory(root,['missing'],{signal:cancellation.signal})).rejects.toThrow('cancelled before discovery');
  await expect(dependencyInventory(root,{signal:cancellation.signal})).rejects.toThrow('cancelled before discovery');
});

it('rejects in-place mutation even when the original modification time is restored',async()=>{
  const root=await fresh(),file=resolve(root,'large.bin');await writeFile(file,Buffer.alloc(8*1024*1024,0x31));
  const before=statSync(file);await delay(20);const hashing=hashFile(file);
  const mutated=new Promise(done=>setImmediate(()=>{writeFileSync(file,Buffer.alloc(8*1024*1024,0x32));utimesSync(file,before.atime,before.mtime);done();}));
  await expect(hashing).rejects.toThrow('changed while hashing');await mutated;
});

it('rejects additions during a scan and cancels an in-flight stream without returning a partial inventory',async()=>{
  const root=await fresh();await mkdir(resolve(root,'src'));await writeFile(resolve(root,'src/large.bin'),Buffer.alloc(8*1024*1024,0x41));
  const scanning=inventory(root,['src']);const changed=new Promise(done=>setImmediate(()=>{writeFileSync(resolve(root,'src/added'),'new input');done();}));
  await expect(scanning).rejects.toThrow('membership changed');await changed;
  const cancellation=new AbortController(),hashing=hashFile(resolve(root,'src/large.bin'),{signal:cancellation.signal});
  cancellation.abort(new Error('cancelled stream'));await expect(hashing).rejects.toThrow('cancelled');
  expect(await hashFile(resolve(root,'src/large.bin'))).toBe(createHash('sha256').update(Buffer.alloc(8*1024*1024,0x41)).digest('hex'));
});

it('assigns a shared checkpoint to every consuming stage without including unrelated stage sources',async()=>{
  const root=await fresh(),all=[...new Set(Object.values(buildInputRoots).flat())];
  const directories=new Set(['src','public','patches','src-tauri/src','src-tauri/vendor','src-tauri/native-input-editors/src','scripts/dependency-builds/psreadline','src-tauri/resources','src-tauri/resources/powershell','src-tauri/resources/conpty','src-tauri/capabilities','src-tauri/icons']);
  for(const path of all){
    if(directories.has(path)){await mkdir(resolve(root,path),{recursive:true});await writeFile(resolve(root,path,'seed'),'input');}
    else{await mkdir(dirname(resolve(root,path)),{recursive:true});await writeFile(resolve(root,path),'input');}
  }
  const shared='src-tauri/vendor/shared.rs',front='src/front.ts',native='src-tauri/native-input-editors/src/lib.rs',backend='src-tauri/src/lib.rs';
  for(const path of [shared,front,native,backend])await writeFile(resolve(root,path),path);
  const descriptors=['native','frontend','package'].map(stage=>({stage,target:'windows-x64',toolchain:{fixed:'compiler'},configuration:{fixed:true},extraPaths:stage==='frontend'?[shared]:[]}));
  const actual=await fingerprints(root,descriptors);
  for(const stage of Object.values(actual))expect(stage.files[shared]).toBe(createHash('sha256').update(shared).digest('hex'));
  expect(actual.frontend.files[front]).toBeDefined();expect(actual.native.files[front]).toBeUndefined();expect(actual.package.files[front]).toBeUndefined();
  expect(actual.native.files[native]).toBeDefined();expect(actual.frontend.files[native]).toBeUndefined();expect(actual.package.files[backend]).toBeDefined();
  await expect(fingerprints(root,[descriptors[0],descriptors[0]])).rejects.toThrow('Duplicate');
});

it('hashes actual dependency bytes and link bindings instead of trusting a lockfile alone',async()=>{
  const root=await fresh();await mkdir(resolve(root,'store'));await writeFile(resolve(root,'store/tool'),'original');await symlink(resolve(root,'store'),resolve(root,'linked'),'junction');
  const before=await dependencyInventory(root);expect(Object.keys(before.links)).toEqual(['linked']);
  await writeFile(resolve(root,'store/tool'),'tampered');expect((await dependencyInventory(root)).sha256).not.toBe(before.sha256);
  const outside=await fresh();await symlink(outside,resolve(root,'escape'),'junction');await expect(dependencyInventory(root)).rejects.toThrow('owned root');
});

it('separates declared Vite outputs and preserves every package byte in the dependency contract',async()=>{
  const root=await fresh();await mkdir(resolve(root,'.vite/vitest'),{recursive:true});await writeFile(resolve(root,'package.js'),'original');
  await writeFile(resolve(root,'.vite/vitest/results.json'),'earlier results');const before=await dependencyInventory(root);
  await writeFile(resolve(root,'.vite/vitest/results.json'),'newer results');expect((await dependencyInventory(root)).sha256).toBe(before.sha256);
  await mkdir(resolve(root,'.vite/deps'));await writeFile(resolve(root,'.vite/deps/react.js'),'generated dev optimization');expect((await dependencyInventory(root)).sha256).toBe(before.sha256);
  await writeFile(resolve(root,'package.js'),'changed');expect((await dependencyInventory(root)).sha256).not.toBe(before.sha256);
  expect(productionDependencyInputs({files:{'package.js':'fixed','.vite/vitest/results.json':'derived'},links:{}})).toEqual({files:{'package.js':'fixed'},links:{}});
});

it('refuses an artifact from an incompatible, failed or uncertain build',()=>{
  const plan={target:'x86_64-pc-windows-msvc'},result={ok:false,phases:[{name:'bundle'}],summary:{executed:0},lifecycle:[{id:'package/build',executed:true},{id:'package/install',executed:false}]};
  expect(()=>assertReusableBuild(plan,result)).not.toThrow();
  expect(()=>assertReusableBuild({target:'other'},result)).toThrow('target');
  expect(()=>assertReusableBuild(plan,{...result,phases:[{name:'bundle',failure:'compile failed'}]})).toThrow('completed build');
  expect(()=>assertReusableBuild(plan,{...result,summary:{executed:1}})).toThrow('uncertain');
});

it('keeps controller-only source freezes out of artifact admission',()=>{
  expect(()=>assertArtifactSourceContext({sealed:true,contextKind:'controller-only'})).toThrow('controller-only');
  expect(()=>assertArtifactSourceContext({sealed:false,contextKind:'artifact-source'})).toThrow();
  expect(()=>assertArtifactSourceContext({sealed:true,contextKind:'artifact-source'})).not.toThrow();
  expect(()=>assertArtifactSourceContext({sealed:true})).not.toThrow();
});

it('recognizes foreign native acceptance across frozen roots without blocking unrelated desktop apps or static checks',()=>{
  const owner=resolve(import.meta.dirname,'../..'),path=owner.replaceAll('\\','/');
  const records=[{pid:10,name:'node.exe',commandLine:`node ${path}/scripts/native-input-p3/windows-package-batch.mjs`},
    {pid:11,name:'node.exe',commandLine:`node ${path}/artifacts/tests/p3/other/s/scripts/verify-ai-session-stream.mjs --no-model`},
    {pid:12,name:'ShellSpan.exe',executablePath:`${path}/artifacts/tests/p3/other/s/image/ShellSpan.exe`},
    {pid:13,name:'ShellSpan.exe',executablePath:`${path}/src-tauri/target/debug/ShellSpan.exe`},
    {pid:14,name:'node.exe',commandLine:`node ${path}/scripts/native-input-p3/windows-package-batch.mjs --list-only`},
    {pid:15,name:'node.exe',commandLine:`node ${path}-unrelated/scripts/verify-ai-session-stream.mjs`}];
  expect(foreignNativeValidations(records,owner,10).map(item=>item.pid)).toEqual([11,12]);
});

it('accepts a bounded matching cancellation request and rejects a different run identity',async()=>{
  const root=await fresh(),path=resolve(root,'cancel.json'),controller=new AbortController();
  const stop=watchBatchCancellation(path,'expected-run',controller,{intervalMs:10});
  try{await writeFile(path,JSON.stringify({version:1,runId:'expected-run'}));while(!controller.signal.aborted)await delay(5);expect(controller.signal.reason.message).toContain('cancellation requested');}finally{stop();}
  const wrong=new AbortController(),stopWrong=watchBatchCancellation(path,'another-run',wrong,{intervalMs:10});
  try{while(!wrong.signal.aborted)await delay(5);expect(wrong.signal.reason.message).toContain('Invalid');}finally{stopWrong();}
});

it('allocates fresh nonoverlapping case identities and data/home/WebView directories',async()=>{
  const root=await fresh(),first=await allocateCase(root),second=await allocateCase(root);
  expect(first.token).not.toBe(second.token);expect(first.directory).not.toBe(second.directory);
  expect(new Set([...Object.values(first.paths),...Object.values(second.paths)]).size).toBe(6);
  await writeFile(resolve(first.paths.data,'ledger'),'first');await expect(readFile(resolve(second.paths.data,'ledger'))).rejects.toThrow();
  expect(()=>packageLoader('http://example.com','a'.repeat(36))).toThrow('loopback');
  expect(()=>packageLoader('http://127.0.0.1:1234','invalid')).toThrow('capability');
});

it('reserves a short exclusive Cargo output and never adopts another batch or the shared target',async()=>{
  const checkout=resolve(import.meta.dirname,'../..');let owner=await realpath(checkout);
  const stageText=await readFile(resolve(checkout,'artifacts/tests/native-input-p3/candidate-stage.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(stageText){const stage=JSON.parse(stageText);expect(stage.root).toBe(checkout);expect(stage.sealed&&stage.completeOwnerSnapshot).toBe(true);owner=await realpath(stage.owner);expect(relative(owner,checkout).replaceAll('\\','/')).toMatch(/^artifacts\/tests\/(?:p3\/[a-f0-9]{8}\/s|native-input-p3\/acceptance-source\/[a-f0-9-]{36}\/ShellSpan)$/);}
  const id=randomUUID(),location=packageCargoLocation(owner,id),target=await reservePackageCargo(owner,id,checkout);
  const actualBase=await realpath(resolve(owner,'artifacts/tests/cb'));expect(relative(owner,actualBase).replaceAll('\\','/')).toBe('artifacts/tests/cb');expect(dirname(await realpath(location.directory))).toBe(actualBase);
  const marker=JSON.parse(await readFile(resolve(location.directory,'owner.json'),'utf8'));expect(marker.batchId).toBe(id);expect(marker.sourceRoot).toBe(checkout);roots.push(location.directory);
  expect(target).toBe(location.target);expect(relative(owner,target).replaceAll('\\','/')).toBe(`artifacts/tests/cb/${id.slice(0,8)}/t`);
  await expect(reservePackageCargo(owner,id,'other-root')).rejects.toThrow();expect(JSON.parse(await readFile(resolve(location.directory,'owner.json'),'utf8'))).toEqual(marker);
  expect(()=>packageCargoLocation(resolve(owner,'long'.repeat(40)),id)).toThrow('path budget');expect(()=>packageCargoLocation(owner,'../outside')).toThrow('identity');
});

it('rejects an overlong Cargo owner before creating any reservation',async()=>{
  const root=await fresh();await expect(reservePackageCargo(resolve(root,'long'.repeat(40)),randomUUID(),'frozen-root')).rejects.toThrow('path budget');expect(await readdir(root)).toEqual([]);
});

it('limits acceptance Tailwind discovery to every frozen src file without changing the production stylesheet',()=>{
  const original="@import 'tailwindcss';\n@import 'shadcn/tailwind.css';\n.xterm { color: inherit; }",scoped=scopePackageStyles(original);
  expect(scoped).toContain("@import 'tailwindcss' source(none);\n@source '../';");expect(scoped).toContain("@import 'shadcn/tailwind.css';");expect(scoped).toContain('.xterm { color: inherit; }');
  expect(()=>scopePackageStyles('unreviewed import')).toThrow('changed');
  expect(()=>assertPackageModuleInput('D:/repo/node_modules/.vite/deps/react.js')).toThrow('cache');
  expect(()=>assertPackageModuleInput('D:\\repo\\node_modules\\.vite\\vitest\\results.json')).toThrow('cache');
  expect(()=>assertPackageModuleInput('D:/repo/node_modules/.pnpm/react/index.js')).not.toThrow();
});

it('copies exact retained native resource bytes, rejects drift, additions and external snapshot origins',async()=>{
  const root=await fresh(),source=resolve(root,'original'),copy=resolve(root,'copy');await mkdir(source);await mkdir(copy);
  for(const directory of [source,copy])await writeFile(resolve(directory,'core.dll'),'original Core');
  const selection={directory:source,paths:['core.dll'],files:await inventory(source,['core.dll'])};await verifySnapshotResourceCopy(selection,copy);
  await writeFile(resolve(copy,'added.dll'),'unexpected');await expect(verifySnapshotResourceCopy(selection,copy)).rejects.toThrow('differ');await rm(resolve(copy,'added.dll'));
  await writeFile(resolve(source,'core.dll'),'tampered');await expect(verifySnapshotResourceCopy(selection,copy)).rejects.toThrow('changed');
  await expect(selectSnapshotResources(root,source)).rejects.toThrow('owned root');
});

it('requires exact evidence conditions and keeps execution, reuse, exclusions, failures and unexecuted counts separate',()=>{
  const item=contract(),record={contract:item,status:'pass',sealed:true,reused:true,id:item.id};expect(evidenceMatches(item,record)).toBe(true);
  for(const field of ['host','transport','artifact','stage','expected','inputs','evidence']){
    const changed=structuredClone(item);changed[field]=field==='evidence'?['different.json']:{changed:true};expect(evidenceMatches(changed,record)).toBe(false);
  }
  const planned=[item,...['failed','cancelled','not-applicable','pending'].map(id=>({...item,id}))];
  const summary=summarize(planned,[record,{id:'failed',status:'fail',executed:true,metrics:{modelDrivenToolCalls:4,llmHttpRequests:null,approvals:3,commandExecutions:2,ordinaryTests:7}},
    {id:'cancelled',status:'blocked'},{id:'not-applicable',status:'not-applicable',reason:'explicit reviewed exclusion'}]);
  expect(summary).toMatchObject({planned:5,executed:1,reused:1,pass:1,fail:1,blocked:1,'not-applicable':1,pending:1,unexecuted:3,fullAcceptancePassed:false,
    metrics:{modelDrivenToolCalls:4,llmHttpRequests:null,approvals:3,commandExecutions:2,ordinaryTests:7}});
  expect(()=>summarize(planned,[{id:'not-applicable',status:'not-applicable'}])).toThrow('reason');
  expect(()=>summarize(planned,[record,record])).toThrow('Duplicate');
  expect(()=>summarize(planned,[{...record,contract:{...item,stage:'changed'}}])).toThrow('conditions');
});

function adapter(failAt,events){return {
  async verify(){events.push('verify');},async build(){events.push('build');if(failAt==='build')throw Error('build failed');},
  async install(){events.push('install');if(failAt==='install')throw Error('partial install');},async verifyInstalled(){events.push('verifyInstalled');},
  async run(item){events.push(item.id);return {status:item.id===failAt?'fail':'pass',reason:item.id===failAt?'original failure':undefined};},
  async stop(){events.push('stop');if(failAt==='stop')throw Error('termination unconfirmed');},
  async uninstall(){events.push('uninstall');if(failAt==='uninstall')throw Error('uninstall failed');}};}

it('rejects an incomplete installed adapter before building or installing',async()=>{
  const events=[],a=adapter(undefined,events);delete a.verifyInstalled;
  await expect(runInstalledCases([{id:'case'}],a)).rejects.toThrow('missing verifyInstalled');expect(events).toEqual([]);
});

it('requires visible measured terminal geometry instead of accepting a buffer-only success',()=>{
  const rect={left:0,top:0,right:960,bottom:600,width:960,height:600},visible={width:960,height:600,host:rect,terminal:rect};
  expect(()=>requireVisiblePackageViewport(visible)).not.toThrow();
  expect(()=>requireVisiblePackageViewport(undefined)).toThrow('Missing');
  expect(()=>requireVisiblePackageViewport({...visible,terminal:null})).toThrow('bounds');
  expect(()=>requireVisiblePackageViewport({...visible,host:{...rect,top:600,bottom:1200}})).toThrow('outside');
});

it('retains only a normally uninstalled owned self-uninstaller and rejects unexpected content',async()=>{
  const root=await fresh(),install=resolve(root,'i'),evidence=resolve(root,'retired');await mkdir(install);await writeFile(resolve(install,'uninstall.exe'),'owned uninstaller');
  const owner=resolve(import.meta.dirname,'../..'),record=await retainUninstallResidue(owner,install,evidence);
  expect(await readFile(resolve(evidence,'uninstall.exe'),'utf8')).toBe('owned uninstaller');expect(record.normalUninstallCompleted).toBe(true);
  await expect(lstat(install)).rejects.toThrow();
  const other=resolve(root,'other');await mkdir(other);await writeFile(resolve(other,'unexpected'),'keep this');
  await expect(retainUninstallResidue(owner,other,resolve(root,'unsafe'))).rejects.toThrow('Unexpected');expect(await readFile(resolve(other,'unexpected'),'utf8')).toBe('keep this');
});

it('builds and installs once, serializes native cases, then stops and uninstalls once',async()=>{
  const events=[],outcome=await runInstalledCases([{id:'host7'},{id:'host5'}],adapter(undefined,events));
  expect(outcome.ok).toBe(true);expect(events.filter(value=>value==='build')).toHaveLength(1);expect(events.filter(value=>value==='install')).toHaveLength(1);
  expect(events.filter(value=>value.startsWith('host'))).toEqual(['host7','host5']);expect(events.slice(-3)).toEqual(['stop','uninstall','verify']);
});

it('retains the first failed outcome and all blocked cases without replay, including partial install cleanup',async()=>{
  const events=[],outcome=await runInstalledCases([{id:'first'},{id:'next'}],adapter('first',events));
  expect(outcome.records).toMatchObject([{id:'first',status:'fail',executed:true,reason:'original failure'},{id:'next',status:'blocked',executed:false}]);
  expect(events).not.toContain('next');expect(events).toContain('uninstall');
  const partial=[];const result=await runInstalledCases([{id:'first'}],adapter('install',partial));expect(result.primaryError).toContain('partial install');expect(partial).toContain('uninstall');
});

it('does not uninstall when termination is unconfirmed, and preserves primary and cleanup failures independently',async()=>{
  const events=[];const a=adapter('stop',events);a.run=async()=>{throw Error('original failure');};
  const result=await runInstalledCases([{id:'first'},{id:'next'}],a);expect(result.primaryError).toContain('original failure');expect(result.cleanupError).toContain('termination unconfirmed');
  expect(events).not.toContain('uninstall');expect(result.records[1]).toMatchObject({executed:false,status:'blocked'});
});

it('cancels between cases, keeps counts and completes cleanup without a second launch',async()=>{
  const abort=new AbortController(),events=[],a=adapter(undefined,events);a.run=async()=>{abort.abort();return {status:'pass'};};
  const result=await runInstalledCases([{id:'first'},{id:'next'}],a,{signal:abort.signal});
  expect(result.records).toMatchObject([{status:'pass',executed:true},{status:'blocked',executed:false,reason:'cancelled-before-execution'}]);expect(result.ok).toBe(false);expect(events).toContain('uninstall');
});

it('enforces execution leases across concurrent tasks and supports cancelled waiters without stealing ownership',async()=>{
  const root=await fresh(),lane=resolve(root,'cargo'),events=[];let release;
  const blocked=new Promise(done=>{release=done;});
  const first=withLease(lane,async()=>{events.push('first');await blocked;events.push('first-end');});
  while(!events.length)await delay(5);
  const abort=new AbortController(),cancelled=withLease(lane,async()=>events.push('cancelled'),{signal:abort.signal});
  abort.abort();await expect(cancelled).rejects.toThrow();
  const second=withLease(lane,async()=>events.push('second'));release();await Promise.all([first,second]);
  expect(events).toEqual(['first','first-end','second']);
  await expect(readFile(resolve(lane,'owner.json'))).rejects.toThrow();
});

it('bounds background audits, preserves worker failures and leaves cancelled items pending',async()=>{
  let live=0,peak=0;const result=await boundedQueue([0,1,2,3,4],2,async value=>{peak=Math.max(peak,++live);await delay(10);live--;if(value===1)throw Error('retain failed');return value;});
  expect(peak).toBe(2);expect(result.map(item=>item.status)).toEqual(['fulfilled','rejected','fulfilled','fulfilled','fulfilled']);
  const abort=new AbortController();abort.abort();expect(await boundedQueue([0,1],2,()=>{}, {signal:abort.signal})).toEqual([{status:'pending'},{status:'pending'}]);
});

it('overlaps only background audits with later work and drains them within a fixed bound',async()=>{
  const queue=backgroundQueue(2);let live=0,peak=0,completed=0;
  for(let index=0;index<5;index++)queue.enqueue(async()=>{peak=Math.max(peak,++live);await delay(10);live--;completed++;if(index===1)throw Error('original retention failure');return index;});
  await delay(1);expect(completed).toBe(0);const result=await queue.drain();expect(peak).toBe(2);expect(completed).toBe(5);expect(result[1]).toMatchObject({status:'rejected'});
});

it('cancellation after a completed build cannot start an installer',async()=>{
  const events=[],abort=new AbortController(),a=adapter(undefined,events);a.build=async()=>abort.abort();
  const result=await runInstalledCases([{id:'first'}],a,{signal:abort.signal});expect(events).not.toContain('install');expect(result.records[0]).toMatchObject({executed:false,status:'blocked'});
});

it('references only sealed exact-condition evidence with independently verified retained binaries',async()=>{
  const root=await fresh(),artifact=resolve(root,'image.exe');await writeFile(artifact,'original binary');
  const item={...contract(),evidence:['result.json']},record={contract:item,status:'pass',artifactProof:{retainedArtifacts:[{path:artifact,role:'installer',sha256:await hashFile(artifact)}]}};
  await writeFile(resolve(root,'result.json'),JSON.stringify(record));await sealCase(root,{status:'pass',producerPids:[],files:['result.json'],terminationConfirmed:true});
  expect(await referenceEvidence(item,root)).toMatchObject({reused:true,executed:false,status:'pass'});
  await expect(referenceEvidence({...item,transport:'SSH'},root)).rejects.toThrow('conditions');
  await writeFile(artifact,'tampered binary');await expect(referenceEvidence(item,root)).rejects.toThrow('changed');
});

it('counts real model tools, terminal commands and HTTP requests independently, preserving unknown command outcomes',()=>{
  const events=[
    {type:'tool/call',data:{call:{name:'write_file',callId:'file'}}},
    {type:'tool/call',data:{call:{name:'run_terminal_command',callId:'command'}}},
    {type:'tool/result',data:{name:'write_file',callId:'file',status:'completed'}},
    {type:'tool/result',data:{name:'run_terminal_command',callId:'command',status:'completed',data:{exitCode:1}}},
  ];
  expect(modelEvidenceMetrics({events,approved:['file','command']},1)).toEqual({modelDrivenToolCalls:2,llmHttpRequests:null,approvals:2,commandExecutions:2,ordinaryTests:1});
  expect(modelEvidenceMetrics({events:events.slice(0,-1),approved:['file','command']},1).commandExecutions).toBeNull();
  expect(modelEvidenceMetrics(undefined,0).modelDrivenToolCalls).toBeNull();
});

it('preserves uninstrumented timing gaps and does not invent an optimized App timing or speedup ratio',()=>{
  const phases=[{name:'prepare-validation',startedAt:'2026-11-04T00:00:00Z',finishedAt:'2026-11-04T00:00:01Z',exitCode:0},
    {name:'bundle',startedAt:'2026-11-04T00:00:03Z',finishedAt:'2026-11-04T00:00:08Z',exitCode:0}];
  expect(legacyTiming(phases,10000)).toMatchObject({totalMs:10000,frontendAndConfigurationGapMs:2000,uninstrumentedMs:4000,stages:{bundle:5000}});
  expect(compareTimings({scope:'actual model cases'},{ok:true,frontendOnly:true,phases:[]})).toMatchObject({comparable:false,speedupRatio:null});
});

it('refuses running, unconfirmed or mutated evidence and retains sealed failures without altering originals',async()=>{
  const root=await fresh();await writeFile(resolve(root,'result.json'),'original failure');await writeFile(resolve(root,'active.json'),'active');
  const options={status:'fail',producerPids:[],files:['result.json'],terminationConfirmed:true};
  await expect(sealCase(root,options)).rejects.toThrow('Running');await rm(resolve(root,'active.json'));
  await expect(sealCase(root,{...options,terminationConfirmed:false})).rejects.toThrow('Termination');
  await expect(sealCase(root,{...options,producerPids:[process.pid]})).rejects.toThrow('still running');
  await sealCase(root,options);const out=resolve(await fresh(),'retained');await retainSealedCase(root,out);
  expect(await readFile(resolve(out,'result.json'),'utf8')).toBe('original failure');expect(await readFile(resolve(root,'result.json'),'utf8')).toBe('original failure');
  await writeFile(resolve(root,'result.json'),'changed');await expect(retainSealedCase(root,resolve(await fresh(),'retained'))).rejects.toThrow('changed');
});

it('takes the complete checklist as obligations, preserves blocked platforms and deferred input, and does not equate a package subset with parent pass',async()=>{
  const text=await readFile(resolve(import.meta.dirname,'../../docs/design/agent-terminal-input-acceptance-checklist.md'),'utf8'),plan=checklistObligations(text);
  expect(plan.requirements).toHaveLength(35);expect(plan.platforms).toHaveLength(5);expect(plan.platforms.filter(host=>host.transport==='ConPTY').map(host=>host.shell)).toEqual(['powerShell7']);
  expect(plan.platforms.filter(host=>host.target).map(host=>host.shell)).toEqual(['bash5.3-readline8.3.6','zsh5.9-zle5.9','bash5.3-readline8.3.6','zsh5.9-zle5.9']);
  expect(plan.obligations.filter(item=>item.host.target).every(item=>item.status==='blocked')).toBe(true);expect(plan.fullAcceptancePassed).toBe(false);
  expect(plan.deferred).toEqual(['Ctrl+Shift+C','manual-copy']);
  expect(()=>packageCases({hosts:['powerShell7'],selected:['manual-display'],artifact:{id:'new'},inputs:{id:'frozen'}})).toThrow('original dedicated');
});
