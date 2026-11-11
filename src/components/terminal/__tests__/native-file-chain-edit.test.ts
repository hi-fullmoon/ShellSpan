import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {matchesNativeFileChainStep} from './native-file-chain-approval';
import {matchesNativeFileEditOriginal,nativeFileContentSha256,nativeFileEditExplanation,nativeFileEditGoal,nativeFileEditPlan,verifyNativeFileEditRead,verifyNativeFileEditResult,verifyNativeFileOwner,recordNativeFileEditDigest} from './native-file-chain-edit';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());
const token='12345678-1234-1234-1234-123456789abc';
const make=()=>nativeFileEditPlan({fileName:`acceptance-${token}.ps1`,content:'Write-Output "中文 e\u0301 👩🏽‍💻 !\t\r\n"',setup:'owned setup'},token);
it('requires an actual edit before the original script body and keeps both source versions exact',()=>{
 const plan=make();expect(plan.content).toContain("if($NativeFileRevision -cne 'AFTER_EDIT_");expect(plan.edit!.content).toBe(plan.content.replace(plan.edit!.oldString,plan.edit!.newString));expect(plan.content.split(plan.edit!.oldString)).toHaveLength(2);
 const goal=nativeFileEditGoal(plan),write=JSON.parse(goal.split('\n2. write_file with ')[1].split('.\n3.')[0]) as {content:string};expect(write.content).toBe(plan.content);expect(goal).toContain('exact sha256 returned by call3');expect(goal).toContain('Execute that path, not the script text');expect(()=>nativeFileEditPlan(plan,token)).toThrow('fresh');
});
it('only permits digest-bound edit/read/readback/path invocation in the six-step order',()=>{
 const plan=make();plan.absolutePath='D:/owned/returned.ps1';plan.invoke="& 'D:/owned/returned.ps1'";const digest='a'.repeat(64),edit={fileScope:'scratch',path:plan.fileName,oldString:plan.edit!.oldString,newString:plan.edit!.newString,precondition:{sha256:digest}};
 expect(matchesNativeFileChainStep(3,'edit_file',edit,plan)).toBe(false);plan.edit!.sha256=digest;expect(matchesNativeFileEditOriginal(3,'edit_file',edit,plan)).toBe(true);
 for(const change of [{fileScope:'workspace'},{path:'foreign.ps1'},{oldString:'other'},{newString:'other'},{precondition:{sha256:'b'.repeat(64)}},{precondition:{sha256:digest,mustNotExist:true}},{lifecycleTrust:'directRequired'}])expect(matchesNativeFileEditOriginal(3,'edit_file',{...edit,...change},plan)).toBe(false);
 const read={fileScope:'scratch',path:plan.fileName,encoding:'utf8',offset:0,maxBytes:8192};for(const index of [2,4])expect(matchesNativeFileEditOriginal(index,'read_file',read,plan)).toBe(true);
 expect(matchesNativeFileEditOriginal(4,'read_file',{...read,offset:undefined},plan)).toBe(false);expect(matchesNativeFileChainStep(3,'run_terminal_command',{command:plan.invoke,timeoutMs:5000},plan)).toBe(false);
 const run={command:plan.invoke,background:false,timeoutMs:5000,explanation:nativeFileEditExplanation};expect(matchesNativeFileEditOriginal(5,'run_terminal_command',run,plan)).toBe(true);for(const change of [{background:undefined},{background:true},{command:"& 'D:/other.ps1'"},{lifecycleTrust:'cooperative'}])expect(matchesNativeFileEditOriginal(5,'run_terminal_command',{...run,...change},plan)).toBe(false);
});
it('checks exact full UTF-8 readback and digest without treating truncated text as a complete script',async()=>{
 const plan=make(),content=plan.content,path='D:/owned/returned.ps1',sha256=await nativeFileContentSha256(content),bytes=new TextEncoder().encode(content).length,data={path,content,fileScope:'scratch',temporary:true,encoding:'utf8',offset:0,truncated:false,readBytes:bytes,byteLength:bytes,nextOffset:bytes,sha256};
 await expect(verifyNativeFileEditRead(data,content,path)).resolves.toBe(sha256);for(const change of [{path:'D:/other.ps1'},{content:content.normalize('NFC')},{truncated:true},{sha256:'b'.repeat(64)},{offset:1},{nextOffset:bytes-1},{readBytes:bytes-1}])await expect(verifyNativeFileEditRead({...data,...change},content,path)).rejects.toThrow('read/path');
});
it('accepts only an optional current tool-result read digest while preserving every bounded base option',()=>{
 const plan=make(),read={fileScope:'scratch',path:plan.fileName,encoding:'utf8',offset:0,maxBytes:8192},before='a'.repeat(64),after='b'.repeat(64);
 expect(matchesNativeFileEditOriginal(2,'read_file',{...read,expectedSha256:before},plan)).toBe(false);plan.currentFileSha256=before;expect(matchesNativeFileEditOriginal(2,'read_file',{...read,expectedSha256:before},plan)).toBe(true);expect(matchesNativeFileEditOriginal(2,'read_file',read,plan)).toBe(true);
 for(const change of [{expectedSha256:after},{expectedSha256:'a'.repeat(63)},{expectedSha256:123},{maxBytes:16384},{offset:1},{fileScope:'workspace'},{path:'foreign.ps1'},{unrelated:true}])expect(matchesNativeFileEditOriginal(2,'read_file',{...read,expectedSha256:before,...change},plan)).toBe(false);
 plan.currentFileSha256=after;expect(matchesNativeFileEditOriginal(4,'read_file',{...read,expectedSha256:before},plan)).toBe(false);expect(matchesNativeFileEditOriginal(4,'read_file',{...read,expectedSha256:after},plan)).toBe(true);expect(nativeFileEditGoal(plan)).toContain('never reuse the pre-edit digest');
});
it('takes current read guards only from completed owned write/edit results without changing the source',()=>{
 const plan=make();plan.absolutePath='D:/owned/script.ps1';const original=plan.content,before='a'.repeat(64),after='b'.repeat(64),write={fileScope:'scratch',temporary:true,path:plan.absolutePath,written:true,verified:true,afterSha256:before};recordNativeFileEditDigest(plan,1,write);expect(plan.currentFileSha256).toBe(before);expect(plan.content).toBe(original);
 plan.edit!.sha256=before;const edit={fileScope:'scratch',temporary:true,applied:true,verified:true,files:[{path:plan.absolutePath,beforeSha256:before,afterSha256:after}]};recordNativeFileEditDigest(plan,3,edit);expect(plan.currentFileSha256).toBe(after);expect(plan.content).toBe(original);
 for(const change of [{verified:false},{fileScope:'workspace'},{path:'D:/foreign.ps1'},{afterSha256:undefined}])expect(()=>recordNativeFileEditDigest(plan,1,{...write,...change})).toThrow();expect(()=>recordNativeFileEditDigest(plan,3,{...edit,files:[{...edit.files[0],beforeSha256:'c'.repeat(64)}]})).toThrow();
});
it('binds native edit result to the read digest, final digest and actual returned path',async()=>{
 const plan=make();plan.absolutePath='D:/owned/script.ps1';plan.edit!.sha256=await nativeFileContentSha256(plan.content);const file={path:'\\\\?\\D:\\owned\\script.ps1',beforeSha256:plan.edit!.sha256,afterSha256:await nativeFileContentSha256(plan.edit!.content)},data={applied:true,verified:true,fileScope:'scratch',temporary:true,files:[file]};await expect(verifyNativeFileEditResult(data,plan)).resolves.toBeUndefined();
 for(const change of [{path:'relative.ps1'},{beforeSha256:'b'.repeat(64)},{afterSha256:'c'.repeat(64)}])await expect(verifyNativeFileEditResult({...data,files:[{...file,...change}]},plan)).rejects.toThrow('digest');
});
it('checks the full ownership digest, initial target, short directory and pending/settled usage',async()=>{
 const id='agent-owned',session='session-owned',cwd="D:/parent's/父Shell",target={kind:'local',targetId:'terminal-'+session,sessionId:session,cwd},key=await nativeFileContentSha256(JSON.stringify([id,target])),record={version:1,key,sessionId:id,target,uses:{approval:{state:'pending',expiresAt:123}}},path=`D:/data/tmp/${key.slice(0,16)}/script.ps1`;
 await expect(verifyNativeFileOwner({records:[record]},id,session,cwd,path,'pending')).resolves.toBeUndefined();await expect(verifyNativeFileOwner({records:[{...record,uses:{}}]},id,session,cwd,path,'settled')).resolves.toBeUndefined();
 for(const change of [{key:'b'.repeat(64)},{sessionId:'other'},{target:{...target,cwd:'D:/other'}},{uses:{}}])await expect(verifyNativeFileOwner({records:[{...record,...change}]},id,session,cwd,path,'pending')).rejects.toThrow();await expect(verifyNativeFileOwner({records:[record]},id,session,cwd,path.replace(key.slice(0,16),'f'.repeat(16)),'pending')).rejects.toThrow('Short');await expect(verifyNativeFileOwner({records:[record]},id,session,cwd,path,'settled')).rejects.toThrow('retention');
});
