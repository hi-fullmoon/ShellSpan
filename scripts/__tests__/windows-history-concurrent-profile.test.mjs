import fs from 'node:fs';import p from 'node:path';import {randomUUID} from 'node:crypto';import {expect,it} from 'vitest';
import {prepareWindowsHistoryConcurrentProfile,readWindowsHistoryConcurrentCase} from '../native-input/acceptance/windows-history-concurrent-profile.mjs';
const root=p.resolve(import.meta.dirname,'../../artifacts/tests/concurrent-profile-components');
it.each(['history-default','history-small','history-save-at-exit','history-save-nothing'])('prepares two readers of one original namespace without writing history: %s',mode=>{
 const evidence=p.join(root,randomUUID());fs.mkdirSync(p.join(evidence,'home'),{recursive:true});fs.mkdirSync(p.join(evidence,'data'));const options={evidence,home:p.join(evidence,'home'),data:p.join(evidence,'data'),host:'powerShell7',mode,maximumVariable:'int71',reuseId:randomUUID()},plan=prepareWindowsHistoryConcurrentProfile(options);
 const read=reader=>JSON.parse(fs.readFileSync(p.join(evidence,`native-history-reuse-reader-${reader}.json`))),first=read('0'),second=read('1');expect(first.scene).toBe('concurrent');expect(second.beforeReader).toEqual(first.beforeReader);expect(second.initialSources).toEqual(first.initialSources);expect(fs.existsSync(plan.history)).toBe(false);expect(first.beforeReader.exists).toBe(mode!=='history-save-nothing');
 const original=fs.readFileSync(plan.reusePlan);expect(()=>prepareWindowsHistoryConcurrentProfile(options)).toThrow();expect(fs.readFileSync(plan.reusePlan)).toEqual(original);
});
it('rejects a restart-only or missing plan before accepting any reader receipt',async()=>{
 const evidence=p.join(root,randomUUID());fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(p.join(evidence,'native-history-plan.json'),JSON.stringify({reusable:true,concurrent:false}),{flag:'wx'});
 await expect(readWindowsHistoryConcurrentCase(evidence,{reader:'0'})).rejects.toThrow('concurrent history plan');await expect(readWindowsHistoryConcurrentCase(evidence,{reader:'../../0'})).rejects.toThrow('Exact concurrent reader');
});
