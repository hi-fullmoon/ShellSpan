import fs from 'node:fs';import p from 'node:path';import {randomUUID} from 'node:crypto';import {expect,it} from 'vitest';
import {runOwnedCaptureCommand} from '../native-input/acceptance/owned-capture-command.mjs';
const root=p.resolve(import.meta.dirname,'../../artifacts/tests/owned-capture-command');
function fixture(){const evidence=p.join(root,randomUUID());fs.mkdirSync(evidence,{recursive:true});return evidence;}
it('persists a real successful component child exit before returning its output',async()=>{
 const evidence=fixture(),result=await runOwnedCaptureCommand({program:process.execPath,args:['-e','process.stdout.write("COMPONENT_ONLY_METADATA")'],evidence,timeoutMs:15000});
 expect(result.stdout).toBe('COMPONENT_ONLY_METADATA');expect(JSON.parse(fs.readFileSync(result.recordPath))).toMatchObject({exitCode:0,signal:null,actualExitSeen:true,timeoutMs:15000});
});
it('preserves a real nonzero exit and diagnostic before propagating capture refusal',async()=>{
 const evidence=fixture();await expect(runOwnedCaptureCommand({program:process.execPath,args:['-e','process.stderr.write("COMPONENT_ONLY_REFUSAL");process.exitCode=7'],evidence,timeoutMs:15000})).rejects.toThrow('COMPONENT_ONLY_REFUSAL');
 const files=fs.readdirSync(evidence);expect(files).toHaveLength(1);expect(JSON.parse(fs.readFileSync(p.join(evidence,files[0])))).toMatchObject({exitCode:7,signal:null,actualExitSeen:true,stderr:'COMPONENT_ONLY_REFUSAL'});
});
it('does not invent an exit status when the capture executable cannot spawn',async()=>{
 const evidence=fixture();await expect(runOwnedCaptureCommand({program:p.join(evidence,'missing-capture.exe'),args:[],evidence,timeoutMs:15000})).rejects.toThrow();
 const record=JSON.parse(fs.readFileSync(p.join(evidence,fs.readdirSync(evidence)[0])));expect(record.exitCode).toBeNull();expect(record.actualExitSeen).toBe(false);expect(record.callbackCode).toBe('ENOENT');
});
