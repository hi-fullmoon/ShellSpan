import {nativeByteBoundaryJson} from './native-byte-boundary-plan';
import {matchesNativeFileChainStep,nativeFileChainPathIdentity,type NativeFileChainPlan} from './native-file-chain-approval';

export const nativeFileEditExplanation='Verify the owned scratch edit and native path chain.';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export async function nativeFileContentSha256(content:string):Promise<string>{
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content))),value=>value.toString(16).padStart(2,'0')).join('');
}
export function nativeFileEditPlan(base:NativeFileChainPlan,token:string):NativeFileChainPlan{
 assert(/^[a-f0-9-]{36}$/.test(token)&&!base.edit,'Owned fresh edit plan required');
 const oldString=`BEFORE_EDIT_${token}`,newString=`AFTER_EDIT_${token}`,content=`$NativeFileRevision='${oldString}'; if($NativeFileRevision -cne '${newString}'){throw 'required file edit missing'}; ${base.content}`;
 return {...base,content,edit:{oldString,newString,content:content.replace(oldString,newString)}};
}
export async function verifyNativeFileEditRead(data:Record<string,unknown>,content:string,path:string):Promise<string>{
 const bytes=new TextEncoder().encode(content).length,sha256=await nativeFileContentSha256(content);
 assert(data.path===path&&data.content===content&&data.fileScope==='scratch'&&data.temporary===true&&data.encoding==='utf8'&&data.offset===0&&data.truncated===false&&data.readBytes===bytes&&data.byteLength===bytes&&data.nextOffset===bytes&&data.sha256===sha256,'Actual edit-chain read/path/UTF-8/digest differs');
 return sha256;
}
export async function verifyNativeFileEditResult(data:Record<string,unknown>,plan:NativeFileChainPlan):Promise<void>{
 assert(plan.edit&&plan.absolutePath&&Array.isArray(data.files)&&data.files.length===1&&data.applied===true&&data.verified===true&&data.fileScope==='scratch'&&data.temporary===true,'Actual edit result is not a verified scratch mutation');
 const file=data.files[0] as Record<string,unknown>;
 const actual=typeof file.path==='string'?nativeFileChainPathIdentity(file.path):null,expected=nativeFileChainPathIdentity(plan.absolutePath);
 assert(actual&&expected&&actual.toLowerCase()===expected.toLowerCase()&&file.beforeSha256===plan.edit.sha256&&file.afterSha256===await nativeFileContentSha256(plan.edit.content),'Actual edit path/before/after digest differs');
}
export function recordNativeFileEditDigest(plan:NativeFileChainPlan,step:1|3,data:Record<string,unknown>):void{
 assert(plan.edit&&plan.absolutePath&&data.fileScope==='scratch'&&data.temporary===true,'Actual owned edit-chain result required');
 let digest:unknown;
 if(step===1){assert(data.written===true&&data.verified===true&&data.path===plan.absolutePath,'Actual completed scratch write required');digest=data.afterSha256;}
 else{assert(data.applied===true&&data.verified===true&&Array.isArray(data.files)&&data.files.length===1,'Actual completed scratch edit required');const file=data.files[0] as Record<string,unknown>,actual=typeof file.path==='string'?nativeFileChainPathIdentity(file.path):null,expected=nativeFileChainPathIdentity(plan.absolutePath);assert(actual&&expected&&actual.toLowerCase()===expected.toLowerCase()&&file.beforeSha256===plan.edit.sha256,'Actual edit result path/before digest differs');digest=file.afterSha256;}
 assert(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest),'Actual tool-result file digest missing');plan.currentFileSha256=digest;
}
export async function verifyNativeFileOwnershipIdentity(state:Record<string,unknown>,id:string,sessionId:string,cwd:string,path:string):Promise<Record<string,unknown>>{
 assert(Array.isArray(state.records)&&state.records.length===1,'Exact owned scratch record required');const record=state.records[0] as Record<string,unknown>,target=record.target as Record<string,unknown>;
 assert((record.version===1||record.version===2)&&record.sessionId===id&&typeof record.key==='string'&&/^[a-f0-9]{64}$/.test(record.key)&&target?.kind==='local'&&target.targetId===`terminal-${sessionId}`&&target.sessionId===sessionId&&target.cwd===cwd,'Scratch owner/initial target differs');
 assert(await nativeFileContentSha256(JSON.stringify([id,target]))===record.key,'Full scratch ownership digest differs');
 assert(nativeFileChainPathIdentity(path)?.endsWith('/'+record.key.slice(0,16)+'/'+path.split(/[\\/]/).pop()),'Short directory differs from complete ownership digest');
 assert(record.uses&&typeof record.uses==='object'&&!Array.isArray(record.uses),'Scratch usage records missing');
 return record;
}
export async function verifyNativeFileOwner(state:Record<string,unknown>,id:string,sessionId:string,cwd:string,path:string,usage:'pending'|'settled'):Promise<void>{
 const record=await verifyNativeFileOwnershipIdentity(state,id,sessionId,cwd,path),uses=Object.values(record.uses as Record<string,unknown>);assert(usage==='settled'?uses.length===0:uses.some(value=>value&&typeof value==='object'&&'state'in value&&value.state==='pending'),'Scratch approval/use retention differs');
}
export function matchesNativeFileEditOriginal(step:number,name:string,value:unknown,plan:NativeFileChainPlan):boolean{
 if(!plan.edit||!matchesNativeFileChainStep(step,name,value,plan))return false;const args=value as Record<string,unknown>;
 return step===0||step===5?args.background===false&&args.explanation===nativeFileEditExplanation:step===2||step===4?args.path===plan.fileName&&args.offset===0&&args.maxBytes===8192:step===3?args.path===plan.fileName:true;
}
export function nativeFileEditGoal(plan:NativeFileChainPlan):string{
 assert(plan.edit,'Six-call edit plan required');
 return `Perform exactly SIX tool calls, one at a time after the prior result, once each. The selected surface is boundTerminal; do not add lifecycleTrust, change the declared base options, use Direct, retry or repair source. Preserve every source byte and use the ordinary single argument JSON parse.\n1. run_terminal_command with {"command":${nativeByteBoundaryJson(plan.setup)},"background":false,"timeoutMs":5000,"explanation":${JSON.stringify(nativeFileEditExplanation)}}.\n2. write_file with {"fileScope":"scratch","path":${JSON.stringify(plan.fileName)},"content":${nativeByteBoundaryJson(plan.content)},"precondition":{"mustNotExist":true}}.\n3. read_file with {"fileScope":"scratch","path":${JSON.stringify(plan.fileName)},"encoding":"utf8","offset":0,"maxBytes":8192}. You may additionally supply expectedSha256 only as the exact afterSha256 returned by call2. Preserve all base arguments and never calculate or guess this digest.\n4. edit_file with fileScope="scratch", path=${JSON.stringify(plan.fileName)}, oldString=${JSON.stringify(plan.edit.oldString)}, newString=${JSON.stringify(plan.edit.newString)}, precondition={"sha256":the exact sha256 returned by call3}. Do not calculate or guess a digest.\n5. Repeat call3's base read_file arguments and verify the edited content. If expectedSha256 is supplied, use the exact afterSha256 returned by call4 for the edited file; never reuse the pre-edit digest.\n6. run_terminal_command with background=false,timeoutMs=5000,explanation=${JSON.stringify(nativeFileEditExplanation)} and source consisting ONLY of an ampersand, one ASCII space and the exact absolute path returned by call2 in single quotes. Double any embedded single quote; preserve every path character and do not change cwd. Execute that path, not the script text. Then stop.`;
}
