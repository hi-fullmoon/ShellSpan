import assert from 'node:assert/strict';
import {readFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

// Recovery for an interrupted validation process. Reads only the disposable
// database's credential metadata, then deletes those exact keys through Tauri.
const root=resolve(import.meta.dirname,'../..');
const directory=resolve(process.argv[2]);
assert(directory.startsWith(resolve(root,'artifacts/tests/native-input-p2/app-') ));
const environment=JSON.parse(readFileSync(resolve(directory,'environment.json'),'utf8'));
assert.equal(resolve(environment.SHELLSPAN_DATA_DIR),resolve(directory,'data'));
const db=new DatabaseSync(resolve(directory,'data/shellspan-main.db'),{readOnly:true});
const references=db.prepare("SELECT id FROM key_credentials WHERE id GLOB 'native-p2-secret-*'").all().map(row=>row.id);db.close();
for(const reference of references){
  assert(/^native-p2-secret-[0-9a-f-]{36}$/.test(reference));
  const log=openSync(resolve(directory,`credential-recovery-${reference}.log`),'wx',0o600);
  const child=spawn(process.execPath,[resolve(root,'scripts/verify-ai-session-stream.mjs'),'--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p2','--native-input-p2-credential','cleanup'],{
    cwd:root,env:{...process.env,...environment,SHELLSPAN_DEV_SIGNING_KEYCHAIN:resolve(process.env.HOME,'Library/Keychains/login.keychain-db')},stdio:['pipe',log,log]});
  child.stdin.end(JSON.stringify({reference}));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});closeSync(log);
  assert.equal(code,0,'Owned credential recovery failed; inspect the disposable run log');
}
console.log(JSON.stringify({directory,removedOwnedReferences:references.length}));
