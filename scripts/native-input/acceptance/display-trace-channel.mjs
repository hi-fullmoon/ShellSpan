import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';

const automaticMacSelections=new Set(['zsh','bash','full-zsh','full-bash','editing-zsh','editing-bash','pump-zsh','pump-bash','toast-zsh','toast-bash']);
const pasteEvent={type:'object',required:['type','action','outputSequence','parsedThrough'],properties:{
 type:{const:'action'},outputSequence:{type:'integer',minimum:-1},parsedThrough:{type:'integer',minimum:-1},
 action:{type:'object',required:['kind','data'],additionalProperties:false,properties:{kind:{const:'paste'},data:{type:'string',maxLength:900000}}}
}};
const validatePasteTrace=new Ajv({strict:true}).compile({type:'object',required:['version','streamKind','offsetUnit','events','issues','replayable','inputOrLifecycleAuthority','originalWireBytesClaimed'],properties:{
 version:{const:5},streamKind:{const:'actual-visible-output'},offsetUnit:{const:'UTF16-code-units'},
 issues:{type:'array',maxItems:0},replayable:{const:true},inputOrLifecycleAuthority:{const:false},originalWireBytesClaimed:{const:false},
 events:{type:'array',maxItems:40000,contains:pasteEvent,items:{type:'object',required:['type'],properties:{type:{enum:['output','resize','action','checkpoint']}},
  allOf:[{if:{required:['action'],properties:{action:{type:'object',required:['kind'],properties:{kind:{const:'paste'}}}}},then:pasteEvent}]}}
}});

const ordinal={type:'integer',minimum:-1},stateProperties={stateJson:{type:'string',maxLength:4000000},stateCharacters:{type:'integer',minimum:0}};
const boundaryProperties={outputSequence:ordinal,parsedThrough:ordinal};
const coordinate={type:'integer',minimum:0};
const parsedActions={oneOf:[
 {type:'object',additionalProperties:false,required:['kind'],properties:{kind:{const:'transportClosed'}}},
 {type:'object',additionalProperties:false,required:['kind','column','row','length'],properties:{kind:{const:'select'},column:coordinate,row:coordinate,length:coordinate}},
 {type:'object',additionalProperties:false,required:['kind','row'],properties:{kind:{const:'scrollToLine'},row:coordinate}},
]};
const validateParsedTrace=new Ajv({strict:true}).compile({type:'object',required:['version','streamKind','offsetUnit','initial','events','outputCharacters','outputEvents','issues','replayable','inputOrLifecycleAuthority','originalWireBytesClaimed'],properties:{
 version:{const:6},streamKind:{const:'actual-visible-output'},offsetUnit:{const:'UTF16-code-units'},initial:{type:'object',required:['empty'],properties:{empty:{const:true}}},
 outputCharacters:{type:'integer',minimum:0,maximum:900000},outputEvents:{type:'integer',minimum:0},issues:{type:'array',maxItems:0},replayable:{const:true},inputOrLifecycleAuthority:{const:false},originalWireBytesClaimed:{const:false},
 events:{type:'array',maxItems:40000,items:{oneOf:[
  {type:'object',additionalProperties:false,required:['type','sequence','offset','characters','source'],properties:{type:{const:'output'},sequence:{type:'integer',minimum:0},offset:{type:'integer',minimum:0},characters:{type:'integer',minimum:1},source:{enum:['session','local']}}},
  {type:'object',additionalProperties:false,required:['type','sequence','outputSequence','parsedThrough'],properties:{type:{const:'parsed'},sequence:{type:'integer',minimum:0},...boundaryProperties}},
  {type:'object',additionalProperties:false,required:['type','columns','rows','outputSequence','parsedThrough','stateJson','stateCharacters'],properties:{type:{const:'resize'},columns:{type:'integer',minimum:1},rows:{type:'integer',minimum:1},...boundaryProperties,...stateProperties}},
  {type:'object',additionalProperties:false,required:['type','label','outputSequence','parsedThrough','stateJson','stateCharacters','stateSha256'],properties:{type:{const:'checkpoint'},label:{type:'string',minLength:1},stateSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},...boundaryProperties,...stateProperties}},
  {type:'object',additionalProperties:false,required:['type','action','outputSequence','parsedThrough'],properties:{type:{const:'action'},action:parsedActions,...boundaryProperties}}
 ]}}
}});

