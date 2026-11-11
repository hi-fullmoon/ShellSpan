import {invokeGetAgentRuntimeArtifact} from '@/lib/ipc/tauri';
import type {AgentArtifactRequest,AgentArtifactResponse} from '@/types/agent-session';
export interface NativeResultArtifactEvidence {readonly artifactId:string;readonly sha256:string;readonly sizeBytes:number;readonly computedSha256:string;}
export interface NativeAcceptanceResult {readonly data:Record<string,unknown>;readonly artifact:NativeResultArtifactEvidence|null;}
type ArtifactReader=(request:AgentArtifactRequest)=>Promise<AgentArtifactResponse>;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Structured native tool result required');return value as Record<string,unknown>;}
export async function readNativeAcceptanceResult(sessionId:string,value:unknown,readArtifact:ArtifactReader=invokeGetAgentRuntimeArtifact):Promise<NativeAcceptanceResult>{
 const inline=object(value);if(typeof inline.artifactRef!=='string')return {data:inline,artifact:null};
 const response=await readArtifact({sessionId,artifactId:inline.artifactRef,maxBytes:16*1024*1024}),metadata=response.metadata;
 if(response.truncated||metadata.kind!=='tool-result'||metadata.artifactId!==inline.artifactRef||metadata.sha256!==inline.sha256||metadata.sizeBytes!==inline.sizeBytes)throw Error('Native tool-result artifact identity or completeness changed');
 const bytes=Uint8Array.from(atob(response.bodyBase64),char=>char.charCodeAt(0)),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 if(bytes.length!==metadata.sizeBytes||digest!==metadata.sha256)throw Error('Native tool-result artifact bytes changed');
 const data=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown);
 return {data,artifact:{artifactId:metadata.artifactId,sha256:metadata.sha256,sizeBytes:metadata.sizeBytes,computedSha256:digest}};
}
