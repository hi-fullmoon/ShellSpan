import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {unzipSync} from 'fflate';

const root=resolve(import.meta.dirname,'../../..');
const pin=JSON.parse(readFileSync(resolve(root,'scripts/dependency-builds/psreadline/build.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const resources=resolve(root,'src-tauri/resources/powershell/PSReadLine/2.4.5');
const {values}=parseArgs({options:{'verify-only':{type:'boolean'},install:{type:'boolean'},archive:{type:'string'}}});
assert.equal(sha(readFileSync(resolve(root,pin.patch))),pin.patchSha256,'Reviewed PSReadLine patch differs');
const license=pin.graphemeProvider?.license;
assert.equal(license,'XTERM-LICENSE','Reviewed display provider license required');
assert.equal(sha(readFileSync(resolve(resources,license))),pin.graphemeProvider.licenseSha256,'Bundled display provider license differs');
if(values['verify-only']){
  assert(!values.install&&!values.archive);
  for(const[path,expected]of Object.entries(pin.outputs))assert.equal(sha(readFileSync(resolve(resources,path))),expected,`Bundled PSReadLine differs: ${path}`);
  const marker=JSON.parse(readFileSync(resolve(resources,'ShellSpan.Build.json'),'utf8'));
  assert.deepEqual(marker,pin,'Bundled PSReadLine provenance differs');
  console.log('Reviewed PSReadLine build and patch digests match');
  process.exit(0);
}
assert.equal(execFileSync('dotnet',['--version'],{encoding:'utf8',windowsHide:true}).trim(),pin.sdkVersion,'Use the reviewed .NET SDK');
const directory=resolve(root,'src-tauri/target/dependencies/psreadline',randomUUID());
mkdirSync(directory,{recursive:true});
let archive;
if(values.archive)archive=readFileSync(resolve(values.archive));
else{const response=await fetch(pin.sourceUrl,{redirect:'error'});assert(response.ok,'Upstream source download failed');archive=Buffer.from(await response.arrayBuffer());}
assert(archive.length<16*1024*1024,'PSReadLine source archive exceeds bound');
assert.equal(sha(archive),pin.sourceSha256,'Upstream PSReadLine archive differs');
writeFileSync(resolve(directory,'source.zip'),archive);
const tree=resolve(directory,'tree');mkdirSync(tree);
let expanded=0;
for(const[name,bytes]of Object.entries(unzipSync(archive))){
  assert(name.startsWith('PSReadLine-2.4.5/')&&!name.split('/').includes('..')&&!isAbsolute(name),'Source archive path rejected');
  expanded+=bytes.length;assert(expanded<64*1024*1024,'Expanded source exceeds bound');
  const destination=resolve(tree,name),child=relative(tree,destination);
  assert(child&&!child.startsWith('..')&&!isAbsolute(child));
  if(name.endsWith('/')){mkdirSync(destination,{recursive:true});continue;}
  mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,bytes);
}
const source=resolve(tree,'PSReadLine-2.4.5');
const patch=process.env.SHELLSPAN_GNU_PATCH??(process.platform==='win32'
  ?resolve(execFileSync('git',['--exec-path'],{encoding:'utf8',windowsHide:true}).trim(),'../../../usr/bin/patch.exe'):'patch');
assert(execFileSync(patch,['--version'],{encoding:'utf8',windowsHide:true}).startsWith('GNU patch 2.7.6'),'Use reviewed GNU patch2.7.6');
execFileSync(patch,['--batch','--forward','--fuzz=0','-p1','-i',resolve(root,pin.patch)],{cwd:source,stdio:'pipe',windowsHide:true});
assert.equal(sha(readFileSync(resolve(source,'PSReadLine',license))),pin.graphemeProvider.licenseSha256,'Patched display provider license differs');
for(const project of ['PSReadLine','Polyfill'])copyFileSync(resolve(root,`scripts/dependency-builds/psreadline/${project}.packages.lock.json`),resolve(source,project,'packages.lock.json'));
const flags=['-c','Release','--nologo','-p:Deterministic=true','-p:DebugType=none','-p:ContinuousIntegrationBuild=true','-p:EnableSourceControlManagerQueries=false','-p:EnableSourceLink=false','-p:RestoreLockedMode=true',`-p:PathMap=${source}=/_/PSReadLine-v2.4.5`];
const log=openSync(resolve(directory,'build.log'),'wx');
try{
  execFileSync('dotnet',['build',resolve(source,'PSReadLine/PSReadLine.csproj'),...flags],{cwd:source,stdio:['ignore',log,log],windowsHide:true});
  execFileSync('dotnet',['build',resolve(source,'Polyfill/Polyfill.csproj'),'-f','net6.0',...flags],{cwd:source,stdio:['ignore',log,log],windowsHide:true});
}finally{closeSync(log);}
const built={
  'Microsoft.PowerShell.PSReadLine.dll':resolve(source,'PSReadLine/bin/Release/netstandard2.0/Microsoft.PowerShell.PSReadLine.dll'),
  'netstd/Microsoft.PowerShell.PSReadLine.Polyfiller.dll':resolve(source,'Polyfill/bin/Release/netstandard2.0/Microsoft.PowerShell.PSReadLine.Polyfiller.dll'),
  'net6plus/Microsoft.PowerShell.PSReadLine.Polyfiller.dll':resolve(source,'Polyfill/bin/Release/net6.0/Microsoft.PowerShell.PSReadLine.Polyfiller.dll'),
};
const actual=Object.fromEntries(Object.entries(built).map(([name,path])=>[name,sha(readFileSync(path))]));
writeFileSync(resolve(directory,'outputs.json'),JSON.stringify(actual,null,2));
assert.deepEqual(actual,pin.outputs,'Rebuilt PSReadLine bytes differ from reviewed artifacts');
if(values.install){
  for(const[name,path]of Object.entries(built))copyFileSync(path,resolve(resources,name));
  writeFileSync(resolve(resources,'ShellSpan.Build.json'),JSON.stringify(pin,null,2)+'\n');
}
writeFileSync(resolve(directory,'result.json'),JSON.stringify({directory,outputs:actual,installed:values.install===true,sourceSha256:pin.sourceSha256,patchSha256:pin.patchSha256,productionAdmitted:false},null,2));
console.log(JSON.stringify({directory,reproducible:true,installed:values.install===true}));
