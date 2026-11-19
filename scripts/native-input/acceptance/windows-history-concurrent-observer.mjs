import assert from 'node:assert/strict';import {resolve,sep} from 'node:path';

export function concurrentReaderInspection(ready,identity,entry,candidate,first){
  assert(ready?.kind==='actual-native-history-concurrent-reader-ready'&&['0','1'].includes(ready.reader)&&/^[a-f0-9-]{36}$/.test(ready.token),'Exact concurrent readiness required');
  const apps=identity.applications.filter(value=>!value.ended),native=identity.shells.filter(value=>!value.ended&&value.modules.some(module=>module.name.toLowerCase()==='shellspan_native_input_editors.dll'&&module.sha256===candidate.moduleSha256));assert.equal(apps.length,1);assert(apps[0].handleHeld);
  let shells=native;
  if(ready.reader==='0'){assert(!first);assert.equal(native.length,1,'First reader must be observed before another is created');}
  else{
    assert(first&&ready.firstObserver?.shellPid===first.shellPid&&ready.firstObserver.handleCreated===first.handleCreated,'Original independent reader identity differs');
    assert.equal(apps[0].pid,first.appPid);const original=identity.shells.find(value=>value.pid===first.shellPid&&value.handleCreated===first.handleCreated);assert(original&&!original.ended&&original.handleHeld,'Original reader must remain live during second-reader inspection');
    assert.equal(native.length,2,'Exactly two live native readers required');shells=native.filter(value=>value.pid!==first.shellPid||value.handleCreated!==first.handleCreated);
  }
  assert.equal(shells.length,1);const shell=shells[0];assert(shell.handleHeld&&shell.parentPid===apps[0].pid);assert.equal(resolve(shell.exe).toLowerCase(),resolve(entry.shell).toLowerCase());if(first)assert(Date.parse(shell.handleCreated)>Date.parse(first.handleCreated),'Second reader is not a genuinely later process');
  if(first)assert.notEqual(shell.pid,first.shellPid,'Simultaneously live readers cannot reuse a numeric PID');
  const module=shell.modules.find(value=>value.name.toLowerCase()==='shellspan_native_input_editors.dll'&&value.sha256===candidate.moduleSha256);assert(module.actualOsLoadedModule&&resolve(module.path).startsWith(resolve(entry.evidence)+sep));
  const provider=shell.modules.find(value=>value.name.toLowerCase()==='microsoft.powershell.psreadline.dll'&&value.sha256===candidate.reviewedProviderSha256);assert(provider?.actualOsLoadedModule,'Actual private provider module identity missing');
  const transport=ready.before?.session?.transportSessionId;assert(typeof transport==='string'&&/^[a-f0-9-]{36}$/.test(transport));if(first)assert.notEqual(transport,first.transportSessionId);
  return{shellPid:shell.pid,parentPid:shell.parentPid,appPid:apps[0].pid,created:shell.created,handleCreated:shell.handleCreated,executable:shell.exe,sha256:shell.exeSha256,module:module.path,moduleSha256:module.sha256,providerModule:provider.path,providerSha256:provider.sha256,token:ready.token,reader:ready.reader,transportSessionId:transport,handleHeld:true,inputInjected:false,terminationRequested:false,source:'Independent held OS App/Shell/module inspection for simultaneous history readers'};
}
