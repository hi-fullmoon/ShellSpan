import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {nativeManualInputPlan} from './native-manual-input-plan';

it.skipIf(process.platform==='win32').each(['nfc','nfd'] as const)('preserves exact %s command/output bytes through the real POSIX printf',form=>{
 const marker='MAC_MANUAL_012345abcdef',plan=nativeManualInputPlan(marker,form),accent=form==='nfd'?'e\u0301':'é';
 expect(plan.expected).toBe(`${marker} 中文 ${accent} 👩🏽‍💻 edit=BAD`);
 const actual=execFileSync('/bin/sh',['-c',plan.command]);
 expect(actual).toEqual(Buffer.from(plan.expected+'\n','utf8'));
});
it('keeps the NFC default and never normalizes the decomposed acceptance source',()=>{
 const marker='MAC_MANUAL_012345abcdef';
 expect(nativeManualInputPlan(marker)).toEqual(nativeManualInputPlan(marker,'nfc'));
 expect(Buffer.from(nativeManualInputPlan(marker,'nfd').command)).not.toEqual(Buffer.from(nativeManualInputPlan(marker,'nfc').command));
 expect(()=>nativeManualInputPlan('other','nfd')).toThrow('Exact owned manual form');
});
