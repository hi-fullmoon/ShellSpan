// Authenticated SSH supplies the sensitive value only on stdin. This process
// forwards it to the owned Session1 initializer, never argv/env/files/logs.
import assert from 'node:assert/strict';
const [portValue,validationNonce,runId]=process.argv.slice(2);
const port=Number(portValue);assert(Number.isInteger(port)&&port>1024&&port<65536);
for(const value of[validationNonce,runId])assert(/^[a-f0-9-]{36}$/.test(value));
const chunks=[];let length=0,value;
try{
 for await(const bytes of process.stdin){length+=bytes.length;if(length>16384)throw new Error('CREDENTIAL_LIMIT');chunks.push(bytes);}
 value=Buffer.concat(chunks);assert(value.length>0);
 const endpoint=`http://127.0.0.1:${port}/__native-p3-credential/${validationNonce}`;
 const response=await fetch(`${endpoint}/receive`,{method:'POST',body:value,signal:AbortSignal.timeout(5000)});value.fill(0);if(!response.ok)throw new Error('OWNED_DELIVERY_FAILED');
 const deadline=Date.now()+30000;let receipt;
 while(!receipt){const status=await fetch(`${endpoint}/status`,{signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))});if(!status.ok)throw new Error('OWNED_STATUS_FAILED');const body=await status.json();if(body.stored){assert(body.runId===runId&&/^llm-[a-f0-9-]{36}$/.test(body.reference)&&body.service==='com.shellspan.dev.ai-provider'&&body.createdBy==='ai_save_routes');receipt={stored:true,runId,reference:body.reference,service:body.service,createdBy:body.createdBy,readbackMatches:body.readbackMatches===true};break;}if(Date.now()>=deadline)throw new Error('OWNED_STORE_NOT_CONFIRMED');await new Promise(resolve=>setTimeout(resolve,50));}
 process.stdout.write(JSON.stringify(receipt));
}catch{process.stderr.write('P3_CREDENTIAL_RELAY_FAILED\n');process.exitCode=1;}
finally{if(value)value.fill(0);for(const bytes of chunks)bytes.fill(0);}
