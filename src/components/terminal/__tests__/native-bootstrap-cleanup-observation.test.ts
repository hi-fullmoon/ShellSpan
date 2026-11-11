import {expect,it} from 'vitest';
import {nativeBootstrapCleanupObservation} from './native-bootstrap-cleanup-observation';

it('keeps a successful filesystem observation and distinguishes retained resources from an empty directory',()=>{
 for(const bootstraps of [[],[{directory:'owned',librarySha256:'a'.repeat(64)}]]){
  const state={files:[{content:'retained script'}],nativeBootstrap:{bootstraps}};
  expect(nativeBootstrapCleanupObservation(200,state)).toBe(state);
 }
});
it('marks only a bounded sharing failure during bootstrap hashing as unavailable, never as empty',()=>{
 for(const stage of ['resource-hash','module-hash'])for(const code of ['EACCES','EPERM','EBUSY']){
  expect(nativeBootstrapCleanupObservation(503,{kind:'scratch-file',stage,code,observationAvailable:false})).toBeNull();
 }
});
it('rejects permanent errors, wrong stages and unrelated witness failures',()=>{
 for(const change of [{code:'EIO'},{stage:'validate-data-root'},{stage:['module-hash']},{code:['EPERM']},{kind:'unrelated'},{observationAvailable:true}]){
  expect(()=>nativeBootstrapCleanupObservation(503,{kind:'scratch-file',stage:'module-hash',code:'EPERM',observationAvailable:false,...change})).toThrow('unavailable');
 }
 for(const status of [400,403,500])expect(()=>nativeBootstrapCleanupObservation(status,{kind:'scratch-file',stage:'module-hash',code:'EPERM',observationAvailable:false})).toThrow('unavailable');
});
it('rejects empty or malformed responses and requires a successful new observation after a sharing failure',()=>{
 for(const value of [null,[],{}, {nativeBootstrap:{}},{nativeBootstrap:{bootstraps:'unknown'}}])expect(()=>nativeBootstrapCleanupObservation(200,value)).toThrow();
 expect(()=>nativeBootstrapCleanupObservation(503,{nativeBootstrap:{bootstraps:[]}})).toThrow('unavailable');
 expect(nativeBootstrapCleanupObservation(503,{kind:'scratch-file',stage:'module-hash',code:'EPERM',observationAvailable:false})).toBeNull();
 expect(nativeBootstrapCleanupObservation(200,{nativeBootstrap:{bootstraps:[{directory:'still present'}]}})?.nativeBootstrap).toEqual({bootstraps:[{directory:'still present'}]});
});