/** Actual callback ordering plus every original public resize state. Legacy
 * queued traces lack these observations and cannot be upgraded after capture. */
export function admitParsedDisplayTrace(value,selection){
 const viewport=['human-viewport-zsh','human-viewport-bash'].includes(selection);
 assert(viewport||['eof-private-zsh','eof-private-bash'].includes(selection),'Parsed display trace requires an exact private-EOF or human-viewport selection');
 assert(validateParsedTrace(value),'Invalid parsed display observation: '+JSON.stringify(validateParsedTrace.errors));
 let accepted=-1,parsed=-1,characters=0;
 for(const event of value.events){
  if(event.type==='output'){assert.equal(event.sequence,++accepted);assert.equal(event.offset,characters);characters+=event.characters;continue;}
  assert.equal(event.outputSequence,accepted);
  if(event.type==='parsed'){assert.equal(event.sequence,parsed+1);assert(event.sequence<=accepted);parsed=event.sequence;assert.equal(event.parsedThrough,parsed);continue;}
  assert.equal(event.parsedThrough,parsed);
  if(event.type==='resize'||event.type==='checkpoint'){
   assert.equal(event.stateCharacters,event.stateJson.length);const state=JSON.parse(event.stateJson);
   if(event.type==='resize'){assert.equal(state.columns,event.columns);assert.equal(state.rows,event.rows);}
   else{assert.equal(parsed,accepted,'Checkpoint lacks the original public drain');assert.equal(createHash('sha256').update(event.stateJson).digest('hex'),event.stateSha256);}
  }else{
   assert(viewport||event.action.kind==='transportClosed','Private-EOF trace admits only the transport close action');
   assert.equal(parsed,accepted,'Rendering lifecycle action lacks actual parse completion');
  }
 }
 assert.equal(parsed,accepted,'Actual parsed output callbacks are missing');assert.equal(characters,value.outputCharacters);assert.equal(accepted+1,value.outputEvents);return true;
}

function admitPasteTrace(value,selection){
 assert(automaticMacSelections.has(selection),'Paste trace requires an exact automatic Mac daily selection');
 assert(validatePasteTrace(value),'Invalid public-paste display observation: '+JSON.stringify(validatePasteTrace.errors));
 const pastes=value.events.filter(event=>event.type==='action'&&event.action?.kind==='paste');
 assert(pastes.length<=32,'Public-paste observation bound exceeded');
 for(const event of pastes)assert(event.outputSequence===event.parsedThrough,'Public paste preceded its captured output drain');
 return true;
}

/** Exact original POST bytes, once per owned token. No input/Agent authority.
 * Legacy display callers retain versions 2/3 and their existing checks. */
export function attachDisplayTraceChannel(server,token,directory,{nativeDaily}={}){
 let written=false;
 server.middlewares.use(`/__native-display-trace/${token}`,async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}
  try{
   assert(directory&&!written,'Only one owned display trace is admitted');written=true;
   const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;assert(length<=8*1024*1024,'Owned display trace exceeds bound');chunks.push(chunk);}
   const data=Buffer.concat(chunks),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
   assert(([2,3].includes(value.version)||value.version===5&&admitPasteTrace(value,nativeDaily)||value.version===6&&admitParsedDisplayTrace(value,nativeDaily))&&value.streamKind==='actual-visible-output'&&Array.isArray(value.events)&&value.events.length<=40000,'Invalid owned display trace');
   const file=resolve(directory,'native-display-trace.json');await writeFile(file,data,{flag:'wx',mode:0o600});
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({file,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),scope:'Observed decoded display order and checkpoints only;no wire,input or lifecycle authority'}));
  }catch(error){response.writeHead(500).end(String(error));}
 });
}
