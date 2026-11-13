import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {acquireNativeGui} from './gui-lock.mjs';
import {packageFrontendDirectory} from '../native-input-p3/package-config.mjs';

const root=resolve(import.meta.dirname,'../..');
assert(process.platform==='darwin'&&process.arch==='arm64');
const shell=process.argv[2]??'bash';
assert(process.argv.length<=3&&['bash','zsh'].includes(shell),'Select packaged Bash or Zsh');
const directory=resolve(root,'.artifacts/tests/native-input-p2/release-smoke',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
const token=randomUUID();let settle;
const result=new Promise(resolve=>{settle=resolve;});
const server=createServer(async(request,response)=>{
  response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(request.method==='OPTIONS'){response.writeHead(204).end();return;}
  if(request.method!=='POST'||request.url!==`/${token}`){response.writeHead(404).end();return;}
  try{let body='';for await(const bytes of request){body+=bytes.toString();assert(body.length<1048576);}const value=JSON.parse(body);await writeFile(resolve(directory,'webview-evidence.json'),JSON.stringify(value,null,2));response.end('ok');settle(value);}catch{response.writeHead(400).end();settle({ok:false,error:'Invalid actual release evidence'});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const report=`http://127.0.0.1:${server.address().port}/${token}`;
let child;
async function run(command,args,environment=process.env){
  const log=openSync(resolve(directory,`build-${command.replaceAll('/','_')}-${randomUUID()}.log`),'wx',0o600);
  const process_=spawn(command,args,{cwd:root,env:environment,stdio:['ignore',log,log]});child=process_;
  const code=await new Promise((resolve,reject)=>{process_.once('error',reject);process_.once('exit',resolve);});closeSync(log);assert.equal(code,0,`Release build failed; ${directory}`);
}
let timeout;
let releaseGui;
try{
  await run(process.execPath,['scripts/prepare-native-input-resources.mjs','--acceptance','--no-build','--require-ssh']);
  const frontend=resolve(directory,'frontend');
  await build({configFile:false,root,base:'/',logLevel:'error',resolve:{alias:{'@':resolve(root,'src')}},plugins:[react(),tailwindcss()],define:{__NATIVE_P2_RELEASE_REPORT__:JSON.stringify(report)},build:{outDir:frontend,emptyOutDir:true,rolldownOptions:{input:resolve(root,'src/components/terminal/__tests__/native-input-p2-release.native.html')}}});
  const config={identifier:'com.shellspan.validation.native-input-p2-release',build:{beforeBuildCommand:'',frontendDist:packageFrontendDirectory(root,frontend)},app:{windows:[{label:'main',url:'src/components/terminal/__tests__/native-input-p2-release.native.html',width:1200,height:800}],security:{csp:`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${new URL(report).origin}; font-src 'self' data:`}},bundle:{createUpdaterArtifacts:false,macOS:{signingIdentity:'Apple Development'}}};
  await writeFile(resolve(directory,'tauri-config.json'),JSON.stringify(config,null,2));
  const target=resolve(root,'.artifacts/tests/native-input-p2/release-target');
  await run('pnpm',['exec','tauri','build','--bundles','app','--config',resolve(directory,'tauri-config.json')],{...process.env,CARGO_TARGET_DIR:target});
  const bundle=resolve(target,'release/bundle/macos/ShellSpan.app');
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'pipe'});
  const resource=resolve(bundle,'Contents/Resources/native-input/generated');
  const catalogue=JSON.parse(await readFile(resolve(resource,shell==='bash'?'catalogue-macos-arm64.json':'editors-macos-arm64.json'),'utf8'));
  const profileId=shell==='bash'?'gnu-bash-5.3-readline-8.3.6-macos-arm64-native':'zsh-5.9-zle-5.9-macos-arm64-native';
  const accepted=catalogue.profiles.find(value=>(value.id??value.profile?.verifiedProfileId)===profileId);assert(accepted);
  const executable=resolve(resource,shell==='bash'?`${profileId}/bash`:accepted.shell);
  const data=resolve(directory,'data');const home=resolve(directory,'home');await mkdir(data);await mkdir(home);
  // Select the actual packaged executable. The release loader must locate
  // its adapter from resource_dir(), with no debug .artifacts/tests/native-input-p2 fallback.
  releaseGui=await acquireNativeGui();
  child=spawn(resolve(bundle,'Contents/MacOS/ShellSpan'),[],{cwd:directory,env:{...process.env,SHELLSPAN_DATA_DIR:data,SHELLSPAN_LOCAL_HOME:home,SHELL:executable,SHELLSPAN_TERMINAL_BROKER:'1',SHELLSPAN_TERMINAL_SHELL_INTEGRATION:'1',SHELLSPAN_TERMINAL_EXECUTE:'1'},stdio:'ignore'});
  child.once('exit',code=>settle({ok:false,error:`Packaged app exited before evidence (${code})`}));
  timeout=setTimeout(()=>settle({ok:false,error:'Packaged resource smoke timeout'}),60000);
  const outcome=await result;assert.equal(outcome.ok,true,outcome.error);
  assert.equal(outcome.broker.session.nativePeerProfile.verifiedProfileId,profileId);
  await writeFile(resolve(directory,'result.json'),JSON.stringify({ok:true,bundle,releaseResourceRoot:resource,profileId,executable,debugFallback:false,completedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({directory,bundle,ok:true}));
}finally{clearTimeout(timeout);if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}releaseGui?.();await new Promise(resolve=>server.close(resolve));}
