import {expect,it} from 'vitest';
import {manualWindowMilliseconds,manualWindowTransition} from '../native-input-p3/windows-manual-window.mjs';
const start={started:true,evidence:{kind:'manual-native-display-start',trusted:true}};
it('starts the bounded operator period only after readiness and one trusted start',()=>{
 expect(manualWindowMilliseconds).toBe(600000);
 expect(()=>manualWindowTransition('waiting',start)).toThrow('Manual start');
 const ready=manualWindowTransition('waiting',{ready:true,evidence:{kind:'manual-native-display-ready'}});
 expect(ready).toEqual({phase:'ready',startOperatorTimer:false});
 expect(()=>manualWindowTransition(ready.phase,{...start,evidence:{...start.evidence,trusted:false}})).toThrow('Manual start');
 const running=manualWindowTransition(ready.phase,start);
 expect(running).toEqual({phase:'started',startOperatorTimer:true});
 expect(()=>manualWindowTransition(running.phase,start)).toThrow('Manual start');
 expect(manualWindowTransition(running.phase,{progress:true})).toEqual({phase:'started',startOperatorTimer:false});
 expect(manualWindowTransition(running.phase,{ok:false})).toEqual({phase:'terminal',startOperatorTimer:false});
 expect(()=>manualWindowTransition('terminal',start)).toThrow('Manual start');
});
