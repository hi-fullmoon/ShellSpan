import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

/** Only releases an owned test program; never generates a native receipt. */
export async function createCaptureTailWitness({ownedRoot,evidence,token,library,librarySha256,eof=false}) {
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token));
  const owned=await realpath(ownedRoot),directory=await realpath(evidence),dll=await realpath(library);
  assert(directory.startsWith(owned+sep)&&dll.startsWith(owned+sep));
  assert.equal(createHash('sha256').update(await readFile(dll)).digest('hex'),librarySha256);
  const gate=resolve(directory,`release-capture-tail-${token}.txt`);
  return async(request,response)=>{
    try {
      if(request.method==='POST'&&request.url==='/release') {
        const retained=JSON.parse(await readFile(resolve(directory,'native-webview-evidence.json'),'utf8'));
        assert(retained.kind==='actual-native-capture-tail-unknown'&&retained.token===token&&retained.originalToolUnknown===true);
        assert(retained.capture?.nativeFenceRegistered&&retained.capture.captureOpen&&!retained.capture.nativeFenceComplete);
        await writeFile(gate,`release:${token}`,{flag:'wx'});
        response.end('released');return;
      }
      if(request.method!=='GET'||!['','/'].includes(request.url??'')){response.writeHead(405).end();return;}
      let armed=false;
      try {const approval=JSON.parse(await readFile(resolve(directory,`capture-tail-approval-${token}.json`),'utf8'));assert(approval.token===token&&approval.actualCoreVerified===true);armed=true;}
      catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({library:dll,librarySha256,gate,armed,eof}));
    } catch {response.writeHead(409).end('Owned capture-tail precondition failed');}
  };
}
