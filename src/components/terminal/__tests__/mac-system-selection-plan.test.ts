import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {macSystemSelectionPlan} from './mac-system-selection-plan';
import {macHumanPlan} from './mac-human-plan';

it.skipIf(process.platform!=='darwin')('prints the original real system-selection samples and native mode bytes through actual macOS base64',()=>{
 const token=randomUUID(),plan=macSystemSelectionPlan(token),human=macHumanPlan(token);
 for(const [source,expected]of [[plan.initialSource,'\x1b]1337;SetUserVar=ShellSpanNativeInput=MA==\x07'+human.payload+'\n'],[plan.nativeSource,'\x1b]1337;SetUserVar=ShellSpanNativeInput=MQ==\x07'+human.nativeRaw+'\n'],[plan.exitModeSource,'\x1b]1337;SetUserVar=ShellSpanNativeInput=MA==\x07SYSTEM_SELECTION_DONE\n']]){
  const command=source.endsWith('\r')?source.slice(0,-1):source,result=spawnSync('/bin/sh',['-c',command]);
  expect(result.status,String(result.stderr)).toBe(0);expect(result.stdout.equals(Buffer.from(expected))).toBe(true);
 }
 expect(plan.phases.map(phase=>phase.id)).toEqual(['ascii-forward','ascii-reverse','unicode-default','soft-wrap','hard-lines','unicode-native']);
 expect(plan.sourceSamples.unicodeRaw).toContain('\t');expect(plan.sourceSamples.unicodeCopy).toContain('A        B');
 expect(Buffer.from(plan.sourceSamples.unicodeCopy).includes(Buffer.from('e\u0301'))).toBe(true);
 expect(Buffer.from(plan.sourceSamples.unicodeCopy).includes(Buffer.from('é'))).toBe(false);
});
