import {expect,it} from 'vitest';
import {initializationObserverReady} from './native-initialization-observer';
const token='2ac6a506-3cbf-4549-bbac-ec03f9ac7e50';
const receipt={ready:true,token,appPid:202,handleCreated:'2026-11-08T01:02:03.1234567Z',sha256:'a'.repeat(64),observerKinds:['identity','modules'],readOnly:true,inputInjected:false,terminationRequested:false};
it('waits for real observer readiness and accepts the bound pair of held observations',()=>{
 expect(initializationObserverReady({ready:false},token)).toBe(false);expect(initializationObserverReady(receipt,token)).toBe(true);
});
it('refuses wrong tokens, missing observers, unheld identity or a side-effect witness',()=>{
 for(const changed of [{...receipt,token:'foreign'},{...receipt,appPid:0},{...receipt,handleCreated:'unknown'},{...receipt,observerKinds:['modules']},{...receipt,inputInjected:true},{...receipt,terminationRequested:true},{...receipt,sha256:'unknown'}])expect(()=>initializationObserverReady(changed,token)).toThrow('Exact held App');
});
