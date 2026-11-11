import {expect,it} from 'vitest';import type {TerminalBrokerSessionSnapshot} from '@/types';
import {verifyNativeFileDecline} from './native-file-decline-evidence';
const before={terminalSessionId:'terminal-owned',terminalGeneration:1,transportSessionId:'transport-owned',currentDirectory:'D:/owned/home',nextInputSequence:5,inputMode:'native-inline'} as TerminalBrokerSessionSnapshot;
it('proves no script/effect/PTY mutation after the normal rejected approval',()=>{
 expect(verifyNativeFileDecline({files:[],effectEntries:[],records:[]},before,{...before})).toEqual({scriptCreated:false,effectCreated:false,terminalInputUnchanged:true,frozenTargetUnchanged:true});
});
it('refuses file creation, effects, changed target/cwd/input or an active native operation',()=>{
 expect(()=>verifyNativeFileDecline({files:[],effectEntries:[]},{} as TerminalBrokerSessionSnapshot,{} as TerminalBrokerSessionSnapshot)).toThrow('original frozen terminal binding');
 for(const state of [{files:[{content:'unexpected'}],effectEntries:[]},{files:[],effectEntries:['ONCE']}])expect(()=>verifyNativeFileDecline(state,before,before)).toThrow('created a script or effect');
 for(const change of [{terminalSessionId:'foreign'},{terminalGeneration:2},{transportSessionId:'foreign'},{currentDirectory:'D:/other'},{nextInputSequence:6},{inputMode:'raw' as const},{activeCommandId:'unexpected'}])expect(()=>verifyNativeFileDecline({files:[],effectEntries:[]},before,{...before,...change})).toThrow();
});
