import {afterAll,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {macHumanPlan,macHumanScope} from './mac-human-plan';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
const token='11111111-2222-4333-8444-555555555555';
it('limits fresh Zsh selection work to the two missing original steps while retaining existing human scopes',()=>{
 expect(macHumanScope('human-selection-zsh')).toEqual({caseScope:'selection-supplement',steps:[5,6]});
 for(const family of ['zsh','bash']){
  expect(macHumanScope('human-'+family)).toEqual({caseScope:'full-nine-step',steps:[1,2,3,4,5,6,7,8,9]});
  expect(macHumanScope('human-copy-'+family)).toEqual({caseScope:'copy-supplement',steps:[7,8,9]});
 }
 for(const selection of [null,'human-selection-bash','human-selection-zsh-extra','raw-zsh','system-selection-zsh'])expect(()=>macHumanScope(selection)).toThrow('Exact isolated human selection required');
});
it('tells the real operator to use the system copy shortcut for every default-mode selection',()=>{
 for(const key of ['terminal.human.step4','terminal.human.step5','terminal.human.step6'] as const){expect(zhCN[key]).toContain('⌘C');expect(enUS[key]).toContain('⌘C');}
});
it.runIf(process.platform==='darwin'&&process.arch==='arm64')('prints exact independent human command results through a real Shell, including unchanged NFD bytes',()=>{
 const directory=resolve(import.meta.dirname,'../../../../artifacts/tests/mac-human-plan');mkdirSync(directory,{recursive:true});const home=mkdtempSync(resolve(directory,'home-')),plan=macHumanPlan(token);
 const sources=[plan.inputs[0].source.replace('EDIT_BAD','EDIT_BAK'),plan.inputs[1].source+"中文'",plan.inputs[2].source.replace(/_X$/,'_K')];
 for(const [i,source]of sources.entries())expect(execFileSync('/bin/sh',['-c',source],{env:{...process.env,HOME:home}})).toEqual(Buffer.from(plan.inputs[i].expected.replace(/\r\n/g,'\n')));
 expect(plan.unicodeRaw).toContain('\t');expect(plan.unicodeCopy).toContain('A        B  中文 e\u0301');expect(plan.nativeCopy).toContain('A        B  中文 e\u0301');
 expect(()=>macHumanPlan('unowned')).toThrow();
});

afterAll(()=>{rmSync(resolve(import.meta.dirname,'../../../../artifacts/tests/mac-human-plan'),{recursive:true,force:true});});
