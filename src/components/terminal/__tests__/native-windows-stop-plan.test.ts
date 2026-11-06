import {expect,it} from 'vitest';
import {nativeWindowsStopSource,matchesNativeWindowsStop,matchesWindowsStopResult} from './native-windows-stop-plan';
const source=nativeWindowsStopSource('00000000-0000-4000-8000-000000000001');
it('binds only one exact foreground stop program to its original timeout',()=>{
 const args={command:source,background:false,timeoutMs:30000};expect(matchesNativeWindowsStop(args,source)).toBe(true);
 for(const changed of [{command:source+'; exit'},{background:true},{timeoutMs:1000},{lifecycleTrust:'directRequired'}])expect(matchesNativeWindowsStop({...args,...changed},source)).toBe(false);
 expect(()=>nativeWindowsStopSource('../foreign')).toThrow();
});
it('keeps unknown source execution distinct from the requested cancellation state',()=>{
 const data={channel:'terminal',state:'cancelled',execution:'unknown',exitCode:1,noAutoReplay:true};
 expect(matchesWindowsStopResult('cancelled',data,'cancel')).toBe(true);
 for(const changed of [{state:'uncertain'},{execution:'completed'},{exitCode:null},{noAutoReplay:false}])expect(matchesWindowsStopResult('cancelled',{...data,...changed},'cancel')).toBe(false);
 expect(matchesWindowsStopResult('cancelled',data,'takeover')).toBe(false);
});
