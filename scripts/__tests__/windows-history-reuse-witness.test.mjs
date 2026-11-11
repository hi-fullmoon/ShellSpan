import {expect, it} from 'vitest';
import fs from 'node:fs';import p from 'node:path';import {randomUUID, createHash} from 'node:crypto';
import {prepareWindowsHistoryReuseProfile} from '../native-input-p3/windows-history-reuse-profile.mjs';
import {readWindowsHistoryReuseReceipt, readWindowsHistoryReuseCase} from '../native-input-p3/windows-history-reuse-witness.mjs';
import {readOwnedHistoryJson} from '../native-input-p3/windows-history-witness.mjs';

function fixture(){
 const root=p.resolve(import.meta.dirname,'../../.artifacts/tests/history-reuse-witness',randomUUID());fs.mkdirSync(p.join(root,'home'),{recursive:true});fs.mkdirSync(p.join(root,'data'));
 const plan=prepareWindowsHistoryReuseProfile({host:'powerShell7',mode:'history-default',maximumVariable:'int71',evidence:root,home:p.join(root,'home'),data:p.join(root,'data'),reuseId:randomUUID()});
 const expected={host:plan.host,mode:plan.mode,reuseId:plan.reuseId,pid:2345,created:'2026-11-08T01:00:00.1234567Z',seedApplied:false,beforeReader:{exists:true,bytes:37,sha256:createHash('sha256').update('prior actual disk witness').digest('hex')}};
 const launch=p.join(plan.launches,'2345-639296964001234567.json');
 const receipt={readerPid:expected.pid,readerCreated:expected.created,reuseId:plan.reuseId,mode:plan.mode,maximumVariable:plan.maximumVariable,expectedNativePath:plan.history,profilePath:plan.profile,style:'SaveIncrementally',seedApplied:false,historyBeforeReader:expected.beforeReader};
 fs.writeFileSync(launch,JSON.stringify(receipt),{flag:'wx'});
 const seed=JSON.parse(fs.readFileSync(plan.reusePlan,'utf8'));
 for(const name of ['seed-started.json','seed-ready.json'])fs.writeFileSync(p.join(plan.marker,name),JSON.stringify({...seed,style:receipt.style}),{flag:'wx'});
 return {root,plan,expected,receipt,launch};
}
it('selects the exact held reader and verifies no reseed against independent prior disk evidence',async()=>{
 const f=fixture();const value=await readWindowsHistoryReuseReceipt(f.root,f.expected);expect(value.readerPid).toBe(f.expected.pid);expect(value.seedApplied).toBe(false);
 fs.writeFileSync(p.join(f.plan.launches,'9999-639296964001234568.json'),JSON.stringify({...f.receipt,readerPid:9999,seedApplied:true}),{flag:'wx'});
 expect((await readWindowsHistoryReuseReceipt(f.root,f.expected)).receipt).toBe(f.launch);
});
it.each(['pid-reuse','reseed','disk-changed','foreign-marker'])('refuses %s rather than selecting a newer or foreign reader',async fault=>{
 const f=fixture();if(fault==='pid-reuse')f.expected.created='2026-11-08T01:00:00.1234568Z';
 if(fault==='reseed')fs.writeFileSync(f.launch,JSON.stringify({...f.receipt,seedApplied:true}));
 if(fault==='disk-changed')f.expected.beforeReader={...f.expected.beforeReader,bytes:38};
 if(fault==='foreign-marker'){const file=p.join(f.plan.marker,'seed-ready.json'),value=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify({...value,reuseId:randomUUID()}));}
 await expect(readWindowsHistoryReuseReceipt(f.root,f.expected)).rejects.toThrow();
});
it('refuses paths escaping the owned evidence root',async()=>{
 const f=fixture();await expect(readOwnedHistoryJson(f.root,'../outside.json')).rejects.toThrow('escaped owned root');
 await expect(readOwnedHistoryJson(f.root,f.launch)).rejects.toThrow('escaped owned root');
});
it('binds a restart reader profile to its held observer and preplanned previous history',async()=>{
 const f=fixture(),token=randomUUID();
 fs.writeFileSync(p.join(f.root,'native-history-plan.json'),JSON.stringify(f.plan),{flag:'wx'});
 fs.writeFileSync(f.launch,JSON.stringify({...f.receipt,effectiveMaximum:71}));
 fs.writeFileSync(p.join(f.root,'native-history-reuse-reader-1.json'),JSON.stringify({version:1,reader:'1',host:f.plan.host,mode:f.plan.mode,reuseId:f.plan.reuseId,beforeReader:f.expected.beforeReader,initialSources:['seed-a','exit']}),{flag:'wx'});
 const observer=p.join(f.root,'native-job-observer-history-reader-1.json');
 fs.writeFileSync(observer,JSON.stringify({token,shellPid:f.expected.pid,handleCreated:f.expected.created,handleHeld:true,inputInjected:false,terminationRequested:false}),{flag:'wx'});
 const value=await readWindowsHistoryReuseCase(f.root,{mode:f.plan.mode,host:f.plan.host,reader:'1',token});expect(value.expectedInitialSources).toEqual(['seed-a','exit']);expect(value.expectedMaximum).toBe(71);
 await expect(readWindowsHistoryReuseCase(f.root,{mode:f.plan.mode,host:f.plan.host,reader:'1',token:randomUUID()})).rejects.toThrow('held reader');
});
