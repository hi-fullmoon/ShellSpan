import {expect,it} from 'vitest';
import {macDailyExpectedRecords,macDailyFullExpectedRecords,macDailyOutputPlan,macDailySingleOutputPlan,macDailyPasteValues,macDailyTailEditPlan,macDailyUnicodeEditPlan,macDailyCompletionPlan,macDailyPumpCompletionPlan} from './mac-daily-input-plan';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const token='11111111-2222-4333-8444-555555555555';
it('keeps the predeclared 72 combined checkpoints and both actual history executions',()=>{
 expect(macDailyFullExpectedRecords).toEqual([
  'ready','ordinary-0','ordinary-1','nfc-tail-edit','ordinary-2','nfd-tail-edit','ordinary-3','ordinary-4','ordinary-5','ordinary-6','tab-completion','ordinary-7','ordinary-7','history-search','unicode-cursor-before','unicode-cursor-returned','ordinary-8','tui-enter','tui-edit','tui-navigation','ordinary-9','tui-exit','draft-440x320','draft-360x580','draft-1100x320','draft-1100x650','ordinary-10','parked-initial','parked-new-output','parked-440','parked-360','parked-1100','follow-new-output','search-history',
  'multiline-before','multiline-first-cursor','multiline-first-edited','multiline-last-cursor','multiline-edited','ordinary-11','completion-expanded','completion-output','printed-output','printed-440x320','printed-360x580','printed-1100x320','printed-1100x650','follow-output','follow-440x320','follow-360x580','follow-1100x320','follow-1100x650','background-draft','background-440x320','background-360x580','background-1100x320','background-1100x650','background-ended','ordinary-12','pump-started','pump-pasted','pump-cancelled','ordinary-13',
  'pump-completion-started','pump-completion-pasted','pump-completion-received','pump-completion-ended','toast-lease-acquired','toast-visible','toast-lease-released','ordinary-14','transport-end',
 ]);
 expect(macDailyFullExpectedRecords).toHaveLength(72);
 expect(Object.values(macDailyExpectedRecords).map(records=>records[records.length-1])).toEqual(['transport-end','transport-end','transport-end','transport-end','transport-end']);
 expect([macDailyExpectedRecords.native.length,macDailyExpectedRecords.editing.length,macDailyExpectedRecords.pump.length,macDailyExpectedRecords.toast.length]).toEqual([35,31,6,6]);
});
it('keeps distinct NFC and NFD original bytes and literal whitespace',()=>{
 const cases=macDailyPasteValues(token),encode=(s:string)=>Array.from(new TextEncoder().encode(s),b=>b.toString(16).padStart(2,'0')).join('');
 expect(encode(cases[1][1])).toBe('e4b8ade6968720636166c3a920c385');
 expect(encode(cases[2][1])).toBe('e4b8ade696872063616665cc812041cc8a');
 expect(cases[0][1]).toContain('  spaces\t');expect(cases[3][1]).toBe('first line\nsecond\tline\nthird line');
});
it('fixes the ordinary command itself at exactly 4790 UTF8 bytes',()=>{
 const [index,value]=macDailyPasteValues(token)[4];expect(index).toBe(5);
 expect(new TextEncoder().encode(macDailyOutputPlan(token,value,index).source).length).toBe(4790);
 expect(value.startsWith('LONG_')&&value.endsWith('_END')).toBe(true);
});
it('rejects unowned or unbounded output identities and embedded NUL',()=>{
 expect(()=>macDailyOutputPlan('unowned','value',1)).toThrow();expect(()=>macDailyOutputPlan(token,'value',33)).toThrow();expect(()=>macDailyOutputPlan(token,'bad\0value',1)).toThrow();
});
it.runIf(process.platform==='darwin'&&process.arch==='arm64')('retains all real received long-command bytes separately from its short stdout frame',()=>{
 const base=resolve(import.meta.dirname,'../../../../artifacts/tests/mac-daily-pump-plan');mkdirSync(base,{recursive:true});const home=mkdtempSync(resolve(base,'home-')),plan=macDailyPumpCompletionPlan(token);
 expect(Buffer.byteLength(plan.source)).toBe(4790);expect(plan.source).not.toContain(plan.expectedOutput.trimEnd());
 const output=execFileSync('/bin/sh',['-c',plan.source],{env:{...process.env,HOME:home}});
 expect(Array.from(readFileSync(resolve(home,plan.filename)))).toEqual(Array.from(Buffer.from(plan.value)));
 expect(Array.from(output)).toEqual(Array.from(Buffer.from(plan.expectedOutput.replace(/\r\n/g,'\n'))));
 expect(plan.value).toContain('中文_e\u0301_👩🏽‍💻');expect(()=>macDailyPumpCompletionPlan('unowned')).toThrow();
});
it('preserves the exact NFC/NFD prefix while editing an ASCII tail',()=>{
 const values=macDailyPasteValues(token),encoder=new TextEncoder();
 for(const [index,value]of values.slice(1,3)){
  const plan=macDailyTailEditPlan(token,value,index);
  expect(Array.from(encoder.encode(plan.expectedValue).slice(0,encoder.encode(value).length))).toEqual(Array.from(encoder.encode(value)));
  expect(plan.initialValue.endsWith('_TAIL_X')).toBe(true);expect(plan.expectedValue.endsWith('_TAIL_OK')).toBe(true);
  expect(plan.source.slice(plan.source.indexOf(plan.initialValue)+plan.initialValue.length).length).toBe(plan.suffixCharacters);
 }
});
it('keeps the combining/emoji payload while replacing a wide character after a cursor round trip',()=>{
 const plan=macDailyUnicodeEditPlan(token);
 expect(plan.initialValue).toBe('中_e\u0301_👩🏽‍💻_后_TAIL');expect(plan.expectedValue).toBe('文_e\u0301_👩🏽‍💻_后_TAIL');
 expect(plan.source.slice(plan.prefixCharacters).startsWith(plan.initialValue)).toBe(true);
 expect(plan.traversalKeys).toBeGreaterThan(Array.from(plan.initialValue).length);
});
it.runIf(process.platform==='darwin'&&process.arch==='arm64')('creates the actual completion file with a literal Tab without typing a Tab key',()=>{
 const plan=macDailyCompletionPlan(token),base=resolve(import.meta.dirname,'../../../../artifacts/tests/mac-daily-completion');mkdirSync(base,{recursive:true});
 const home=mkdtempSync(resolve(base,'home-'));expect(plan.setup.includes('\t')).toBe(false);
 execFileSync('/bin/sh',['-c',plan.setup],{env:{...process.env,HOME:home}});
 expect(Array.from(readFileSync(resolve(home,plan.filename)))).toEqual(Array.from(new TextEncoder().encode('COMPLETE_11111111_中文_e\u0301\tEND\n')));
});
it.runIf(process.platform==='darwin'&&process.arch==='arm64')('prints the exact independent UTF8 frame through a real Shell and one final printf',()=>{
 const base=resolve(import.meta.dirname,'../../../../artifacts/tests/mac-daily-output');mkdirSync(base,{recursive:true});const home=mkdtempSync(resolve(base,'home-'));
 for(const value of ['BG_中文_e\u0301_👩🏽‍💻_TAIL_OK','中文 café Å\t\'quoted\' "double"']){
  const plan=macDailySingleOutputPlan(token,value,12),actual=execFileSync('/bin/sh',['-c',plan.source],{env:{...process.env,HOME:home}});
  expect(Array.from(actual)).toEqual(Array.from(Buffer.from(plan.prefix+Buffer.from(value,'utf8').toString('hex')+':END\n','utf8')));
 }
});
