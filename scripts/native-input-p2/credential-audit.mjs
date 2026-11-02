import assert from 'node:assert/strict';
import {readdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const root=resolve(import.meta.dirname,'../../.artifacts/tests/native-input-p2');
const pending=[];let databases=0;
for(const group of readdirSync(root).filter(name=>/^app-(4\.1|4\.4|5\.3)$/.test(name))){
  for(const run of readdirSync(resolve(root,group))){
    const directory=resolve(root,group,run);const path=resolve(directory,'data/shellspan-main.db');
    if(!existsSync(path))continue;
    const db=new DatabaseSync(path,{readOnly:true});databases++;
    try{
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='key_credentials'").get())continue;
      for(const row of db.prepare("SELECT id FROM key_credentials WHERE id GLOB 'native-p2-secret-*'").all()){
        assert(/^native-p2-secret-[a-f0-9-]{36}$/.test(row.id));pending.push({directory,reference:row.id});
      }
    }finally{db.close();}
  }
}
const report={databases,pendingOwnedCredentialMetadata:pending};
writeFileSync(resolve(root,'credential-audit.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report));
assert.equal(pending.length,0,'Owned credential references still need native cleanup');
