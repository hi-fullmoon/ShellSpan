import {expect,it} from 'vitest';import p from 'node:path';import {concurrentReaderInspection} from '../native-input-p3/windows-history-concurrent-observer.mjs';
const evidence=p.resolve(import.meta.dirname,'../../.artifacts/tests/concurrent-observer-component'),entry={evidence,shell:'D:/owned/pwsh.exe'},candidate={moduleSha256:'a'.repeat(64),reviewedProviderSha256:'c'.repeat(64)},token='d1dd1ee3-0274-49be-9d2a-f433c466e1d2';
const shell=(pid,birth)=>({pid,parentPid:100,created:birth,handleCreated:birth,handleHeld:true,ended:false,exe:entry.shell,exeSha256:'b'.repeat(64),modules:[{name:'shellspan_native_input_editors.dll',path:p.join(evidence,'module.dll'),sha256:candidate.moduleSha256,actualOsLoadedModule:true},{name:'Microsoft.PowerShell.PSReadLine.dll',path:p.join(evidence,'provider.dll'),sha256:candidate.reviewedProviderSha256,actualOsLoadedModule:true}]});
const app={pid:100,ended:false,handleHeld:true},s0=shell(200,'2026-11-08T03:00:00.0000000Z'),s1=shell(300,'2026-11-08T03:00:01.0000000Z'),ready=(reader,transport)=>({kind:'actual-native-history-concurrent-reader-ready',token,reader,before:{session:{transportSessionId:transport}}}),firstReady=ready('0','11111111-1111-4111-8111-111111111111');
it('publishes a second actual identity only while the separately inspected first reader is still live',()=>{
 const first=concurrentReaderInspection(firstReady,{applications:[app],shells:[s0]},entry,candidate);
 const secondReady={...ready('1','22222222-2222-4222-8222-222222222222'),firstObserver:first};
 const second=concurrentReaderInspection(secondReady,{applications:[app],shells:[s0,s1]},entry,candidate,first);expect(second.shellPid).toBe(300);expect(second.appPid).toBe(first.appPid);expect(second.transportSessionId).not.toBe(first.transportSessionId);
 for(const shells of [[s0],[{...s0,ended:true},s1],[s0,{...s1,pid:s0.pid}],[s0,{...s1,handleCreated:s0.handleCreated}],[s0,{...s1,parentPid:999}],[s0,{...s1,modules:[]}],[s0,{...s1,modules:s1.modules.slice(0,1)}]])expect(()=>concurrentReaderInspection(secondReady,{applications:[app],shells},entry,candidate,first)).toThrow();
 expect(()=>concurrentReaderInspection({...secondReady,firstObserver:{...first,handleCreated:'stale'}},{applications:[app],shells:[s0,s1]},entry,candidate,first)).toThrow('Original independent');
});
it('refuses ambiguous first-reader sampling instead of choosing the oldest or newest PID',()=>{
 expect(()=>concurrentReaderInspection(firstReady,{applications:[app],shells:[s0,s1]},entry,candidate)).toThrow('First reader');
 expect(()=>concurrentReaderInspection(firstReady,{applications:[{...app,handleHeld:false}],shells:[s0]},entry,candidate)).toThrow();
});
