import assert from 'node:assert/strict';
import {isAbsolute,resolve} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
export function macRawAdmission(values,paths={evidence:process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR,data:process.env.SHELLSPAN_DATA_DIR,home:process.env.SHELLSPAN_LOCAL_HOME}) {
 const family=values['native-raw-admission'];if(family===undefined)return undefined;
 assert(process.platform==='darwin'&&process.arch==='arm64'&&['bash','zsh'].includes(family)
  &&values['data-scope']===(family==='zsh'?'com.shellspan.validation.native-input-p3':'com.shellspan.validation.native-input-p2')
  &&typeof paths.evidence==='string'&&isAbsolute(paths.evidence)&&paths.data===resolve(paths.evidence,'data')&&paths.home===resolve(paths.evidence,'home')
  &&Object.keys(values).every(k=>['native-raw-admission','data-scope'].includes(k)),
  '--native-raw-admission requires one isolated macOS arm64 real-model family with exact data/HOME and no mixed operation');
 return family;
}
export function attachMacRawAdmission(vite,token,directory) {
 const home=realpathSync(resolve(directory,'home')),effect=resolve(home,'raw-agent-effect');
 const present=()=>{try{lstatSync(effect);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
 assert(!present(),'Raw negative case must not reuse an effect path');
 vite.middlewares.use(`/__native-raw-admission/${token}`,(request,response)=>{
  try{if(request.method!=='GET'||request.url!=='/status'){response.writeHead(405).end();return;}
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify({home,effectPath:effect,effectPresent:present()}));
  }catch{response.writeHead(500).end('Owned read-only raw witness failed');}
 });
}
