import { execFileSync, spawn,spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, closeSync,existsSync } from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {acquireNativeGui} from './gui-lock.mjs';
import {recordAcceptanceInputs} from './provenance.mjs';

const root=resolve(import.meta.dirname,'../..');
await acquireNativeGui();
const version=process.argv[2]??'5.3';
const prepared=spawnSync(process.execPath,[resolve(import.meta.dirname,'prepare-app.mjs'),version],{encoding:'utf8',cwd:root});
if(prepared.status!==0){process.stderr.write(prepared.stderr||'P2 preparation failed before native application startup\n');process.exit(78);}
const preparation=JSON.parse(prepared.stdout);
const {destination,selection}=preparation;
assert(selection?.routeId&&selection?.modelId,'A real default model selection is required');
const environment=JSON.parse(readFileSync(resolve(destination,'environment.json'),'utf8'));
const originalHome=process.env.HOME;
const fixturePath=process.argv[3]&&process.argv[3]!=='-'?resolve(process.argv[3]):undefined;
const scenario=process.argv[4]??'jobs';
recordAcceptanceInputs(root,destination,selection,version,scenario);
const historyScenario=scenario.startsWith('history-');
const variant=historyScenario?scenario.slice('history-'.length):'default';
assert(['default','custom','empty','unset','small'].includes(variant),'Unknown history profile');
const coordination=['contention','delegation','close'].includes(scenario);
assert(!coordination||!fixturePath,'Coordination acceptance owns local disposable PTYs');
const arguments_=[resolve(root,'scripts/verify-ai-session-stream.mjs'),...(coordination?[scenario==='delegation'?'--terminal-delegation':'--terminal-contention','--native-input-p2']:['--native-jobs','--native-input-p2']),
  '--data-scope','com.shellspan.validation.native-input-p2','--route',selection.routeId,'--model',selection.modelId];
if(fixturePath) arguments_.push('--native-input-p2-ssh-fixture',fixturePath);
if(historyScenario)arguments_.push('--native-input-p2-history');
if(variant==='small')arguments_.push('--native-input-p2-history-small');
if(scenario==='lifecycle')arguments_.push('--native-input-p2-lifecycle','--no-model');
if(scenario==='ssh-fault'){assert(fixturePath,'SSH fault requires the owned fixture');arguments_.push('--native-input-p2-ssh-fault');}
if(scenario==='interactive'){assert(!fixturePath,'Native interactive gate owns a local disposable PTY');arguments_.push('--native-input-p2-interactive');}
if(scenario==='interactive-fresh'){assert(!fixturePath,'Fresh credential gate owns a local disposable PTY');arguments_.push('--native-input-p2-interactive-fresh');}
if(scenario==='close')arguments_.push('--no-model');
writeFileSync(resolve(destination,'invocation.json'),JSON.stringify({arguments:arguments_,version,scope:'Actual model, Tauri initialization, production queues/runtime/lease/Broker and registry; independent data and HOME; no mock model or native receipts'},null,2));
const nativeEnvironment={...process.env,...environment,
  ...(scenario==='ssh-fault'?{SHELLSPAN_P2_FAULT_NONCE:randomUUID()}:{}),
  ...(scenario==='contention'?{SHELLSPAN_P2_CONTENTION_GATE:`native-p2-contention-${randomUUID()}`} : {}),
  ...(fixturePath?{SHELLSPAN_P2_CREDENTIAL_REFERENCE:`native-p2-secret-${randomUUID()}`} : {}),
  SHELLSPAN_P2_SSH_USER:{'4.1':'native41','4.4':'native44','5.3':'native53'}[version],
  SHELLSPAN_DEV_SIGNING_KEYCHAIN:resolve(originalHome,'Library/Keychains/login.keychain-db'),
  CARGO_HOME:process.env.CARGO_HOME??resolve(originalHome,'.cargo'),RUSTUP_HOME:process.env.RUSTUP_HOME??resolve(originalHome,'.rustup'),
  SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:destination};
