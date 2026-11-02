import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'../..');
const sourceSnapshot=resolve(root,'.native-input-p2/source-snapshot.json');
if(existsSync(sourceSnapshot))assert(JSON.parse(readFileSync(sourceSnapshot,'utf8')).sharedDriftReviewed===true,'Review the isolated P2 source snapshot before native acceptance');
const version=process.argv[2]??'5.3';
assert(['4.1','4.4','5.3'].includes(version));
const readline={'4.1':'6.0','4.4':'7.0','5.3':'8.3.6'}[version];
const producer=JSON.parse(readFileSync(resolve(root,`.native-input-p2/producers/gnu-bash-${version}-readline-${readline}-macos-arm64-nip1-init1-capture1/manifest.json`),'utf8'));
const destination=resolve(root,`.native-input-p2/app-${version}`,new Date().toISOString().replaceAll(':','-'));
for(const name of ['home','data'])mkdirSync(resolve(destination,name),{recursive:true,mode:0o700});
const originalHome=process.env.HOME;
const sourcePath=['.shellspan-dev','.shellspan'].map(name=>resolve(originalHome,name,'shellspan-main.db')).find(existsSync);
assert(sourcePath,'A real configured model route with a credential reference is required');
const source=new DatabaseSync(sourcePath,{readOnly:true});
const row=source.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get();
assert(row,'No real model routes are configured');
const routes=JSON.parse(row.value);
const routeSource={kind:'current-native-preferences',path:sourcePath,key:'llm.routes.v1',valueSha256:createHash('sha256').update(row.value).digest('hex')};
assert(routes.schemaVersion===1&&Array.isArray(routes.routes)&&routes.routes.length);
for(const route of routes.routes){
  assert(route.auth?.kind==='none'||route.auth?.kind==='keychain'&&typeof route.auth.reference==='string');
  assert(Object.keys(route.auth).every(key=>['kind','reference'].includes(key)),'Only credential references may be copied');
  assert(!new URL(route.baseUrl).username&&!new URL(route.baseUrl).password,'Route URL contains inline credentials');
}
source.close();
if(process.env.SHELLSPAN_P2_MODEL){
  const routeId=process.env.SHELLSPAN_P2_ROUTE??routes.defaultSelection?.routeId;
  const route=routes.routes.find(value=>value.id===routeId);
  assert(route?.models?.[process.env.SHELLSPAN_P2_MODEL],'Acceptance override must be an already configured real model');
  // Only this disposable database's default changes. The original route store
  // and credentials remain read-only and the normal provider adapter is used.
  routes.defaultSelection={routeId,modelId:process.env.SHELLSPAN_P2_MODEL};
  if(process.env.SHELLSPAN_P2_REASONING){
    assert(route.models[process.env.SHELLSPAN_P2_MODEL].reasoning?.some(option=>option.id===process.env.SHELLSPAN_P2_REASONING),'Acceptance reasoning override must be an existing supported option');
    routes.defaultSelection.reasoningEffort=process.env.SHELLSPAN_P2_REASONING;
  }
}
writeFileSync(resolve(destination,'model-routes.json'),JSON.stringify(routes),{mode:0o600});
writeFileSync(resolve(destination,'route-source.json'),JSON.stringify(routeSource,null,2),{mode:0o600});
// No user terminal workspace, history, profiles, passwords or key bytes are
// copied. The normal isolated application resolves the existing keychain refs.
const environment={SHELLSPAN_DATA_DIR:resolve(destination,'data'),SHELL:producer.shell,SHELLSPAN_LOCAL_HOME:resolve(destination,'home'),
  SHELLSPAN_TERMINAL_BROKER_V1:'1',SHELLSPAN_TERMINAL_SHELL_INTEGRATION_V1:'1',SHELLSPAN_TERMINAL_EXECUTE_V1:'1',SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS_V1:'1'};
writeFileSync(resolve(destination,'environment.json'),JSON.stringify(environment,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({destination,routes:routes.routes.length,selection:routes.defaultSelection??null}));
