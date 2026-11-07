import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

export const zleAppHistoryModes=['default','small','custom','empty','unset','incremental','shared'];
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const json=path=>JSON.parse(readFileSync(path,'utf8'));
export function prepareZleAppHistory(root,directory,mode){
 assert(zleAppHistoryModes.includes(mode));
 assert(directory.startsWith(resolve(root,'.artifacts/tests/')+'/'));
 const home=resolve(directory,'home'),history=resolve(home,mode==='custom'?'历史 custom/history.txt':'history');
 assert(!existsSync(resolve(home,'.zshrc')),'Never replace an existing user profile');
 mkdirSync(resolve(history,'..'),{recursive:true,mode:0o700});
 const seedSources=['builtin print -r -- APP_HISTORY_SEED_1','builtin print -r -- APP_HISTORY_SEED_2'];
 writeFileSync(history,seedSources.join('\n')+'\n',{flag:'wx',mode:0o600});
 const observations=resolve(home,'history-observations');
 for(let index=0;index<16;index++)mkdirSync(resolve(observations,String(index)),{recursive:true,mode:0o700});
 const settings={default:'',small:'HISTSIZE=3\nSAVEHIST=3\n',custom:`HISTFILE=${quote(history)}\nreadonly HISTFILE\n`,empty:"HISTFILE=''\n",unset:'unset HISTFILE\n',incremental:'setopt inc_append_history\n',shared:'setopt share_history\n'}[mode];
 const observer=resolve(root,'scripts/native-input-p3/zle-history-observer.zsh');
 writeFileSync(resolve(home,'.zshrc'),`builtin print -r -- rc >> "$HOME/rc-count"\nPROMPT='APP-HISTORY> '\nHISTFILE=$HOME/history\nHISTSIZE=100\nSAVEHIST=100\nsetopt interactivecomments\n${settings}zmodload zsh/parameter\nsource ${quote(observer)}\nsource ${quote(resolve(root,'scripts/native-input-p3/zle-app-history-observer.zsh'))}\n`,{flag:'wx',mode:0o600});
 const plan={mode,home,history,observer,seedSources,persistent:!['empty','unset'].includes(mode),maximum:mode==='small'?3:100};
 writeFileSync(resolve(directory,'zle-history-plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
 return plan;
}
export function readZleHistoryObservation(directory){
 const info=lstatSync(directory);assert(info.isDirectory()&&!info.isSymbolicLink());
 if(!existsSync(resolve(directory,'ready')))return {ready:false};
 const names=readdirSync(directory);assert(names.length<1024);
 const content=name=>{const path=resolve(directory,name),info=lstatSync(path);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=131072);return readFileSync(path,'utf8');};
 assert.equal(content('ready'),'complete');
 const entries=names.filter(name=>/^entry-[0-9]+$/.test(name)).sort((a,b)=>Number(a.slice(6))-Number(b.slice(6))).map(name=>content(name));
 const configuration=Object.fromEntries(['histsize','savehist','histfile-set','histfile','option-appendhistory','option-incappendhistory','option-sharehistory','option-extendedhistory','option-rcs','option-banghist'].map(name=>[name,content(name)]));
 const editor=existsSync(resolve(directory,'editor-buffer'))?{buffer:content('editor-buffer'),cursor:content('editor-cursor')}:undefined;
 return {ready:true,entries,configuration,...(editor?{editor}:{})};
}
export function readZleAppHistoryDisk(directory,shell){
 const plan=json(resolve(directory,'zle-history-plan.json')),destination=resolve(directory,'history-disk');
 assert.equal(plan.home,resolve(directory,'home'));assert(plan.history.startsWith(plan.home+'/'));
 mkdirSync(destination,{mode:0o700});
 execFileSync(shell,['-f','-c','HISTSIZE=1000; zmodload zsh/parameter; source "$1"; fc -R "$2" || exit; print -s -- OWNED_READER_CURRENT_EVENT; p3_history_export "$3"','owned-app-history-reader',plan.observer,plan.history,destination],{env:{...process.env,HOME:plan.home,ZDOTDIR:plan.home,LC_ALL:'en_US.UTF-8'},stdio:'pipe',timeout:10000});
 const actual=readZleHistoryObservation(destination);assert(actual.ready);
 writeFileSync(resolve(directory,'history-disk.json'),JSON.stringify(actual,null,2),{flag:'wx',mode:0o600});
 return actual;
}
export function attachZleAppHistory(vite,token,directory){
 const plan=json(resolve(directory,'zle-history-plan.json'));assert.equal(plan.home,resolve(directory,'home'));
 vite.middlewares.use(`/__native-zle-history/${token}`,async(request,response)=>{
  if(request.method!=='GET'){response.writeHead(405).end();return;}
  try{
   let value;
   if(request.url==='/profile')value=plan;
   else if(request.url==='/effect')value={exists:existsSync(resolve(plan.home,'history-cancel-effect'))};
   else if(request.url==='/current'){
    const parent=resolve(plan.home,'history-observations'),names=readdirSync(parent);assert(names.length<=512);
    const completed=names.filter(name=>/^[0-9]+$/.test(name)&&existsSync(resolve(parent,name,'ready'))).sort((a,b)=>Number(b)-Number(a));
    value=completed.length?{...readZleHistoryObservation(resolve(parent,completed[0])),index:Number(completed[0])}:{ready:false};
   }
   else{assert(/^\/(?:[0-9]|1[0-5])$/.test(request.url));value=readZleHistoryObservation(resolve(plan.home,'history-observations',request.url.slice(1)));}
   response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));
  }catch(error){response.writeHead(409).end(String(error));}
 });
}
