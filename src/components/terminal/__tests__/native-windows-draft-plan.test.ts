import {expect,it} from 'vitest';
import {nativeWindowsDraftSource,matchesWindowsDraftArgs,isWindowsDraftCancelStage} from './native-windows-draft-plan';
import type {TerminalCommandObservation} from '@/types';
it('separates observed typing and full-input windows without admitting intent or submission',()=>{
 const typing:TerminalCommandObservation={phase:'typing',agentSessionId:'agent',taskId:'task',operationId:'operation',commandId:'command',submissionIntentDurable:false,draftCleared:false,mayHaveSubmitted:false,fullInputConfirmed:false,leaseGeneration:1,sourceRevision:1,safeActions:['query','requestStop'],legacyState:'submitted',legacyRevision:1,sourceMayBeEnqueued:true,executionEvidence:'unknown',noAutoReplay:true};
 const full:TerminalCommandObservation={...typing,phase:'inputConfirmed',fullInputConfirmed:true};
 expect(isWindowsDraftCancelStage(typing,'agent','typing')).toBe(true);expect(isWindowsDraftCancelStage(typing,'agent','fullInput')).toBe(false);
 expect(isWindowsDraftCancelStage(full,'agent','fullInput')).toBe(true);expect(isWindowsDraftCancelStage(full,'agent','typing')).toBe(false);
 for(const changed of [{agentSessionId:'other'},{submissionIntentDurable:true},{mayHaveSubmitted:true},{sourceMayBeEnqueued:false},{phase:'cancelled' as const}])expect(isWindowsDraftCancelStage({...full,...changed},'agent','fullInput')).toBe(false);
 expect(isWindowsDraftCancelStage(undefined,'agent','fullInput')).toBe(false);
});
it('keeps a fixed ASCII draft with an exact immutable terminal call',()=>{
 const {source,prefix}=nativeWindowsDraftSource('00000000-0000-4000-8000-000000000001');expect(new TextEncoder().encode(source)).toHaveLength(2048);expect(source.startsWith(prefix+'\n')).toBe(true);const args={command:source,background:false,timeoutMs:10000,lifecycleTrust:'cooperative'};expect(matchesWindowsDraftArgs(args,source)).toBe(true);
 for(const changed of [{command:source+'a'},{command:source.split('\n').join('\r\n')},{background:true},{lifecycleTrust:'directRequired'}])expect(matchesWindowsDraftArgs({...args,...changed},source)).toBe(false);
});
it('keeps original approval intent distinct from normalized terminal arguments',()=>{
 const source='exact source',prepared={command:source,timeoutMs:10000};
 expect(matchesWindowsDraftArgs(prepared,source,true)).toBe(true);
 expect(matchesWindowsDraftArgs(prepared,source)).toBe(false);
 expect(matchesWindowsDraftArgs({...prepared,background:false,lifecycleTrust:'cooperative'},source,true)).toBe(false);
 expect(matchesWindowsDraftArgs({...prepared,command:source+' '},source,true)).toBe(false);
 expect(matchesWindowsDraftArgs({...prepared,explanation:42},source,true)).toBe(false);
});
