import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import draft7 from 'ajv/dist/refs/json-schema-draft-07.json' with {type:'json'};
import {nativeByteBoundarySource} from '../../src/components/terminal/__tests__/native-byte-boundary-plan.ts';
import fixtureProvider from '../../src/lib/ai/__tests__/native-boundary-no-inference-provider.json' with {type:'json'};

const repository=resolve(import.meta.dirname,'../..');
const digest=value=>createHash('sha256').update(value).digest('hex');
export const nativeBoundaryFixtureModel=fixtureProvider.model;

export function createNativeBoundaryFixture(token,bytes){
 assert(/^[a-f0-9-]{36}$/.test(token)&&(bytes===8192||bytes===8193),'Owned original byte-boundary fixture required');
 const source=nativeByteBoundarySource(token,bytes),argumentsValue={command:source,background:false,timeoutMs:15000,explanation:'Verify the exact native source byte boundary.'};
 const routeId='native-no-inference-'+token,basePath='/__native-no-inference/'+token;
 Object.freeze(argumentsValue);const requests=[],failures=[];let proposals=0,received=0;
 const receipt=()=>({kind:'deterministic-protocol-fixture-no-inference',token,sourceUtf8Bytes:Buffer.byteLength(source),sourceSha256:digest(source),protocolRequests:received,acceptedProtocolRequests:requests.length,toolProposals:proposals,realModelInferenceCalls:0,nativeFramesManufactured:false,requests:structuredClone(requests),failures:[...failures]});
 const middleware=(request,response)=>{received++;void(async()=>{
  let stage='loopback-peer';
  try{
   assert(received<=4&&['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress));
   assert.equal(request.headers.host,'127.0.0.1:'+request.socket.localPort);
   stage='fixture-endpoint';assert(request.method==='POST'&&request.url==='/api/chat');
   stage='no-credentials';assert(request.headers.authorization===undefined&&request.headers['x-api-key']===undefined);
   stage='bounded-json-body';const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;assert(size<=2*1024*1024);chunks.push(chunk);}
   const payload=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
   stage='fixture-model-and-owned-goal';assert(payload.model===nativeBoundaryFixtureModel&&payload.stream===true&&Array.isArray(payload.messages));
   assert(payload.messages.some(value=>typeof value.content==='string'&&value.content.includes('boundary-'+token+'.txt')));
   const hasResult=payload.messages.some(value=>value.role==='tool');let message;
   if(hasResult){stage='prior-proposal-required';assert(proposals===1);message={role:'assistant',content:'Deterministic fixture completed.'};}
   else{stage='single-original-proposal';assert(proposals===0);assert(Array.isArray(payload.tools)&&payload.tools.some(value=>value.function?.name==='run_terminal_command'));proposals++;message={role:'assistant',content:'',tool_calls:[{id:'fixture-call-'+token,function:{name:'run_terminal_command',arguments:argumentsValue}}]};}
   requests.push({at:new Date().toISOString(),bodyBytes:size,bodySha256:digest(Buffer.concat(chunks)),phase:hasResult?'after-tool-result':'original-proposal',authorizationReceived:false});
   response.writeHead(200,{'Content-Type':'application/x-ndjson'});response.end(JSON.stringify({model:nativeBoundaryFixtureModel,message,done:true,done_reason:'stop',prompt_eval_count:0,eval_count:0})+'\n');
  }catch{if(failures.length<16)failures.push(stage);if(!response.headersSent)response.writeHead(400,{'Content-Type':'application/json'});if(!response.destroyed)response.end(JSON.stringify({error:'Deterministic no-inference fixture request rejected',stage}));}
 })();};
 const routeDocument=origin=>{
  const url=new URL(origin);assert(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'Only the owned loopback listener is allowed');
  const model=structuredClone(fixtureProvider.modelDefinition);
  return{schemaVersion:1,revision:1,defaultSelection:{routeId,modelId:nativeBoundaryFixtureModel},routes:[{id:routeId,revision:1,displayName:'Owned deterministic fixture; no inference',adapterId:'ollama',baseUrl:url.origin+basePath,auth:{kind:'none'},replayDomainId:routeId,presetId:'ollama',models:{[nativeBoundaryFixtureModel]:model},retryPolicy:{maxAttempts:3,initialDelayMs:250,maxDelayMs:4000,maxServerDelayMs:30000,jitterRatio:0.2},timeouts:{requestHeadersMs:30000,firstByteMs:30000,streamIdleMs:300000}}]};
 };
 return Object.freeze({source,argumentsValue,routeId,modelId:nativeBoundaryFixtureModel,basePath,middleware,routeDocument,receipt});
}

export function installNativeBoundaryFixtureRoute(evidence,fixture,origin){
 const base=resolve(repository,'artifacts/tests/native-input-p2'),child=relative(base,resolve(evidence));assert(isAbsolute(evidence)&&child&&child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child),'A separate owned acceptance directory is required');
 const data=resolve(evidence,'data');for(const folder of [evidence,data]){const info=lstatSync(folder);assert(info.isDirectory()&&!info.isSymbolicLink());assert.equal(resolve(realpathSync.native(folder)),resolve(folder));}
 const database=join(data,'shellspan-main.db'),info=lstatSync(database);assert(info.isFile()&&!info.isSymbolicLink());assert.equal(resolve(realpathSync.native(database)),resolve(database));
 const document=fixture.routeDocument(origin),validator=new Ajv2020({allErrors:true,strict:true});validator.addMetaSchema(draft7);validator.addSchema(JSON.parse(readFileSync(resolve(repository,'protocol/llm/catalog.schema.json'),'utf8')));const validate=validator.compile(JSON.parse(readFileSync(resolve(repository,'protocol/llm/routes.schema.json'),'utf8')));assert(validate(document),'Deterministic fixture route must satisfy the complete route schema');
 const db=new DatabaseSync(database);try{
  db.exec('BEGIN');assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().map(row=>row.version),[1]);
  const preferences=db.prepare('SELECT key,value FROM preferences').all();assert(preferences.length===1&&preferences[0].key==='llm.routes.v1','Only a normally initialized empty route store may be used');
  const before=JSON.parse(preferences[0].value);assert(Array.isArray(before.routes)&&before.routes.length===0&&!before.defaultSelection,'Existing user or test routes must never be replaced');
  for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){if(['schema_version','preferences'].includes(row.name))continue;assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name));assert.equal(db.prepare('SELECT count(*) AS total FROM "'+row.name+'"').get().total,0,'Fixture route requires empty application state');}
  assert.equal(db.prepare('UPDATE preferences SET value=? WHERE key=? AND value=?').run(JSON.stringify(document),'llm.routes.v1',preferences[0].value).changes,1);db.exec('COMMIT');
 }finally{db.close();}
 return{kind:'owned-no-inference-route',database,routeId:fixture.routeId,modelId:fixture.modelId,baseUrl:document.routes[0].baseUrl,authKind:'none',userModelConfigurationChanged:false,realModelInferenceCalls:0};
}