let password=fixturePath?randomBytes(36).toString('base64url'):undefined;
let actualHistoryHome=environment.SHELLSPAN_LOCAL_HOME;
let actualHistoryShell=environment.SHELL;
const fixture=fixturePath?JSON.parse(readFileSync(fixturePath,'utf8')):undefined;
if(fixture){
  assert(/^shellspan-nip-p2-[a-f0-9-]{36}$/.test(fixture.container));
  const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspan.native-input-p2"}}',fixture.container],{encoding:'utf8'}).trim();
  assert(fixture.container===`shellspan-nip-p2-${label}`);
  execFileSync('docker',['exec','-i',fixture.container,'chpasswd'],{input:['native41','native44','native53','nativeRaw'].map(user=>`${user}:${password}\n`).join(''),stdio:['pipe','ignore','pipe']});
}
if(historyScenario){
  const settings={default:'',custom:'HISTFILE="$HOME/custom-history"\nreadonly HISTFILE\nHISTCONTROL=ignoredups\nHISTIGNORE=SKIP_HISTORY_*\n',empty:'HISTFILE=\nHISTCONTROL=ignoredups\nHISTIGNORE=SKIP_HISTORY_*\n',unset:'unset HISTFILE\nHISTCONTROL=erasedups\nHISTIGNORE=SKIP_HISTORY_*\n',small:'HISTSIZE=2\n'}[variant];
  const profile=`printf 'profile\\n' >> "$HOME/profile-count"\nif shopt -q login_shell; then printf 'login\\n' >> "$HOME/login-state"; else printf 'nonlogin\\n' >> "$HOME/login-state"; fi\nprintf '%s' "$0" > "$HOME/argv0"\nsource "$HOME/.bashrc"\n${settings}`;
  const rc=`printf 'rc\\n' >> "$HOME/rc-count"\n${variant==='small'?`__native_p2_read_history() { printf '\\nHISTORY_AFTER_CONTROL_BEGIN\\n'; builtin history; printf 'HISTORY_AFTER_CONTROL_END\\n'; }\nbind -x '"\\C-xh":__native_p2_read_history'\n`:''}`;
  const profilePath=resolve(destination,'profile.bash');writeFileSync(profilePath,profile,{mode:0o600});
  if(fixturePath){
    const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
    assert(/^shellspan-nip-p2-[a-f0-9-]{36}$/.test(fixture.container));
    const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspan.native-input-p2"}}',fixture.container],{encoding:'utf8'}).trim();
    assert(fixture.container===`shellspan-nip-p2-${label}`);
    const user=`${nativeEnvironment.SHELLSPAN_P2_SSH_USER}-${randomUUID().replaceAll('-','').slice(0,8)}`;
    const profileId=`gnu-bash-${version}-readline-${{'4.1':'6.0','4.4':'7.0','5.3':'8.3.6'}[version]}-linux-aarch64-glibc-2.36-native`;
    const producer=JSON.parse(readFileSync(resolve(root,`.artifacts/tests/native-input-p2/producers/${profileId}/manifest.json`),'utf8'));
    const target=fixture.shells?.[version];
    if(target){
      const catalogue=JSON.parse(readFileSync(resolve(root,'.artifacts/tests/native-input-p2/resources/native-input/catalogue-linux-aarch64-glibc-2.36.json'),'utf8'));
      const artifact=catalogue.profiles.find(profile=>profile.id===profileId);assert(artifact);
      assert.equal(target.path,`/opt/shellspan-native-gnu/${profileId}/bash`);
      assert.equal(target.user,nativeEnvironment.SHELLSPAN_P2_SSH_USER);assert.equal(target.sha256,artifact.shellSha256);
      assert.equal(execFileSync('docker',['exec',fixture.container,'sha256sum',target.path],{encoding:'utf8'}),`${artifact.shellSha256}  ${target.path}\n`);
    }
    const shell=target?.path??producer.shell;actualHistoryShell=shell;
    execFileSync('docker',['exec',fixture.container,'useradd','-m','-s',shell,user]);
    execFileSync('docker',['exec','-i',fixture.container,'chpasswd'],{input:`${user}:${password}\n`,stdio:['pipe','ignore','pipe']});
    actualHistoryHome=`/home/${user}`;
    execFileSync('docker',['cp',profilePath,`${fixture.container}:${actualHistoryHome}/.bash_profile`]);
    execFileSync('docker',['exec',fixture.container,'chown',`${user}:${user}`,`${actualHistoryHome}/.bash_profile`]);
    const rcPath=resolve(destination,'rc.bash');writeFileSync(rcPath,rc,{mode:0o600});
    execFileSync('docker',['cp',rcPath,`${fixture.container}:${actualHistoryHome}/.bashrc`]);
    execFileSync('docker',['exec',fixture.container,'chown',`${user}:${user}`,`${actualHistoryHome}/.bashrc`]);
    nativeEnvironment.SHELLSPAN_P2_SSH_USER=user;
  }else{writeFileSync(resolve(actualHistoryHome,'.bash_profile'),profile,{mode:0o600});writeFileSync(resolve(actualHistoryHome,'.bashrc'),rc,{mode:0o600});}
  nativeEnvironment.SHELLSPAN_P2_HISTORY_AUDIT=resolve(destination,'history-audit-config.json');
  writeFileSync(nativeEnvironment.SHELLSPAN_P2_HISTORY_AUDIT,JSON.stringify({directory:destination,fixturePath,home:actualHistoryHome,file:variant==='custom'?`${actualHistoryHome}/custom-history`:`${actualHistoryHome}/.bash_history`,absent:['empty','unset'].includes(variant)}),{mode:0o600});
}
let currentChild;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>currentChild?.kill(signal));
async function run(arguments_,name,provision){
  const log=openSync(resolve(destination,`${name}.log`),'wx',0o600);
  const child=spawn(process.execPath,arguments_,{cwd:root,env:nativeEnvironment,stdio:[provision?'pipe':'ignore',log,log]});
  if(provision)child.stdin.end(JSON.stringify(provision));
  currentChild=child;
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?128:1)));});
  closeSync(log);
  writeFileSync(resolve(destination,`${name}-result.json`),JSON.stringify({exitCode:code,completedAt:new Date().toISOString()},null,2));
  return code;
}
const initializationArguments=[resolve(root,'scripts/verify-ai-session-stream.mjs'),'--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p2'];
try{
const initialization=await run([...initializationArguments,...(fixture?['--native-input-p2-credential','provision']:[])],'initialize',fixture?{reference:nativeEnvironment.SHELLSPAN_P2_CREDENTIAL_REFERENCE,password}:undefined);
password=undefined;
assert.equal(initialization,0,`Actual app initialization failed; ${destination}`);
const database=new DatabaseSync(resolve(destination,'data/shellspan-main.db'));
assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,1);
database.prepare('INSERT INTO preferences(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('llm.routes.v1',readFileSync(resolve(destination,'model-routes.json'),'utf8'));
database.close();
const code=await run(arguments_,'native');
if(code===0&&scenario==='ssh-fault'){
  const bytes=execFileSync('docker',['exec',fixture.container,'cat',`/home/${nativeEnvironment.SHELLSPAN_P2_SSH_USER}/native-p2-once-${nativeEnvironment.SHELLSPAN_P2_FAULT_NONCE}`]);
  assert.equal(bytes.toString(),'ONCE\n','The actual may-submitted SSH source ran more than once');
  writeFileSync(resolve(destination,'effect-once.bin'),bytes,{mode:0o600});
}
if(code===0&&!['lifecycle','ssh-fault','interactive','interactive-fresh'].includes(scenario)&&!coordination){
  if(historyScenario){
    const evidence=JSON.parse(readFileSync(resolve(destination,'native-webview-evidence.json'),'utf8'));
    assert(!evidence.failed&&(variant==='small'||typeof evidence.output==='string'));
    let expected=variant==='custom'?`${actualHistoryHome}/custom-history`:`${actualHistoryHome}/.bash_history`;
    const state=`HISTFILE_STATE:${variant==='unset'?':':`x:${variant==='empty'?'':expected}`}`;
    if(variant!=='small')assert(evidence.output.includes(`${state}\r\n`)||evidence.output.includes(`${state}\n`),'Original history file setting changed');
    if(['custom','empty','unset'].includes(variant))assert(evidence.output.includes(`HISTORY_CONFIG:${variant==='unset'?'erasedups':'ignoredups'}:SKIP_HISTORY_*`),'Original HISTCONTROL/HISTIGNORE changed');
    const count=fixture?execFileSync('docker',['exec',fixture.container,'cat',`${actualHistoryHome}/profile-count`],{encoding:'utf8'}):readFileSync(resolve(actualHistoryHome,'profile-count'),'utf8');
    assert.equal(count,'profile\n','The real login profile was sourced more than once');
    const rcCount=fixture?execFileSync('docker',['exec',fixture.container,'cat',`${actualHistoryHome}/rc-count`],{encoding:'utf8'}):readFileSync(resolve(actualHistoryHome,'rc-count'),'utf8');
    assert.equal(rcCount,'rc\n','The real user rc was sourced more than once');
    {
      const login=fixture?execFileSync('docker',['exec',fixture.container,'cat',`${actualHistoryHome}/login-state`],{encoding:'utf8'}):readFileSync(resolve(actualHistoryHome,'login-state'),'utf8');
      assert.equal(login,'login\n','The actual user profile did not run in a login shell');
      const argv0=fixture?execFileSync('docker',['exec',fixture.container,'cat',`${actualHistoryHome}/argv0`],{encoding:'utf8'}):readFileSync(resolve(actualHistoryHome,'argv0'),'utf8');
      assert.equal(argv0,actualHistoryShell,'Native startup changed the real executable argv0');
      if(fixture){
        const system=execFileSync('docker',['exec',fixture.container,'cat',`${actualHistoryHome}/system-profile-audit`],{encoding:'utf8'});
        assert.equal(system,`system-login:${actualHistoryHome}\n`,'System profile saw a substituted HOME or ran more than once');
      }
    }
    if(variant==='small'){
      assert(typeof evidence.afterHistory==='string'&&/^\s*\d+\*?\s+KEEP_USER_A\r?$/m.test(evidence.afterHistory)
        &&/^\s*\d+\*?\s+KEEP_USER_B\r?$/m.test(evidence.afterHistory),'Private controls changed the actual in-memory entries at HISTSIZE=2');
      const present=fixture?execFileSync('docker',['exec',fixture.container,'sh','-c','if test -e "$1"; then printf yes; else printf no; fi','history-audit',`${actualHistoryHome}/.bash_history`],{encoding:'utf8'})==='yes':existsSync(resolve(actualHistoryHome,'.bash_history'));
      // Stock pinned GNU 4.4 also omits this file after history -s/-a at size2.
      // history-baseline.py retains real no-adapter PTY evidence per version;
      // require its semantics and the independent post-control memory listing.
      assert.equal(present,version!=='4.4','Native exit changed the pinned Bash history-file behavior');
      const bytes=present?(fixture?execFileSync('docker',['exec',fixture.container,'cat',`${actualHistoryHome}/.bash_history`]):readFileSync(resolve(actualHistoryHome,'.bash_history'))):undefined;
      if(bytes){assert.equal(bytes.toString(),'KEEP_USER_A\nKEEP_USER_B\n','Private controls changed original history-file entries');writeFileSync(resolve(destination,'actual-small-history.bin'),bytes,{mode:0o600});}
      writeFileSync(resolve(destination,'small-history-file.json'),JSON.stringify({present,baseline:'stock-pinned-Bash-without-adapter',version}),{mode:0o600});
    }
    if(['empty','unset'].includes(variant)){
      const exists=fixture?execFileSync('docker',['exec',fixture.container,'sh','-c','test ! -e "$1/.bash_history"','history-audit',actualHistoryHome],{stdio:'pipe'}):!existsSync(resolve(actualHistoryHome,'.bash_history'));
      assert(exists!==false,'A history file was created despite the user setting');
    }
    writeFileSync(resolve(destination,'history-verification.json'),JSON.stringify({variant,historyFile:expected,historyFileScope:'actual-user-home',actualHistoryShell,nonzeroStatusPreserved:true,originalEntriesPreserved:true,profileLoads:1,privateControlsAbsent:true}));
  }else{
  let history;
  if(fixturePath){
    const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
    history=execFileSync('docker',['exec',fixture.container,'cat',`/home/${nativeEnvironment.SHELLSPAN_P2_SSH_USER}/.bash_history`],{encoding:'utf8'});
  }else{history=readFileSync(resolve(environment.SHELLSPAN_LOCAL_HOME,'.bash_history'),'utf8');}
  assert(history.includes('SHELLSPAN_ACCEPTANCE')&&history.includes('(exit 7)'),'Actual native history was not retained');
  assert(!history.includes('__shellspan_native_history_cleanup')&&!history.includes('ss_native_input_control_end')&&!history.includes('__shellspan_job_control'),'Private management was persisted in user history');
  writeFileSync(resolve(destination,'history-verification.json'),JSON.stringify({retainedVisibleCommands:true,privateControlsAbsent:true,bytes:Buffer.byteLength(history)}));
  }
}
writeFileSync(resolve(destination,'result.json'),JSON.stringify({exitCode:code,completedAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({destination,exitCode:code}));
process.exitCode=code;
}finally{
  password=undefined;
  if(fixture){
    // Lock only this owned fixture's accounts. No credential is written to disk,
    // argv, environment, evidence or source; the real keychain owns the secret.
    for(const user of new Set(['native41','native44','native53','nativeRaw',nativeEnvironment.SHELLSPAN_P2_SSH_USER]))execFileSync('docker',['exec',fixture.container,'usermod','-L',user],{stdio:'ignore'});
    const cleanup=await run([...initializationArguments,'--native-input-p2-credential','cleanup'],'credential-cleanup',{reference:nativeEnvironment.SHELLSPAN_P2_CREDENTIAL_REFERENCE});
    assert.equal(cleanup,0,`Owned keychain cleanup failed; ${destination}`);
  }
}
