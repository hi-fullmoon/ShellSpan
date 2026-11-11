import {expect,it} from 'vitest';import {nativeFileReferencePlan,matchesNativeFileReferenceStep,matchesNativeFileReferenceOriginal,nativeFileReferenceInitialGoal,nativeFileReferenceContinuationGoal,verifyNativeFileProcessReference} from './native-file-reference-plan';import {nativeFileContentSha256,verifyNativeFileOwner} from './native-file-chain-edit';import observationGoals from '@/lib/ai/__tests__/native-file-observation-goals.json';
it('matches the full goal checked by the backend redaction contract using a non-secret runId',()=>{const plan=nativeFileReferencePlan(observationGoals.runId,observationGoals.cwd);expect(nativeFileReferenceInitialGoal(plan)).toBe(observationGoals.referenceGoal);expect(plan.content).toContain('$r=@{runId=');expect(plan.content).not.toContain('$r=@{token=');});
const token='11111111-1111-4111-8111-111111111111',cwd="D:/parent's/工作目录",handle='job-'+'a'.repeat(32);
it('keeps caller cwd and exact returned path distinct from the complete stored background script',()=>{
 const plan=nativeFileReferencePlan(token,cwd);plan.absolutePath="\\\\?\\D:\\data\\tmp\\0123456789abcdef\\parent's.ps1";plan.invoke="& '"+plan.absolutePath.split("'").join("''")+"'";
 expect(plan.content).toContain("CreateNew");expect(plan.content).toContain("parent''s/工作目录");expect(plan.content).toContain('while($true)');expect(plan.setup).not.toContain('Set-Location');expect(plan.final).toContain('parent cwd changed');
 expect(nativeFileReferenceInitialGoal(plan)).toContain('exactly FIVE');expect(nativeFileReferenceContinuationGoal(plan,handle)).toContain('exactly THREE');
 expect(matchesNativeFileReferenceOriginal(plan,3,'run_terminal_command',{command:plan.invoke,background:true,timeoutMs:60000},handle)).toBe(true);
 for(const change of [{command:plan.content},{command:plan.invoke.slice(2)},{background:false},{timeoutMs:5000}])expect(matchesNativeFileReferenceOriginal(plan,3,'run_terminal_command',{command:plan.invoke,background:true,timeoutMs:60000,...change},handle)).toBe(false);
 expect(matchesNativeFileReferenceStep(plan,0,'run_terminal_command',{command:plan.setup,timeoutMs:5000})).toBe(true);expect(matchesNativeFileReferenceOriginal(plan,0,'run_terminal_command',{command:plan.setup,timeoutMs:5000})).toBe(false);
});
it('requires original bounded read, opaque handle and exact wait/stop options',()=>{
 const plan=nativeFileReferencePlan(token,cwd),read={fileScope:'scratch',path:plan.fileName,encoding:'utf8',offset:0,maxBytes:8192};
 expect(matchesNativeFileReferenceStep(plan,2,'read_file',read)).toBe(true);for(const change of [{maxBytes:16384},{offset:1},{path:'other.ps1'},{fileScope:'workspace'}])expect(matchesNativeFileReferenceStep(plan,2,'read_file',{...read,...change})).toBe(false);
 expect(matchesNativeFileReferenceStep(plan,4,'wait_process',{processHandle:handle,timeoutMs:1000},handle)).toBe(true);expect(matchesNativeFileReferenceStep(plan,5,'kill_process',{processHandle:handle,signal:'terminate',timeoutMs:10000},handle)).toBe(true);
 for(const value of [{processHandle:'job-'+'b'.repeat(32),signal:'terminate',timeoutMs:10000},{processHandle:handle,signal:'terminate',timeoutMs:20000},{processHandle:handle,signal:'terminate',timeoutMs:10000,force:true}])expect(matchesNativeFileReferenceStep(plan,5,'kill_process',value,handle)).toBe(false);
 expect(()=>nativeFileReferenceContinuationGoal(plan,'foreign')).toThrow('Original actual');
});
it('binds an actual process reference to full ownership, original task and execution target until settlement',async()=>{
 const id='agent-owned',session='terminal-owned',target={kind:'local',targetId:'terminal-'+session,sessionId:session,cwd},key=await nativeFileContentSha256(JSON.stringify([id,target])),path=`D:/data/tmp/${key.slice(0,16)}/script.ps1`,use={state:'process',handle,task_id:id,executionTarget:target},record={version:2,key,sessionId:id,target,uses:{process:use}};
 await expect(verifyNativeFileProcessReference({records:[record]},id,session,cwd,path,handle)).resolves.toMatchObject({handle,taskId:id,retained:true,state:'process'});
 for(const changed of [{...use,handle:'job-'+'b'.repeat(32)},{...use,task_id:'foreign'},{state:'process',handle,taskId:id},{...use,state:'uncertain'},{...use,executionTarget:{...target,sessionId:'foreign'}}])await expect(verifyNativeFileProcessReference({records:[{...record,uses:{process:changed}}]},id,session,cwd,path,handle)).rejects.toThrow();
 await expect(verifyNativeFileOwner({records:[record]},id,session,cwd,path,'settled')).rejects.toThrow('retention');await expect(verifyNativeFileOwner({records:[{...record,uses:{}}]},id,session,cwd,path,'settled')).resolves.toBeUndefined();
});
