import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { resolve, isAbsolute,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, readFile, stat, readdir, open } from 'node:fs/promises';
import {existsSync,constants} from 'node:fs';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { build, createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {captureValidationSources,captureValidationAssets,verifyFrozenValidation,writeFrozenCheckpoint,attachSingleUseValidationPage} from '../../native-input/integration/frozen-validation.mjs';
import {attachCredentialChannel} from '../../native-input/acceptance/credential-channel.mjs';
import {attachFocusTraceChannel} from '../../native-input/acceptance/focus-trace-channel.mjs';
import {assertNativeGuiAllowed} from '../../native-input/integration/gui-lock.mjs';

// Requires a native desktop and Rust/Tauri. The default regression creates one
// idle session without provider calls. --performance also reads stored journals
// and creates temporary PTYs; model calls occur unless --no-model is supplied.
const repository = resolve(import.meta.dirname, '../../..');
const { values } = parseArgs({ options: {
  performance: { type: 'boolean' }, baseline: { type: 'boolean' },
  focus: { type: 'boolean' },
  'focus-background': { type: 'boolean' },
  'native-jobs': { type: 'boolean' },
  'native-jobs-ssh': { type: 'string' },
  'native-jobs-direct': { type: 'boolean' },
  'native-jobs-focus': { type: 'boolean' },
  'native-jobs-powershell': { type: 'string' },
  'native-jobs-narrow': { type: 'boolean' },
  'native-input-p2': { type: 'boolean' },
  'native-input-p3': { type: 'string' },
  'native-input-p3-credential': { type: 'string' },
  'native-input-p3-startup': { type: 'string' },
  'native-input-p3-startup-diagnostic': { type: 'boolean' },
  'native-input-p3-require-jobs': { type: 'boolean' },
  'native-input-p3-review': { type: 'boolean' },
  'native-input-p3-publisher-run-once': { type: 'boolean' },
  'native-input-p3-backpressure': { type: 'boolean' },
  'native-input-p3-cancel': { type: 'boolean' },
  'native-input-p3-submit-fault': { type: 'boolean' },
  'native-input-p2-history': { type: 'boolean' },
  'native-input-p2-history-small': { type: 'boolean' },
  'native-input-p2-lifecycle': { type: 'boolean' },
  'native-input-p2-ssh-fault': { type: 'boolean' },
  'native-input-p2-interactive': { type: 'boolean' },
  'native-input-p2-interactive-fresh': { type: 'boolean' },
  'native-input-p2-credential': { type: 'string' },
  'native-input-p2-ssh-fixture': { type: 'string' },
  'data-initialize': { type: 'boolean' },
  'data-scope': { type: 'string' },
  'terminal-contention': { type: 'boolean' },
  'terminal-delegation': { type: 'boolean' },
  'question-submission-recovery': { type: 'boolean' },
  'composer-input-diagnostic': { type: 'boolean' },
  'native-binary': { type: 'string' },
  'terminal-readiness': { type: 'boolean' },
  'terminal-clear-screen': { type: 'boolean' },
  'terminal-reconnect': { type: 'boolean' },
  'terminal-reconnect-surface': { type: 'boolean' },
  'terminal-reconnect-ssh': { type: 'boolean' },
  'terminal-reconnect-focus': { type: 'boolean' },
  'no-model': { type: 'boolean' }, route: { type: 'string' }, model: { type: 'string' },
  'cleanup-session': { type: 'string', multiple: true },
  'baseline-ref': { type: 'string' },
} });
assertNativeGuiAllowed();
const performanceRun = values.performance === true;
const focusRun = values.focus === true;
const focusBackgroundRun = values['focus-background'] === true;
const questionSubmissionRun = values['question-submission-recovery'] === true;
const terminalContentionRun = values['terminal-contention'] === true || values['terminal-delegation'] === true || questionSubmissionRun;
assert(!questionSubmissionRun || (!values['no-model'] && !values['terminal-contention'] && !values['terminal-delegation']
  && !values['composer-input-diagnostic'] && !values['cleanup-session']?.length), '--question-submission-recovery is a separate real-model regression');
assert(!values['terminal-delegation'] || !values['no-model'], '--terminal-delegation requires real model calls');
assert(!values['terminal-delegation'] || (!values['terminal-contention'] && !values['composer-input-diagnostic']
  && !values['cleanup-session']?.length), '--terminal-delegation is a separate regression');
const p3Startup=values['native-input-p3-startup'];
assert(!values['native-input-p3-startup-diagnostic']||p3Startup&&p3Startup!=='zsh');
assert(!p3Startup||values['no-model']&&values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance'&&!values['native-jobs']&&!values['data-initialize']);
assert(!values['native-input-p3-review']||p3Startup||values['native-input-p3-submit-fault']);
const nativeP3=values['native-input-p3']??p3Startup;
assert(!values['native-input-p3-cancel']||nativeP3==='zsh'&&!values['no-model']);
assert(!values['native-input-p3-submit-fault']||values['native-input-p3-cancel']&&nativeP3==='zsh');
assert(!values['native-input-p3-backpressure']||nativeP3&&values['native-jobs']&&!values['no-model']);
assert(!values['native-input-p3-publisher-run-once']||process.platform==='win32'&&nativeP3==='windowsPowerShell'&&values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance');
const p3CredentialMode=values['native-input-p3-credential'];
assert(!p3CredentialMode||['source','destination','verify-absence'].includes(p3CredentialMode));
assert(!nativeP3||['zsh','windowsPowerShell','powerShell7'].includes(nativeP3),'P3 requires an exact shell/editor family');
const stableNativeEntry = terminalContentionRun || Boolean(values['native-jobs-powershell']) || values['data-initialize'] === true || values['native-input-p2'] === true || Boolean(nativeP3);
assert(!values['native-binary'] || terminalContentionRun, '--native-binary requires --terminal-contention and a binary built for the fixed verification entry');
assert(!terminalContentionRun || (!focusBackgroundRun && !focusRun && !performanceRun && !values['terminal-readiness']), '--terminal-contention is a separate regression');
assert(!focusBackgroundRun || (!focusRun && !values.performance && !values['terminal-readiness']), '--focus-background is a separate regression');
const terminalReadinessRun = values['terminal-readiness'] === true;
const terminalClearScreenRun = values['terminal-clear-screen'] === true;
const terminalReconnectRun = values['terminal-reconnect'] === true || values['terminal-reconnect-surface'] === true || values['terminal-reconnect-ssh'] === true
  || values['terminal-reconnect-focus'] === true;
assert(!terminalReconnectRun || (!terminalClearScreenRun && !terminalReadinessRun && !terminalContentionRun && !focusBackgroundRun && !focusRun && !performanceRun), '--terminal-reconnect is a separate regression');
assert(!terminalClearScreenRun || (!terminalReadinessRun && !terminalContentionRun && !focusBackgroundRun && !focusRun && !performanceRun), '--terminal-clear-screen is a separate regression');
assert(!terminalReadinessRun || (!focusRun && !performanceRun), '--terminal-readiness is a separate regression');
assert(!focusRun || !performanceRun, '--focus and --performance are separate regressions');
const baseline = values.baseline === true;
const noModel = values['no-model'] === true;
assert(!values['composer-input-diagnostic'] || terminalContentionRun && noModel,
  '--composer-input-diagnostic requires --terminal-contention --no-model');
const initializationRun=values['data-initialize']===true;
const credentialMode=values['native-input-p2-credential'];
assert(!credentialMode||initializationRun&&['provision','cleanup'].includes(credentialMode), 'Owned credential mode requires isolated native initialization');
let credentialProvision;
let p3CredentialConfiguration;
if(p3CredentialMode){
  assert(values['data-initialize']&&values['no-model']&&values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance');
  if(p3CredentialMode==='source'){
    assert(process.platform==='darwin');const chunks=[];let length=0;for await(const part of process.stdin){length+=part.length;assert(length<=4096);chunks.push(part);}
    p3CredentialConfiguration=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }else if(p3CredentialMode==='destination'){
    assert(process.platform==='win32');const {DatabaseSync}=await import('node:sqlite');
    assert(isAbsolute(process.env.SHELLSPAN_P3_ROUTE_SOURCE));const database=new DatabaseSync(process.env.SHELLSPAN_P3_ROUTE_SOURCE,{readOnly:true});
    try{p3CredentialConfiguration={routeDocument:JSON.parse(database.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get().value)};}finally{database.close();}
  }else{
    assert(process.platform==='win32');const ownership=JSON.parse(await readFile(process.env.SHELLSPAN_P3_CREDENTIAL_OWNERSHIP,'utf8'));
    assert(ownership.runId===process.env.SHELLSPAN_ACCEPTANCE_RUN_ID&&ownership.createdBy==='ai_save_routes'&&ownership.service==='com.shellspan.dev.ai-provider');
    p3CredentialConfiguration={expectedReference:ownership.reference};
  }
}
if(credentialMode){
  let bytes=0;const chunks=[];
  for await(const chunk of process.stdin){bytes+=chunk.length;assert(bytes<=4096,'Credential provisioning input exceeds bound');chunks.push(chunk);}
  credentialProvision=JSON.parse(Buffer.concat(chunks).toString('utf8'));chunks.forEach(chunk=>chunk.fill(0));
  assert(/^native-p2-secret-[0-9a-f-]{36}$/.test(credentialProvision.reference));
  assert(credentialMode==='cleanup'||typeof credentialProvision.password==='string'&&credentialProvision.password.length>=32);
}
assert(!initializationRun || noModel && values['data-scope'] && process.env.SHELLSPAN_DATA_DIR && isAbsolute(process.env.SHELLSPAN_DATA_DIR)
  && !values['native-jobs'] && !terminalContentionRun && !terminalReconnectRun && !performanceRun && !focusRun && !focusBackgroundRun && !terminalReadinessRun && !terminalClearScreenRun,
  '--data-initialize requires an independent explicit data directory, identifier and --no-model');
const windowsShell = values['native-jobs-powershell'];
assert(!windowsShell || process.platform === 'win32' && values['native-jobs'] && ['windowsPowerShell', 'powerShell7'].includes(windowsShell), '--native-jobs-powershell requires native Windows and an exact PowerShell kind');
if (windowsShell) {
  assert(process.env.SHELLSPAN_DATA_DIR && isAbsolute(process.env.SHELLSPAN_DATA_DIR)
    && values['data-scope'], 'Windows desktop acceptance requires explicit independent data directory and app identifier');
  assert(process.env.SHELLSPAN_LOCAL_SHELL, 'Windows desktop acceptance requires an explicit shell executable');
} else if (values['native-jobs']) {
  assert(process.platform !== 'win32', '--native-jobs layout acceptance currently supports POSIX editors; use the dedicated Windows gate');
  execFileSync('python3', ['-c', 'import pexpect, ptyprocess; assert pexpect.__version__ == "4.9.0" and ptyprocess.__version__ == "0.7.0", "Use scripts/native-input/acceptance/requirements-native-layout.txt"'], { stdio: 'pipe' });
}
assert(!values['native-jobs-ssh'] || values['native-jobs'] && ['bash', 'zsh'].includes(values['native-jobs-ssh']), '--native-jobs-ssh requires --native-jobs and bash or zsh');
assert(!values['native-jobs-direct'] || values['native-jobs'] && !values['native-jobs-ssh'], '--native-jobs-direct requires local --native-jobs');
assert(!values['native-jobs-focus'] || values['native-jobs'], '--native-jobs-focus requires --native-jobs');
assert(!values['native-jobs-narrow'] || values['native-jobs'], '--native-jobs-narrow requires --native-jobs');
assert(!values['data-scope'] || /^com\.shellspan\.validation\.[a-z0-9-]+$/.test(values['data-scope']), '--data-scope must be a dedicated com.shellspan.validation.* identifier');
assert(!values['data-scope'] || process.env.SHELLSPAN_DATA_DIR && isAbsolute(process.env.SHELLSPAN_DATA_DIR), '--data-scope requires an explicit absolute SHELLSPAN_DATA_DIR; the app identifier does not isolate stored data');
assert(!values['data-scope'] || !values['native-binary'], '--data-scope requires a native build with that Tauri identifier');
assert(!values['native-jobs'] || ((!noModel||values['native-input-p2-lifecycle']) && !focusRun && !focusBackgroundRun && !performanceRun && !terminalContentionRun && !terminalReadinessRun && !terminalClearScreenRun && !terminalReconnectRun), '--native-jobs is a separate real-model regression');
assert(!focusBackgroundRun || !noModel, '--focus-background requires real model calls');
assert(Boolean(values.route) === Boolean(values.model), '--route and --model must be supplied together');
assert(!values['baseline-ref'] || baseline, '--baseline-ref requires --baseline');
const baselineRef = values['baseline-ref'] ?? 'HEAD';
const baselineCommit = baseline ? execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baselineRef}^{commit}`],
  { cwd: repository, encoding: 'utf8' }).trim() : undefined;
const baselineSources = baseline ? new Map([
  'src/lib/ai/agent-session-adapter.ts',
  'src/components/ai/workspace/use-ai-session-controller.ts',
].map(path => [resolve(repository, path), execFileSync('git', ['show', `${baselineCommit}:${path}`], { cwd: repository, encoding: 'utf8' })])) : new Map();
const token = randomUUID();
const windowsOutputMarker = windowsShell ? `native-jobs-${randomUUID()}` : undefined;
const windowsCompletionGate = windowsShell ? resolve(tmpdir(), `shellspan-completion-gate-${token}`) : undefined;
let nativeEnvironment = windowsShell ? { ...process.env, SHELLSPAN_ACCEPTANCE: windowsOutputMarker,
  SHELLSPAN_NATIVE_COMPLETION_GATE: windowsCompletionGate, SHELLSPAN_NATIVE_WORKSPACE:repository } : process.env;
const ownedEvidenceDirectory = process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR;
const p3BackpressureGate=values['native-input-p3-backpressure']?resolve(ownedEvidenceDirectory,`native-output-gate-${token}`):undefined;
if(p3BackpressureGate)nativeEnvironment={...nativeEnvironment,SHELLSPAN_P3_BACKPRESSURE_GATE:p3BackpressureGate};
assert(!ownedEvidenceDirectory || isAbsolute(ownedEvidenceDirectory)
  && process.env.SHELLSPAN_DATA_DIR && resolve(ownedEvidenceDirectory, 'data') === resolve(process.env.SHELLSPAN_DATA_DIR),
  'Owned evidence directory must be the explicit independent data directory parent');
const nativeEvidencePath = values['native-jobs'] || terminalContentionRun || p3Startup
  ? ownedEvidenceDirectory ? resolve(ownedEvidenceDirectory, 'native-webview-evidence.json')
    : resolve(tmpdir(), `shellspan-${terminalContentionRun ? 'terminal-contention' : 'native-jobs'}-${token}.json`) : undefined;
// Keep the compiled macOS application identity stable between contention runs.
// The per-run token belongs in an HTTP redirect, not in Tauri's compiled config.
const contentionEntryPath = '/__native-agent-entry';
const contentionPort = 1432;
let contentionEntryUrl;
let settle;
const result = new Promise((resolveResult) => { settle = resolveResult; });
const page = performanceRun ? 'agent-panel-performance.native.html' : 'agent-session-stream.native.html';
const pagePath = values['native-input-p3-cancel'] ? 'src/components/terminal/__tests__/native-input-p3-cancel.native.html'
  : p3Startup ? 'src/components/terminal/__tests__/native-input-p3-startup.native.html'
  : initializationRun ? 'src/components/terminal/__tests__/native-data-initialize.native.html'
  : values['native-input-p2-interactive-fresh'] ? 'src/components/terminal/__tests__/native-input-p2-interactive-fresh.native.html'
  : values['native-input-p2-interactive'] ? 'src/components/terminal/__tests__/native-input-p2-interactive.native.html'
  : values['native-input-p2-ssh-fault'] ? 'src/components/terminal/__tests__/native-input-p2-ssh-fault.native.html'
  : values['native-input-p2-lifecycle'] ? 'src/components/terminal/__tests__/native-input-p2-lifecycle.native.html'
  : values['native-input-p2-history'] ? 'src/components/terminal/__tests__/native-input-p2-history.native.html'
  : values['native-jobs'] ? 'src/components/terminal/__tests__/native-jobs.native.html'
  : terminalContentionRun ? 'src/components/terminal/__tests__/terminal-contention.native.html'
  : terminalReconnectRun ? 'src/components/terminal/__tests__/terminal-reconnect.native.html'
  : terminalClearScreenRun ? 'src/components/terminal/__tests__/terminal-clear-screen.native.html'
  : focusBackgroundRun ? 'src/components/terminal/__tests__/focus-background.native.html'
  : terminalReadinessRun ? 'src/components/terminal/__tests__/terminal-readiness.native.html'
  : focusRun ? 'src/components/focus/__tests__/focus.native.html' : `src/lib/ai/__tests__/${page}`;
const frozenNativeRun=Boolean(ownedEvidenceDirectory&&(
  values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/integration'&&(values['native-input-p2']||initializationRun)
  || values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance'&&(nativeP3||initializationRun)));
assert(!frozenNativeRun||process.platform==='darwin'&&process.arch==='arm64'||process.platform==='win32'&&process.arch==='x64'&&values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance','Frozen native verification requires an explicitly supported actual host');
const frozenWindows=frozenNativeRun&&process.platform==='win32';
let frozenInterrupted;
if(frozenNativeRun)for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>{frozenInterrupted=signal;settle({ok:false,error:`Isolated frozen validation interrupted (${signal})`});});
const frozenManifestPath=frozenNativeRun?resolve(ownedEvidenceDirectory,`frozen-manifest-${token}.json`):undefined;
const frozenSources=frozenNativeRun?captureValidationSources(repository):undefined;
const nativeResourcesDirectory=frozenNativeRun&&values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance'?resolve(repository,'artifacts/tests/native-input/integration/resources/native-input'):undefined;
const nativeResources=nativeResourcesDirectory?captureValidationAssets(nativeResourcesDirectory):undefined;
if(frozenNativeRun)writeFrozenCheckpoint(resolve(ownedEvidenceDirectory,`frozen-${token}-before-frontend-build.json`),{sources:frozenSources,entry:pagePath,hmr:false,tauriWatch:false});
const output = frozenNativeRun?resolve(ownedEvidenceDirectory,`frontend-${token}`):performanceRun ? await mkdtemp(resolve(tmpdir(), 'shellspan-agent-performance-')) : undefined;
const baselinePlugin = {
  name: 'agent-panel-performance-baseline',
  enforce: 'pre',
  load(id) { return baselineSources.get(id.split('?')[0]); },
};
async function windowsValidationImage(){
  if(!frozenWindows)return resolve(repository,'src-tauri/target/debug/ShellSpan.exe');
  const matches=[];
  for(const name of await readdir(ownedEvidenceDirectory)){
    if(!/^native-image-\d+(?:-[a-f0-9-]{36})?-process\.json$/.test(name))continue;
    const record=JSON.parse(await readFile(resolve(ownedEvidenceDirectory,name),'utf8'));
    if(record.frozenManifest===frozenManifestPath)matches.push(record);
  }
  assert.equal(matches.length,1,'The native desktop action must target this exact frozen application');
  assert(matches[0].executable.startsWith(ownedEvidenceDirectory+sep));return matches[0].executable;
}
const attachResult = (vite) => {
  if(values['native-input-p3-submit-fault']){
    // Configure the static preview after its frontend build. Tailwind must not
    // encounter this intentionally blocking runtime FIFO during source scans.
    assert(output&&ownedEvidenceDirectory&&process.env.SHELLSPAN_LOCAL_HOME===resolve(ownedEvidenceDirectory,'home'));
    const gate=resolve(process.env.SHELLSPAN_LOCAL_HOME,'p3-stop-gate');
    assert(!existsSync(gate),'Each submit-fault acceptance owns a fresh FIFO');
    execFileSync('/usr/bin/mkfifo',['-m','600',gate],{stdio:'pipe'});
  }
  if(values['native-input-p3-cancel'])vite.middlewares.use(`/__native-p3-cancel-effect/${token}`,(request,response)=>{
    void(async()=>{assert(request.method==='GET'&&ownedEvidenceDirectory&&process.env.SHELLSPAN_LOCAL_HOME===resolve(ownedEvidenceDirectory,'home'));let exists=true;try{await stat(resolve(process.env.SHELLSPAN_LOCAL_HOME,`p3-cancel-${token}`));}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}response.setHeader('Content-Type','application/json');response.end(JSON.stringify({exists}));})().catch(()=>response.writeHead(500).end('Owned effect observation failed'));
  });
  if(values['native-input-p3-submit-fault']){
   let released=false;
   vite.middlewares.use(`/__native-p3-submit-fault/${token}`,(request,response)=>{
    void(async()=>{
     assert(ownedEvidenceDirectory&&process.env.SHELLSPAN_LOCAL_HOME===resolve(ownedEvidenceDirectory,'home'));
     const home=process.env.SHELLSPAN_LOCAL_HOME;
     if(request.method==='POST'){
      assert(!released);const fifo=await open(resolve(home,'p3-stop-gate'),constants.O_WRONLY|constants.O_NONBLOCK);try{await fifo.writeFile('continue\n');released=true;}finally{await fifo.close();}
     }else assert(request.method==='GET');
     const maybe=async name=>{try{return await readFile(resolve(home,name),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
     const gateSource=await maybe('p3-stop-source'),text=await maybe('p3-stop-process.json'),entries=await maybe('p3-stop-entries');
     let actualProcess,metadataIncomplete=false;
     if(text!==null){try{actualProcess=JSON.parse(text);}catch(error){if(error instanceof SyntaxError)metadataIncomplete=true;else throw error;}}
     const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
     if(actualProcess)assert(Number.isSafeInteger(actualProcess.pid)&&actualProcess.pid>1&&Number.isSafeInteger(actualProcess.group)&&actualProcess.group>1);
     const program=JSON.parse(await readFile(resolve(ownedEvidenceDirectory,'submit-fault-program.json'),'utf8'));
     assert.equal(createHash('sha256').update(await readFile(resolve(home,'p3-stop-target'))).digest('hex'),program.sha256);
     response.setHeader('Content-Type','application/json');response.end(JSON.stringify({gateSource,process:actualProcess,metadataIncomplete,processAlive:actualProcess?alive(actualProcess.pid):null,groupGone:actualProcess?!alive(-actualProcess.group):null,actualEntries:entries===null?null:Buffer.byteLength(entries),released,programSha256:program.sha256}));
    })().catch(error=>{response.writeHead(500).end('Owned submitted-command observation failed');});
   });
  }
  if(p3BackpressureGate){let released=false;vite.middlewares.use(`/__native-p3-output-gate/${token}`,(request,response)=>{
    void(async()=>{assert(request.method==='POST'&&!released);released=true;await writeFile(p3BackpressureGate,'release\n',{flag:'wx',mode:0o600});response.end('ok');})().catch(()=>response.writeHead(500).end('Owned program gate release failed'));
  });}
  if(nativeP3==='zsh'&&values['native-input-p3-backpressure']){
    assert(ownedEvidenceDirectory&&frozenNativeRun);
    attachFocusTraceChannel(vite,token,ownedEvidenceDirectory);
  }
  if(values['native-input-p3-publisher-run-once'])vite.middlewares.use(`/__native-p3-publisher/${token}`,(request,response)=>{
    void(async()=>{
      assert(request.method==='POST'&&ownedEvidenceDirectory);
      const output=execFileSync('D:/Programs/PowerShell/7/pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(repository,'scripts/native-input/acceptance/windows-publisher.ps1'),'-DataDirectory',process.env.SHELLSPAN_DATA_DIR,'-Workspace',repository],{encoding:'utf8',timeout:10000});
      const proof=JSON.parse(output);assert(proof.choice==='RunOnceR'&&proof.signatureStatus==='Valid');
      await writeFile(resolve(ownedEvidenceDirectory,`verified-publisher-${randomUUID()}.json`),JSON.stringify(proof,null,2),{flag:'wx'});
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify(proof));
    })().catch(()=>response.writeHead(500).end('Actual approved publisher verification failed'));
  });
  if(values['native-input-p3-review'])vite.middlewares.use(`/__native-p3-review/${token}`,(request,response)=>{
    void(async()=>{
      assert((request.method==='POST'||request.method==='GET')&&ownedEvidenceDirectory);
      await writeFile(resolve(ownedEvidenceDirectory,'native-p3-window-review-request.json'),JSON.stringify({requestedAt:new Date().toISOString(),method:request.method,token},null,2),{flag:'wx',mode:0o600});
      const deadline=Date.now()+180000;
      while(!existsSync(resolve(ownedEvidenceDirectory,'native-p3-window-reviewed.json'))){assert(Date.now()<deadline,'Actual native window review deadline');await new Promise(resolve=>setTimeout(resolve,25));}
      response.end('ok');
    })().catch(()=>response.writeHead(500).end('Actual native window review failed'));
  });
  if(nativeP3==='zsh')vite.middlewares.use(`/__native-p3-empty-output/${token}`,(request,response)=>{
    void(async()=>{
      assert(request.method==='POST'&&ownedEvidenceDirectory);
      const chunks=[];let length=0;for await(const part of request){length+=part.length;assert(length<=1024);chunks.push(part);}
      const geometry=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert(Number.isInteger(geometry.columns)&&Number.isInteger(geometry.rows));
      const directory=resolve(ownedEvidenceDirectory,`ordinary-empty-output-${randomUUID()}`);
      execFileSync('python3',['-B',resolve(repository,'scripts/native-input/acceptance/zle-empty-output.py'),directory,String(geometry.columns),String(geometry.rows)],{stdio:'pipe',timeout:20000});
      const metadata=JSON.parse(await readFile(resolve(directory,'result.json'),'utf8'));const raw=await readFile(resolve(directory,'captured.bin'));
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({metadata,capturedBase64:raw.toString('base64')}));
    })().catch(()=>{response.writeHead(500).end('Actual ordinary Zsh capture baseline failed');});
  });
  if(p3CredentialMode)attachCredentialChannel(vite,{...p3CredentialConfiguration,mode:p3CredentialMode,token,runId:process.env.SHELLSPAN_ACCEPTANCE_RUN_ID,directory:ownedEvidenceDirectory});
  if(frozenWindows)vite.middlewares.use((request,response,next)=>{
    if(new URL(request.url,'http://127.0.0.1').pathname!==`/${pagePath}`){next();return;}
    // Do not run any page/session/model code until the actual owned PE process
    // has been inspected and bound to this frozen source/asset manifest.
    void(async()=>{
      const deadline=Date.now()+30000;
      for(;;){
        for(const name of await readdir(ownedEvidenceDirectory)){
          if(!/^native-image-\d+(?:-[a-f0-9-]{36})?-process\.json$/.test(name))continue;
          const processRecord=JSON.parse(await readFile(resolve(ownedEvidenceDirectory,name),'utf8'));
          if(processRecord.frozenManifest===frozenManifestPath){verifyFrozenValidation(frozenManifestPath,'before-webview-entry');next();return;}
        }
        assert(Date.now()<deadline,'Actual Windows image provenance was not established before WebView entry');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    })().catch(error=>{response.writeHead(503).end('Actual Windows image verification failed');settle({ok:false,error:String(error)});});
  });
  if(frozenNativeRun)attachSingleUseValidationPage(vite,pagePath,token);
  if(values['native-input-p2']&&values['terminal-contention']&&process.env.SHELLSPAN_P2_CONTENTION_GATE){
    let opened=false;
    vite.middlewares.use(`/__native-p2-contention-gate/${token}`,async(request,response)=>{
      try{
        assert(request.method==='POST'&&!opened&&ownedEvidenceDirectory);
        const name=process.env.SHELLSPAN_P2_CONTENTION_GATE;assert(/^native-p2-contention-[a-f0-9-]{36}$/.test(name));
        assert(resolve(process.env.SHELLSPAN_LOCAL_HOME)===resolve(ownedEvidenceDirectory,'home'));
        await writeFile(resolve(process.env.SHELLSPAN_LOCAL_HOME,name),'release\n',{flag:'wx',mode:0o600});opened=true;response.end('ok');
      }catch(error){response.writeHead(500).end(String(error));}
    });
  }
  if(credentialMode)vite.middlewares.use(`/__native-p2-credential/${token}`,(request,response)=>{
    if(request.method!=='POST'||!credentialProvision){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(credentialProvision));
    credentialProvision=undefined;
  });
  let layoutRequests = 0;
  let windowRequests = 0;
  const contentionEvidence = [];
  if(values['native-input-p2-history']) vite.middlewares.use(`/__native-history-audit/${token}`,async(request,response)=>{
    if(request.method!=='POST'){response.writeHead(405).end();return;}
    try{
      const path=process.env.SHELLSPAN_P2_HISTORY_AUDIT;
      assert(path&&ownedEvidenceDirectory&&resolve(path)===resolve(ownedEvidenceDirectory,'history-audit-config.json'));
      const config=JSON.parse(await readFile(path,'utf8'));
      assert(resolve(config.directory)===resolve(ownedEvidenceDirectory));
      let bytes=Buffer.alloc(0),exists=true;
      if(config.fixturePath){
        const fixture=JSON.parse(await readFile(config.fixturePath,'utf8'));
        assert(/^shellspan-nip-p2-[a-f0-9-]{36}$/.test(fixture.container));
        const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspanartifacts/tests/native-input/integration"}}',fixture.container],{encoding:'utf8'}).trim();assert(fixture.container===`shellspan-nip-p2-${label}`);
        try{bytes=execFileSync('docker',['exec',fixture.container,'sh','-c','if test -e "$1"; then cat "$1"; else exit 44; fi','history-audit',config.file],{maxBuffer:1048576,stdio:['ignore','pipe','pipe']});}
        catch(error){if(error.status!==44)throw error;exists=false;}
      }else{
        assert(resolve(config.file).startsWith(resolve(ownedEvidenceDirectory,'home')+'/'));
        try{bytes=await readFile(config.file);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
      }
      const sha256=createHash('sha256').update(bytes).digest('hex');
      await writeFile(resolve(ownedEvidenceDirectory,'history-before-control.bin'),bytes,{flag:'wx',mode:0o600});
      await writeFile(resolve(ownedEvidenceDirectory,'history-before-control.json'),JSON.stringify({exists,sha256,bytes:bytes.length}),{flag:'wx',mode:0o600});
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({exists,sha256,bytes:bytes.length}));
    }catch(error){response.writeHead(500).end(String(error));}
  });
  let keyboardRequests = 0;
  if (process.platform === 'win32' && (terminalContentionRun || windowsShell)) vite.middlewares.use(`/__native-composer-input/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    let file;
    try {
      assert(++keyboardRequests <= 1, 'Only one owned native composer input is admitted');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size <= 65536, 'Oversized native keyboard request'); chunks.push(chunk); }
      const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert(packet && Object.keys(packet).length === 1 && typeof packet.text === 'string'
        && packet.text.length <= 8192 && !/[\x00-\x09\x0b-\x1f\x7f]/.test(packet.text), 'Unsupported keyboard input');
      file = resolve(tmpdir(), `shellspan-composer-input-${token}.json`);
      await writeFile(file, JSON.stringify(packet), { flag: 'wx' });
      const executable=await windowsValidationImage();
      const metadata = await new Promise((complete, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-File',
        resolve(repository, 'scripts/fixtures/windows-desktop-type.ps1'), '-Executable', executable, '-InputFile', file],
      { timeout: 15000, maxBuffer: 65536, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : complete(stdout)));
      response.setHeader('Content-Type', 'application/json'); response.end(metadata);
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
    finally { if (file) await rm(file, { force: true }); }
  });
  if (windowsShell) vite.middlewares.use(`/__native-job-gate-proof/${token}`, async(request,response)=>{
    if(request.method!=='POST'){response.statusCode=405;response.end();return;}
    try { await assert.rejects(stat(windowsCompletionGate),{code:'ENOENT'}); response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({closed:true,gate:windowsCompletionGate})); }
    catch {response.statusCode=500;response.end('Owned completion gate was unexpectedly released');}
  });
  if (windowsShell) vite.middlewares.use(`/__native-window-evidence/${token}`, async (request,response) => {
    if (request.method !== 'POST') { response.statusCode=405; response.end(); return; }
    try {
      assert(++windowRequests <= 1, 'Only one owned native window capture is admitted');
      const file = ownedEvidenceDirectory ? resolve(ownedEvidenceDirectory, 'native-window.png') : resolve(tmpdir(),`shellspan-desktop-${token}.png`);
      const executable=await windowsValidationImage();
      const metadata = await new Promise((complete,reject) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-File',
        resolve(repository,'scripts/fixtures/windows-desktop-capture.ps1'), '-Executable',executable, '-Output',file],
      { timeout:15000,maxBuffer:65536,windowsHide:true }, (error,stdout,stderr) => error ? reject(new Error(stderr || error.message)) : complete(stdout)));
      response.setHeader('Content-Type','application/json'); response.end(metadata);
    } catch(error) { response.statusCode=500; response.end(String(error)); }
  });
  if (values['native-jobs']) vite.middlewares.use(`/__native-editor-layout/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    try {
      assert(++layoutRequests <= 1, 'Only one native layout proof is admitted per run');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 131072, 'Oversized native layout request');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert(Object.keys(input).every(key => ['shell', 'acceptedLine', 'columns', 'rows', 'prefixColumns'].includes(key)), 'Unknown native layout field');
      const shell = windowsShell ?? values['native-jobs-ssh'] ?? (process.env.SHELL?.endsWith('/bash') ? 'bash' : process.env.SHELL?.endsWith('/zsh') ? 'zsh' : undefined);
      assert(shell && input.shell === shell, 'Native editor must match the runner shell configuration');
      assert(typeof input.acceptedLine === 'string' && Buffer.byteLength(input.acceptedLine) <= 32768
        && (windowsShell ? /^job-[0-9a-f]{32} '/.test(input.acceptedLine)
          : /^\( job-[0-9a-f]{32};\n[\s\S]*\n\) &$/.test(input.acceptedLine)), 'Invalid actual native submission');
      assert(Number.isInteger(input.columns) && input.columns >= 32 && input.columns <= 1000
        && Number.isInteger(input.rows) && input.rows >= 10 && input.rows <= 300
        && Number.isInteger(input.prefixColumns) && input.prefixColumns >= 0 && input.prefixColumns < input.columns, 'Invalid native layout geometry');
      const base = ownedEvidenceDirectory ? resolve(ownedEvidenceDirectory, 'native-editor-layout') : resolve(tmpdir(), `shellspan-native-layout-${randomUUID()}`);
      await writeFile(`${base}.input.json`, JSON.stringify(windowsShell ? { acceptedLine: input.acceptedLine,
        columns: input.columns, rows: input.rows, prefixColumns: input.prefixColumns,
        executable: process.env.SHELLSPAN_LOCAL_SHELL,
      } : { acceptedLine: input.acceptedLine,
        columns: input.columns, rows: input.rows, prefixColumns: input.prefixColumns, shell,
        ssh: Boolean(values['native-jobs-ssh']), compose: resolve(repository, 'tests/ssh-e2e/compose.yml'),
        bashExecutable: process.env.SHELL,
      }));
      await new Promise((complete, reject) => execFile(windowsShell ? resolve(repository, 'src-tauri/target/debug/examples/native_editor_layout.exe') : 'python3',
        [...(windowsShell ? [] : [resolve(repository, 'scripts/native-input/acceptance/verify-native-editor-layout.py')]), `${base}.input.json`, `${base}.bin`],
        { timeout: 25000, maxBuffer: 65536, windowsHide:true }, (error, _stdout, stderr) => error ? reject(new Error(`Native editor layout failed: ${stderr || error.message}`)) : complete()));
      const bytes = await readFile(`${base}.bin`);
      assert(bytes.length <= 2 * 1024 * 1024, 'Oversized native layout trace');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ rawBase64: bytes.toString('base64'),
        metadata: JSON.parse(await readFile(`${base}.bin.json`, 'utf8')), trace: `${base}.bin` }));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  if (stableNativeEntry) vite.middlewares.use(contentionEntryPath, (request, response) => {
    if (request.method !== 'GET' || !contentionEntryUrl) { response.statusCode = 404; response.end(); return; }
    response.statusCode = 302;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Location', contentionEntryUrl);
    response.end();
  });
  if (terminalReadinessRun) vite.middlewares.use(`/__terminal-registry-reload/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    try {
      const module = vite.moduleGraph.getModuleById(resolve(repository, 'src/components/terminal/registry/terminal-registry.ts'));
      assert(module, 'Terminal registry module was not loaded');
      await vite.reloadModule(module);
      response.end('ok');
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  vite.middlewares.use(`/__agent-stream-result/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > (nativeEvidencePath ? 1024 * 1024 : 8192)) throw new Error('Oversized test result');
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value.evidence) {
        assert(nativeEvidencePath && typeof value.evidence === 'object', 'Unexpected native evidence payload');
        if(nativeP3&&ownedEvidenceDirectory&&value.progress)await writeFile(resolve(ownedEvidenceDirectory,`native-p3-progress-${randomUUID()}.json`),JSON.stringify({progress:value.progress,evidence:value.evidence},null,2),{flag:'wx',mode:0o600});
        if (terminalContentionRun) contentionEvidence.push(value.evidence);
        await writeFile(nativeEvidencePath, JSON.stringify(terminalContentionRun ? { events: contentionEvidence } : value.evidence, null, 2));
        console.log(`Native target WebView evidence: ${nativeEvidencePath}`);
      }
      if (terminalContentionRun && !value.progress) {
        await writeFile(nativeEvidencePath, JSON.stringify({ events: contentionEvidence, result: value }, null, 2));
      }
      response.end('ok');
      if (value.progress) { console.log(value.progress); return; }
      settle(value);
    } catch {
      response.statusCode = 400;
      response.end();
      settle({ ok: false, error: 'Invalid native test result' });
    }
  });
};
const resultPlugin = { name: 'native-agent-stream-result', configureServer: attachResult, configurePreviewServer: attachResult };
let server;
try {
  if (output) await build({
    configFile: false, root: repository, logLevel: 'error',
    resolve: { alias: { '@': resolve(repository, 'src') } },
    plugins: [baselinePlugin, react(), tailwindcss()],
    build: { outDir: output, emptyOutDir: true,
      rolldownOptions: { input: resolve(repository, pagePath) } },
  });
  if(frozenNativeRun){
    const assets=captureValidationAssets(output);
    assert(!(await readFile(resolve(output,pagePath),'utf8')).includes('/@vite/client'),'Frozen frontend unexpectedly contains the development HMR client');
    writeFrozenCheckpoint(frozenManifestPath,{version:1,root:repository,directory:ownedEvidenceDirectory,entry:pagePath,assetsDirectory:output,sources:frozenSources,assets,
      ...(nativeResourcesDirectory?{nativeResourcesDirectory,nativeResources}:{}),hmr:false,tauriWatch:false});
    writeFrozenCheckpoint(resolve(ownedEvidenceDirectory,`frozen-${token}-after-frontend-build.json`),verifyFrozenValidation(frozenManifestPath,'after-frontend-build'));
  }
  server = output ? await preview({
    configFile: false, root: repository, plugins: [resultPlugin], build: { outDir: output },
    preview: { host: '127.0.0.1', port: frozenNativeRun?contentionPort:0,strictPort:frozenNativeRun },
  }) : await createServer({
    configFile: false,
    root: repository,
    cacheDir: resolve(repository, 'node_modules/.vite-agent-stream-native'),
    resolve: { alias: { '@': resolve(repository, 'src') } },
    plugins: [react(), tailwindcss(), resultPlugin],
    server: { host: '127.0.0.1', port: stableNativeEntry ? contentionPort : 0,
      strictPort: stableNativeEntry, hmr: terminalReadinessRun ? undefined : false, watch: null },
  });
} catch (error) {
  if (output&&!frozenNativeRun) await rm(output, { recursive: true, force: true });
  throw error;
}
let child;
let timer;
let frozenSucceeded=false;
try {
  if (!output) await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/${pagePath}`);
  url.searchParams.set('token', token);
  url.searchParams.set('baseline', String(baseline));
  url.searchParams.set('noModel', String(noModel));
  if (values['terminal-delegation']) url.searchParams.set('terminalDelegation', 'true');
  if (questionSubmissionRun) url.searchParams.set('questionSubmissionRecovery', 'true');
  if (values['composer-input-diagnostic']) url.searchParams.set('composerInputDiagnostic', 'true');
  if (values['terminal-reconnect-ssh']) url.searchParams.set('sshFixture', 'true');
  if (values['terminal-reconnect-surface']) url.searchParams.set('surfaceOnly', 'true');
  if (values['terminal-reconnect-focus']) url.searchParams.set('focusReconnect', 'true');
  if (values['native-jobs-ssh']) url.searchParams.set('sshShell', values['native-jobs-ssh']);
  if(values['native-input-p2']) url.searchParams.set('nativeP2','true');
  if(nativeP3) url.searchParams.set('nativeP3',nativeP3);
  if(p3CredentialMode)url.searchParams.set('nativeP3CredentialMode',p3CredentialMode);
  if(values['native-input-p3-review'])url.searchParams.set('nativeP3Review','true');
  if(values['native-input-p3-startup-diagnostic'])url.searchParams.set('nativeP3StartupDiagnostic','true');
  if(values['native-input-p3-require-jobs'])url.searchParams.set('nativeP3RequireJobs','true');
  if(values['native-input-p3-publisher-run-once'])url.searchParams.set('nativeP3PublisherRunOnce','true');
  if(values['native-input-p3-backpressure'])url.searchParams.set('nativeP3Backpressure','true');
  if(values['native-input-p3-cancel'])url.searchParams.set('nativeP3CancelEffect',`p3-cancel-${token}`);
  if(values['native-input-p3-submit-fault'])url.searchParams.set('nativeP3SubmitFault','true');
  if(process.env.SHELLSPAN_P2_CONTENTION_GATE)url.searchParams.set('nativeP2ContentionGate',process.env.SHELLSPAN_P2_CONTENTION_GATE);
  if(values['native-input-p2-ssh-fault']){assert(/^[0-9a-f-]{36}$/.test(process.env.SHELLSPAN_P2_FAULT_NONCE));url.searchParams.set('nativeP2FaultNonce',process.env.SHELLSPAN_P2_FAULT_NONCE);}
  if(credentialMode)url.searchParams.set('nativeP2CredentialMode',credentialMode);
  if(process.env.SHELLSPAN_P2_CREDENTIAL_REFERENCE){
    assert(/^native-p2-secret-[0-9a-f-]{36}$/.test(process.env.SHELLSPAN_P2_CREDENTIAL_REFERENCE));
    url.searchParams.set('nativeP2Credential',process.env.SHELLSPAN_P2_CREDENTIAL_REFERENCE);
  }
  if(values['native-input-p2-history-small']) url.searchParams.set('historySmall','true');
  if(values['native-input-p2-ssh-fixture']){
    assert(values['native-input-p2']&&values['native-jobs'],'P2 SSH requires the explicit native acceptance mode');
    const fixturePath=resolve(values['native-input-p2-ssh-fixture']);
    assert(fixturePath.startsWith(resolve(repository,'artifacts/tests/native-input/integration/ssh')+'/'),'SSH fixture must belong to this isolated task root');
    const fixture=JSON.parse(await readFile(fixturePath,'utf8'));
    assert(fixture.host==='127.0.0.1'&&Number.isInteger(fixture.port)&&fixture.port>1024);
    assert(/^shellspan-nip-p2-[a-f0-9-]{36}$/.test(fixture.container));
    const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspanartifacts/tests/native-input/integration"}}',fixture.container],{encoding:'utf8'}).trim();
    assert(fixture.container===`shellspan-nip-p2-${label}`,'SSH fixture container ownership differs');
    const fixtureShell=fixture.shell??'bash';
    assert(fixtureShell==='bash'||fixtureShell==='zsh'&&nativeP3==='zsh','SSH fixture shell must match the explicit native editor acceptance');
    url.searchParams.set('sshShell',fixtureShell);
    url.searchParams.set('nativeP2SshPort',String(fixture.port));
    url.searchParams.set('nativeP2SshUser',process.env.SHELLSPAN_P2_SSH_USER??(fixtureShell==='zsh'?'nativeZle':'native53'));
    assert(fixtureShell==='zsh'?url.searchParams.get('nativeP2SshUser')==='nativeZle':/^native(?:41|44|53)(?:-[0-9a-f]{8})?$/.test(url.searchParams.get('nativeP2SshUser')));
  }
  if (values['native-jobs-direct']) url.searchParams.set('directLifecycle', 'true');
  if (values['native-jobs-focus']) url.searchParams.set('focusPolling', 'true');
  if (values['native-jobs-narrow']) url.searchParams.set('narrow','true');
  if (windowsShell) url.searchParams.set('nativeShell', windowsShell);
  if (windowsOutputMarker) url.searchParams.set('outputMarker', windowsOutputMarker);
  if (windowsShell) url.searchParams.set('runId',process.env.SHELLSPAN_ACCEPTANCE_RUN_ID ?? '');
  if (values.route) { url.searchParams.set('route', values.route); url.searchParams.set('model', values.model); }
  for (const id of values['cleanup-session'] ?? []) url.searchParams.append('cleanupSession', id);
  contentionEntryUrl = url.href;
  const devUrl = stableNativeEntry ? `http://127.0.0.1:${contentionPort}${contentionEntryPath}` : url.href;
  assert(!frozenInterrupted,`Isolated frozen validation interrupted (${frozenInterrupted})`);
  if(frozenNativeRun)writeFrozenCheckpoint(resolve(ownedEvidenceDirectory,`frozen-${token}-before-native-compile.json`),verifyFrozenValidation(frozenManifestPath,'before-native-compile'));
  child = values['native-binary']
    ? spawn(resolve(values['native-binary']), [], { cwd: repository, stdio: ['ignore', 'ignore', 'inherit'], detached: process.platform !== 'win32' })
    : spawn(process.platform === 'win32' ? process.execPath : 'pnpm', [
      ...(process.platform === 'win32' ? [fileURLToPath(new URL('./tauri.js', import.meta.resolve('@tauri-apps/cli')))] : ['exec','tauri']),
      'dev', '--no-watch',
      ...(process.platform === 'darwin' ? ['--runner', resolve(repository, 'scripts/dev/dev-cargo-runner.mjs')] : frozenWindows?['--runner',resolve(repository,'scripts/native-input/acceptance/windows-cargo-runner.cmd')]:[]),
      '--config', resolve(repository, 'src-tauri/tauri.dev.conf.json'), '--config', JSON.stringify({
    identifier: values['data-scope'] ?? 'com.shellspan-dev', build: { beforeDevCommand: '', devUrl },
    ...((process.platform === 'win32' && stableNativeEntry || terminalContentionRun || performanceRun && !values['cleanup-session']?.length) ? { app: { windows: [{
      label: 'main', title: process.platform === 'win32' && stableNativeEntry ? 'ShellSpan native validation' : terminalContentionRun ? 'Terminal contention validation' : 'Agent panel validation', width: 1480, height: 920,
      minWidth: 1200, minHeight: 760, visible: true, focus: true, alwaysOnTop: true,
      transparent: true, titleBarStyle: 'Overlay',
    }] } } : {}),
  })], { cwd: repository, env: frozenNativeRun?{...nativeEnvironment,CARGO_TARGET_DIR:values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance'&&process.env.SHELLSPAN_P3_BUILD_CACHE?process.env.SHELLSPAN_P3_BUILD_CACHE:resolve(repository,'artifacts/tests/native-input/integration/frozen-target'),SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST:frozenManifestPath,
    ...(frozenWindows?{RUSTUP_TOOLCHAIN:'1.95.0-x86_64-pc-windows-msvc',CARGO_BUILD_TARGET:'x86_64-pc-windows-msvc'}:{})}:nativeEnvironment, stdio: ['ignore', 'ignore', 'inherit'], detached: process.platform !== 'win32' });
  child.once('error', (error) => settle({ ok: false, error: error.message }));
  child.once('exit', (code) => settle({ ok: false, error: `Tauri exited before reporting results (${code})` }));
  timer = setTimeout(() => settle({ ok: false, error: 'Native stream regression timed out after 10 minutes' }), 600_000);
  const outcome = await result;
  if(frozenNativeRun)writeFrozenCheckpoint(resolve(ownedEvidenceDirectory,`frozen-${token}-after-webview-result.json`),verifyFrozenValidation(frozenManifestPath,'after-webview-result'));
  assert.equal(outcome.ok, true, outcome.error);
  if(frozenNativeRun)frozenSucceeded=true;
  else{
  if (initializationRun) console.log(credentialMode==='cleanup'?'Owned native keychain credential deleted and absence verified.':'Independent data initialized by the actual native backend; empty route store verified; no model calls made.');
  else if (performanceRun) console.log(JSON.stringify({ baseline, baselineRef: baseline ? baselineRef : undefined, baselineCommit, productionBundle: true, ...outcome.metrics }));
  else if (terminalContentionRun && values['cleanup-session']?.length) console.log('Native contention fixture cleanup completed.');
  else if (values['composer-input-diagnostic']) console.log('Native production composer input passed: complete two-line draft through actual keyboard input. No close or model acceptance was performed.');
  else if (terminalContentionRun && noModel) console.log(`Native terminal close passed: real PTY command, production close confirmation, durable Agent cancellation, unrelated terminal preservation, ${process.platform==='win32'?'actual shell exit':'idle disconnect'} and idempotent close without error Toasts. No model calls were made.`);
  else if (questionSubmissionRun) console.log('Native question recovery passed: real model question, rejected answer, repeated status refresh, answer editing and durable commit.');
  else if (values['terminal-delegation']) console.log('Native terminal delegation passed: delegated page, terminal, focus and draft preservation; real child command, parent resumption, unrelated Agent exclusion, user input restoration and child takeover.');
  else if (terminalContentionRun) console.log('Native terminal contention passed: two real Agents, one PTY, conflict draft retention, task navigation, manual retry, simultaneous admission, confirmed takeover, running-Agent close and idempotent stale-tab cleanup.');
  else if (values['native-input-p2-lifecycle']) console.log('Actual native registry lifecycle passed: native/native/raw rebind and partial OSC/UTF-8 EOF; public APIs and terminal history preserved.');
  else if (values['native-input-p2-ssh-fault']) console.log('Actual SSH private-control EOF passed: durable may-submitted recovery gate, single real effect, retired transport rejection and explicit native reconnect.');
  else if (values['native-input-p2-interactive']||values['native-input-p2-interactive-fresh']) console.log('Actual native interactive terminal passed: REPL, confirmation, alternate buffer, credential redaction/forbidden input and user interrupt recovery.');
  else if (values['native-input-p2-history']) console.log('Actual model/native history sequence passed; parent status, original history settings and individual entries verified.');
  else if (values['native-jobs']) console.log('Native model shell jobs passed: complete script, native job handle, three waits, terminate, nonzero exit and workspace/draft/focus preservation.');
  else if (focusBackgroundRun) console.log('Native Focus background regression passed: two real visible commands completed on the leased PTY, with Focus selection and keyboard focus preserved.');
  else if (terminalReadinessRun) console.log('Native terminal readiness passed: registry identity across hot updates, existing and new local PTY output.');
  else if (terminalClearScreenRun) console.log('Native terminal clear-screen passed: production controller, native IPC and real local PTY.');
  else if (values['terminal-reconnect-surface']) console.log('Native terminal reconnect surface passed: unique mounted surface, visible geometry, retained controller and real PTY input/output across repeated reconnects. No model calls were made.');
  else if (terminalReconnectRun) console.log(`Native ${values['terminal-reconnect-focus'] ? 'Focus ' : ''}${values['terminal-reconnect-ssh'] ? 'SSH' : 'local PTY'} reconnect passed: automatic verified reconnect, explicit restore without ancestry, current execution busy gate, original conversation and draft, bilingual responsive restore actions, and no automatic command replay. No model calls were made.`);
  else if (focusRun) console.log('Native focus regression passed: real local terminals, explicit targets, collapse/restore, continuation IPC, and responsive geometry. No model or remote commands were executed.');
  else console.log('Native Agent stream passed: pending subscription/snapshot cancellation, error publication, automatic gap recovery and cleanup.');
  }
} finally {
  clearTimeout(timer);
  let frozenImageStarted=false;
  if(frozenNativeRun&&child?.pid){
    const processes=[];
    for(const name of await readdir(ownedEvidenceDirectory)){
      if(!/^native-image-\d+(?:-[a-f0-9-]{36})?-process\.json$/.test(name))continue;
      const value=JSON.parse(await readFile(resolve(ownedEvidenceDirectory,name),'utf8'));
      if(value.frozenManifest===frozenManifestPath)processes.push({...value,processRecordName:name});
    }
    assert(processes.length<=1,'More than one native application was launched for a single frozen validation');
    if(processes.length){
      frozenImageStarted=true;const application=processes[0];
      const frozenSource=JSON.parse(await readFile(frozenManifestPath,'utf8'));
      const isolatedImage=frozenWindows?values['data-scope']==='com.shellspan.validationartifacts/tests/native-input/acceptance':frozenSource.root.includes('artifacts/tests/native-input/acceptance/acceptance-source/');
      const imageParent=isolatedImage?ownedEvidenceDirectory:resolve(repository,'artifacts/tests/native-input/integration/frozen-target');
      assert(Number.isSafeInteger(application.appPid)&&application.appPid>1&&application.executable.startsWith(imageParent+sep));
      if(frozenWindows){
        execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(repository,'scripts/native-input/acceptance/windows-image.ps1'),
          '-Action','Stop','-ApplicationPid',String(application.appPid),'-RunnerPid',String(application.runnerPid),'-Executable',application.executable],{stdio:'pipe',timeout:20000});
      }else try{
        process.kill(application.appPid,0);
        const imageRecord=JSON.parse(await readFile(resolve(ownedEvidenceDirectory,application.processRecordName.replace(/-process\.json$/,'.json')),'utf8'));
        assert.equal(imageRecord.frozenManifest,frozenManifestPath,'Native image and process record must belong to the same frozen validation');
        assert(/^[a-f0-9]{64}$/.test(imageRecord.binarySha256),'Native image digest missing');
        const command=execFileSync('/bin/ps',['-p',String(application.appPid),'-o','comm='],{encoding:'utf8'}).trim();
        assert.equal(command,application.executable,'The recorded validation PID no longer owns its signed image');
        assert.equal(createHash('sha256').update(await readFile(application.executable)).digest('hex'),imageRecord.binarySha256,'Owned native image changed before cleanup');
        process.kill(application.appPid,'SIGTERM');
      }catch(error){
        if(error.code!=='ESRCH'){
          let gone=false;
          if(error.status===1)try{process.kill(application.appPid,0);}catch(exit){if(exit.code==='ESRCH')gone=true;else throw exit;}
          if(!gone)throw error;
        }
      }
    }else if(child.exitCode===null){
      if(frozenWindows)execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(repository,'scripts/fixtures/windows-desktop-process-cleanup.ps1'),
        '-RootPid',String(child.pid),'-OwnerPid',String(process.pid),'-RootExecutable',process.execPath,'-Output',resolve(ownedEvidenceDirectory,'native-before-image-cleanup.json')],{stdio:'pipe',timeout:20000});
      else try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    }
  }else if (child?.pid && child.exitCode === null) {
    try {
      if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        resolve(repository, 'scripts/fixtures/windows-desktop-process-cleanup.ps1'), '-RootPid', String(child.pid), '-OwnerPid', String(process.pid),
        '-RootExecutable', values['native-binary'] ? resolve(values['native-binary']) : process.execPath,
        ...(ownedEvidenceDirectory ? ['-Output', resolve(ownedEvidenceDirectory, initializationRun ? 'native-data-initialize-cleanup.json' : 'native-model-cleanup.json')] : [])],
      { stdio: 'pipe', windowsHide: true, timeout: 20000 });
      else process.kill(-child.pid, 'SIGTERM');
    }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (output) {
    await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
    if(frozenNativeRun&&frozenImageStarted){
      const deadline=Date.now()+15000;let ended;
      while(!ended){
        for(const name of await readdir(ownedEvidenceDirectory)){
          if(!/^native-image-\d+(?:-[a-f0-9-]{36})?-end\.json$/.test(name))continue;
          const value=JSON.parse(await readFile(resolve(ownedEvidenceDirectory,name),'utf8'));
          if(value.frozenManifest===frozenManifestPath){assert.equal(value.verified,true,'Actual native image end verification failed');ended=value;break;}
        }
        if(!ended){assert(Date.now()<deadline,'Actual native image end verification was not recorded');await new Promise(resolve=>setTimeout(resolve,50));}
      }
      writeFrozenCheckpoint(resolve(ownedEvidenceDirectory,`frozen-${token}-finished.json`),{...verifyFrozenValidation(frozenManifestPath,'finished'),image:ended});
      if(child.exitCode===null)await new Promise((resolveExit,reject)=>{
        const deadline=setTimeout(()=>reject(new Error('Frozen validation runner did not exit after image verification')),15000);
        child.once('exit',()=>{clearTimeout(deadline);resolveExit();});
      });
    }else if(!frozenNativeRun) await rm(output, { recursive: true, force: true });
  } else await server.close();
}
if(frozenSucceeded)console.log(`Frozen native verification passed; static assets, complete sources and actual ${frozenWindows?'Windows PE':'signed macOS'} image verified through exit.`);
