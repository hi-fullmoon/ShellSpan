import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectWindowsProfiles, windowsValidationPaths, windowsShortSnapshotLocation } from '../native-input-p3/windows-profiles.mjs';
import { verifyNativeWindowReview } from '../native-input-p3/window-review.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const runner = path.join(root, 'scripts/verify-terminal-native-input.mjs');

describe('native input runner argument validation', () => {
  it.each([
    ['--native-input-p3-ai-credential','invalid'],
    ['--native-input-p3-ai-credential','provision','--data-initialize'],
    ['--native-input-p3-ai-credential','provision','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs'],
    ['--native-input-p3-ai-credential','verify-absence','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-credential-lifecycle'],
  ])('rejects mixed or unowned AI credential validation before touching credentials: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-ai-credential-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home'),SHELLSPAN_E07_ORIGINAL_ROUTE_DB:path.join(evidence,'original.db'),SHELLSPAN_ACCEPTANCE_RUN_ID:'43b17b64-3422-4739-9d93-fbc415b9f3ab'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-ai-credential requires isolated Windows no-model API initialization');
  });
  it.each([
    ['--native-input-p3-credential-lifecycle'],
    ['--native-input-p3-credential-lifecycle','--data-initialize'],
    ['--native-input-p3-credential-lifecycle','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs'],
    ['--native-input-p3-credential-lifecycle','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p2-credential','cleanup'],
  ])('rejects mixed or unisolated API-only credential validation before accessing credentials: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-credential-lifecycle-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home')},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-credential-lifecycle requires one isolated Windows API-only initialization');
  });
  it.each([
    ['--native-input-p3-history-lifecycle','history-default','--no-model'],
    ['--native-input-p3-history-lifecycle','history-unset'],
    ['--native-input-p3-history-lifecycle','history-custom','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs-direct'],
  ])('rejects unsafe history lifecycle options before App/profile access: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-history-lifecycle-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home'),SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain(process.platform!=='win32'&&args.includes('--native-jobs-powershell')?'--native-jobs-powershell requires native Windows':'--native-input-p3-history-lifecycle requires one isolated real-model Windows history option case');
  });
  it('rejects combined startup and lifecycle history modes before reading profiles',()=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),'--native-input-p3-history-lifecycle','history-custom','--native-input-p3-history-startup','history-custom'],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('Choose one isolated Windows history startup or lifecycle case');
  });
  it.each([
    ['--native-input-p3-history-startup','history-default','--no-model'],
    ['--native-input-p3-history-startup','history-unset'],
    ['--native-input-p3-history-startup','history-custom','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs-direct'],
  ])('rejects unsafe history startup options before App/profile access: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-history-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home'),SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain(process.platform!=='win32'&&args.includes('--native-jobs-powershell')?'--native-jobs-powershell requires native Windows':'--native-input-p3-history-startup requires one isolated real-model Windows history option case');
  });
  it.each([
    ['--native-input-p3-job-retired','wait','--no-model'],
    ['--native-input-p3-job-retired','invalid'],
    ['--native-input-p3-job-retired','kill','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs-direct'],
  ])('rejects unsafe retired binding checks before any App or keyboard action: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-job-retired-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home'),SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain(process.platform!=='win32'&&args.includes('--native-jobs-powershell')?'--native-jobs-powershell requires native Windows':'--native-input-p3-job-retired requires one isolated real-model Windows retired wait/kill case');
  });
  it.each([
    ['--native-input-p3-job-ownership','wait','--no-model'],
    ['--native-input-p3-job-ownership','invalid'],
    ['--native-input-p3-job-ownership','kill','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs-direct'],
  ])('rejects unsafe job ownership entry before any App or keyboard action: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-job-ownership-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home'),SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain(process.platform!=='win32'&&args.includes('--native-jobs-powershell')?'--native-jobs-powershell requires native Windows':'--native-input-p3-job-ownership requires one isolated real-model Windows foreign wait/kill case');
  });
  it.each([
    ['--native-input-p3-job-completion','0','--no-model'],
    ['--native-input-p3-job-completion','5'],
    ['--native-input-p3-job-completion','7','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs-direct'],
  ])('rejects unsafe natural job completion before any App or keyboard action: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-job-completion-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home'),SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain(process.platform!=='win32'&&args.includes('--native-jobs-powershell')?'--native-jobs-powershell requires native Windows':'--native-input-p3-job-completion requires one isolated real-model Windows natural exit0/7 case');
  });
  it.each([
    ['--native-input-p3-job-lifecycle','--no-model'],
    ['--native-input-p3-job-lifecycle','--native-jobs','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-job-lifecycle','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs-direct'],
  ])('refuses unsafe lifecycle combinations before any App or keyboard action: %j',(...args)=>{
    const evidence=path.join(root,'artifacts/tests/native-job-scope-test'),result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home'),SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain(process.platform!=='win32'&&args.includes('--native-jobs-powershell')?'--native-jobs-powershell requires native Windows':'--native-input-p3-job-lifecycle requires an isolated real-model native Windows lifecycle case');
  });
  it('requires the isolated late receipt entry before testing an unconfirmed accept',()=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),'--native-input-p3-before-accept'],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-before-accept requires the isolated late receipt entry');
  });
  it.each([
    ['--native-input-p3-late-receipt','--no-model'],
    ['--native-input-p3-late-receipt','--native-input-p3-before-accept','--no-model'],
    ['--native-input-p3-late-receipt','--native-input-p3-before-accept','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-late-receipt','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-late-receipt','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-windows-lifetime','control-eof'],
  ])('requires an exclusive isolated real-model late receipt entry: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-late-receipt requires one isolated real-model Windows late receipt case');
  });
  it.each([
    ['--native-input-p3-active-eof','--no-model'],
    ['--native-input-p3-active-eof','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
    ['--native-input-p3-active-eof','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-windows-lifetime','control-eof-draft','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model','--native-input-p3-active-eof'],
  ])('requires an isolated approved real-model active EOF entry: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-active-eof requires one isolated real-model Windows EOF case');
  });
  it.each([
    ['--native-input-p3-navigation-manual','--no-model'],
    ['--native-input-p3-navigation-manual','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
    ['--native-input-p3-navigation-manual','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
  ])('requires an isolated approved real-model manual-navigation entry: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-navigation-manual requires one isolated real-model Windows manual case');
  });
  it.each([
    ['--native-input-p3-delegation-takeover'],
    ['--native-input-p3-delegation-takeover','--native-input-p3-approval-delegation','--native-input-p3-delegation-close'],
  ])('requires an exclusive approved delegation entry for takeover: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-delegation-takeover requires exclusive approval-delegation');
  });
  it('requires the approval-preserving entry for delegated running close',()=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),'--native-input-p3-delegation-close'],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-delegation-close requires approval-delegation');
  });
  it.each([
    ['--native-input-p3-approval-delegation','--no-model'],
    ['--native-input-p3-approval-delegation','--native-input-p3-delegation-close','--no-model'],
    ['--native-input-p3-approval-delegation','--native-input-p3-delegation-takeover','--no-model'],
    ['--native-input-p3-approval-delegation','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-approval-delegation','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
  ])('rejects unsafe approved delegation before App start: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-approval-delegation requires one isolated real-model Windows delegation case');
  });
  it('requires the approval-preserving entry for simultaneous admission',()=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),'--native-input-p3-contention-race'],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-contention-race requires approval-contention');
  });
  it.each([
    ['--native-input-p3-approval-contention','--no-model'],
    ['--native-input-p3-approval-contention','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-approval-contention','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
  ])('refuses unsafe approval-contention entry before App start: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-approval-contention requires one isolated real-model Windows approval case');
  });
  it('rejects an otherwise valid EOF case without explicit isolated data/home paths',()=>{
    const env={...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'};for(const name of ['SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR','SHELLSPAN_DATA_DIR','SHELLSPAN_LOCAL_HOME'])delete env[name];
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),'--native-input-p3-windows-lifetime','control-eof','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model'],{cwd:root,env,encoding:'utf8',timeout:5000});expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-windows-lifetime requires an isolated Windows no-model lifetime case');
  });
  it.each([
    ['--native-input-p3-windows-lifetime','invalid'],
    ['--native-input-p3-windows-lifetime','control-eof-draft','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-windows-lifetime','control-eof-draft','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model','--native-input-p3-file-chain'],
    ['--native-input-p3-windows-lifetime','close','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-windows-lifetime','exit','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3','--no-model'],
    ['--native-input-p3-windows-lifetime','close','--native-input-p3','powerShell7','--data-scope','com.shellspan','--no-model'],
    ['--native-input-p3-windows-lifetime','close','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model','--native-input-p3-file-chain'],
  ])('rejects unsafe bootstrap lifetime selection before App start: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-windows-lifetime requires an isolated Windows no-model lifetime case');
  });
  it.each([
    ['--native-input-p3-windows-draft-action','takeover'],
    ['--native-input-p3-windows-draft-cancel','--native-input-p3-windows-draft-action','unknown'],
  ])('rejects unsupported or unpaired draft-action selection: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-windows-draft-action requires one supported draft action');
  });
  it.each([
    ['--native-input-p3-windows-draft-stage','fullInput'],
    ['--native-input-p3-windows-draft-cancel','--native-input-p3-windows-draft-stage','armed'],
  ])('rejects unsupported or unpaired draft-stage selection: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-windows-draft-stage requires draft cancellation and an exact supported stage');
  });
  it.each([
    ['--native-input-p3-windows-draft-cancel','--no-model'],
    ['--native-input-p3-windows-draft-cancel','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-windows-draft-cancel','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
    ['--native-input-p3-windows-draft-cancel','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-file-chain'],
  ])('rejects unsafe partial-input cancellation arguments before starting an App: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-windows-draft-cancel requires one isolated real-model Windows partial-input case');
  });
  it.each([
    ['--native-input-p3-windows-stop','unknown'],
    ['--native-input-p3-windows-stop','cancel','--no-model'],
    ['--native-input-p3-windows-stop','cancel','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-windows-stop','takeover','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
    ['--native-input-p3-windows-stop','cancel','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-file-chain'],
  ])('rejects unsafe Windows stop arguments before starting an App: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-windows-stop requires one isolated real-model Windows running-stop case');
  });
  it.each([
    ['--native-input-p3-byte-boundary','8192','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','unpaired'],
    ['--native-input-p3-byte-boundary','8194'],
    ['--native-input-p3-byte-boundary','8192','--no-model'],
    ['--native-input-p3-byte-boundary','8192','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-byte-boundary','8193','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
    ['--native-input-p3-byte-boundary','8192','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-file-chain'],
  ])('rejects unsafe byte-boundary arguments before starting an App: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-byte-boundary requires one isolated real-model Windows byte-boundary case');
  });
  it.each([
    ['--native-input-p3-file-restart','unknown'],
    ['--native-input-p3-file-restart','prepare','--no-model'],
    ['--native-input-p3-file-restart','verify','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-file-restart','prepare','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
    ['--native-input-p3-file-restart','verify','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-file-chain'],
  ])('rejects unsafe scratch-restart arguments before starting an App: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-file-restart requires one isolated real-model native scratch restart phase');
  });
  it.each([
    ['--native-input-p3-file-fault','unknown'],
    ['--native-input-p3-file-fault','occupied-directory','--no-model'],
    ['--native-input-p3-file-fault','existing-file','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-file-fault','existing-file','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
    ['--native-input-p3-file-fault','existing-file','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-file-chain'],
  ])('rejects unsafe scratch-fault arguments before starting an App: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-file-fault requires one isolated real-model native scratch refusal case');
  });
  it.each([
    ['--native-input-p3-file-chain','--no-model'],
    ['--native-input-p3-file-chain','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
    ['--native-input-p3-file-chain','--native-input-p3','powerShell7','--data-scope','com.shellspan'],
  ])('rejects unsafe native file-chain arguments before starting an App: %j',(...args)=>{
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-file-chain requires one isolated real-model native file chain');
  });
  it.each([
    ['--native-input-p3-storage-admission','healthy','--no-model'],
    ['--native-input-p3-storage-admission','unknown'],
    ...['read-only','unknown-format','invalid-marker','foreign-namespace','missing-directory','directory-junction','corrupt-database','read-denied','crash-after-start','crash-prepare','crash-proof','crash-intent','crash-arm','crash-key']
      .flatMap(mode=>[
        ['--native-input-p3-storage-admission',mode,'--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model'],
        ['--native-input-p3-storage-admission',mode,'--native-input-p3','powerShell7','--data-scope','com.shellspan'],
      ]),
  ])('rejects unsafe storage admission modes before native execution: %j', (...args) => {
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{
      cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--native-input-p3-storage-admission requires one isolated real-model native case with an exact supported host, editor and owned data');
  });
  it('rejects a storage refusal expectation outside read-only recovery mode', () => {
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),'--journal-recovery-error','TERMINAL_SUBMISSION_JOURNAL_UNAVAILABLE'],{
      cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--journal-recovery-error requires read-only recovery');
  });
  it('rejects empty recovery expectations outside a normal recovery query', () => {
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),'--journal-recovery-empty'],{
      cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000,
    });
    expect(result.status).toBe(1);expect(result.stderr).toContain('--journal-recovery-empty requires a normal read-only recovery query');
  });
  it.each([
    ['--journal-recovery-agent','agent-test'],
    ['--journal-recovery-agent','agent-test','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p2-credential','provision'],
  ])('rejects unsafe journal-only startup before any App or credential operation: %j', (...args) => {
    const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{
      cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--journal-recovery-agent requires isolated no-model initialization');
  });
  it('does not reclaim window focus after the model run for desktop evidence', () => {
    const source = readFileSync(path.join(root, 'src/components/terminal/__tests__/native-jobs.native.tsx'), 'utf8');
    expect(source.match(/getCurrentWindow\(\)\.setFocus\(\)/g)).toHaveLength(1);
    const capture = source.slice(source.indexOf('const finalEvidence:'));
    expect(capture).not.toContain('getCurrentWindow().setFocus()');
    expect(capture).not.toContain('getCurrentWindow().show()');
    expect(capture).toContain('/__native-window-evidence/');
    const runnerSource = readFileSync(path.join(root, 'scripts/verify-ai-session-stream.mjs'), 'utf8');
    expect(runnerSource).toContain('alwaysOnTop: !frozenNativeRun');
  });
  it('requires a passing visual review of the exact captured image', () => {
    const image = Buffer.from('isolated test image bytes');
    const imageSha256 = createHash('sha256').update(image).digest('hex');
    expect(() => verifyNativeWindowReview({ passed: true, imageSha256 }, image)).not.toThrow();
    for (const review of [{ imageSha256 }, { passed: false, imageSha256 }, { passed: true, imageSha256: '0'.repeat(64) }, null]) {
      expect(() => verifyNativeWindowReview(review, image)).toThrow();
    }
  });
  it('binds the reviewed PSReadLine patch and private assemblies to their exact digests', () => {
    const pin = JSON.parse(readFileSync(path.join(root, 'scripts/dependency-builds/psreadline/build.json'), 'utf8'));
    expect(createHash('sha256').update(readFileSync(path.join(root, pin.patch))).digest('hex')).toBe(pin.patchSha256);
    for(const [name, expected] of Object.entries(pin.outputs)) {
      const assembly = path.join(root, 'src-tauri/resources/powershell/PSReadLine/2.4.5', name);
      expect(createHash('sha256').update(readFileSync(assembly)).digest('hex'), name).toBe(expected);
    }
    expect(JSON.parse(readFileSync(path.join(root, 'src-tauri/resources/powershell/PSReadLine/2.4.5/ShellSpan.Build.json'), 'utf8'))).toEqual(pin);
    expect(pin.buildRevision).toBe('shellspan6');
    expect(pin.graphemeProvider).toMatchObject({package:'@xterm/addon-unicode-graphemes',version:'0.4.0',license:'XTERM-LICENSE'});
    expect(createHash('sha256').update(readFileSync(path.join(root,'src-tauri/resources/powershell/PSReadLine/2.4.5',pin.graphemeProvider.license))).digest('hex')).toBe(pin.graphemeProvider.licenseSha256);
    const patch=readFileSync(path.join(root,pin.patch),'utf8');
    expect(patch).toContain('ConfigureProvider');
    expect(patch).not.toContain('SHELLSPAN_ACCEPTANCE_ORIGIN_CHANNEL');
    expect(patch).not.toContain('SHELLSPAN_ACCEPTANCE_LAYOUT');
    expect(execFileSync('git', ['check-attr', 'eol', '--', pin.patch], { cwd: root, encoding: 'utf8' }).trim()).toBe(`${pin.patch}: eol: lf`);
  });
  it('keeps short Windows snapshots owned and the PS5 editor cache below MAX_PATH', () => {
    const id='12345678-1234-1234-1234-123456789abc';
    const location=windowsShortSnapshotLocation(root,id);
    expect(location).toEqual({directory:path.join(root,'artifacts/tests/p3','12345678'),root:path.join(root,'artifacts/tests/p3','12345678','s')});
    const cachedAssembly=path.join(location.root,'artifacts/tests/native-input-p2/w114/data/editors','0'.repeat(32),'PSReadLine/2.4.5/net6plus/Microsoft.PowerShell.PSReadLine.Polyfiller.dll');
    if(process.platform==='win32')expect(cachedAssembly.length).toBeLessThan(260);
    expect(()=>windowsShortSnapshotLocation(root,'../elsewhere')).toThrow('UUID');
    expect(()=>windowsShortSnapshotLocation('relative',id)).toThrow('absolute owner');
  });
  it('isolates Windows backend and WebView data under the same owned evidence directory', () => {
    const evidence = path.resolve(root, 'artifacts/tests/owned-windows-validation');
    expect(windowsValidationPaths(evidence)).toEqual({
      appDirectoriesOverride: path.join(evidence, 'data'),
      dataDirectory: path.join(evidence, 'webview'),
      powerShellModuleAnalysisCachePath: path.join(evidence, 'powershell-module-analysis.cache'),
    });
    expect(() => windowsValidationPaths('relative/evidence')).toThrow('absolute owned evidence directory');
  });
  it('keeps both pinned Windows hosts by default and makes a subset explicit', () => {
    expect(selectWindowsProfiles(undefined).map(profile => profile.shell)).toEqual(['powerShell7']);
    expect(selectWindowsProfiles(['powerShell7'])).toEqual([{ shell: 'powerShell7', expectedVersion: '7.6.9' }]);
    expect(() => selectWindowsProfiles(['windowsPowerShell'])).toThrow('Unsupported Windows host kind');
  });
  it.each([
    { selection: [], error: 'unique Windows host kinds' },
    { selection: ['powerShell7', 'powerShell7'], error: 'unique Windows host kinds' },
    { selection: ['unknown'], error: 'Unsupported Windows host kind' },
  ])('rejects invalid Windows host selections: $selection', ({ selection, error }) => {
    expect(() => selectWindowsProfiles(selection)).toThrow(error);
  });
  it('keeps reviewed xterm patch bytes invariant on Windows checkouts', () => {
    const pin = JSON.parse(readFileSync(path.join(root, 'scripts/dependency-builds/xterm/build.json'), 'utf8'));
    for (const file of ['patches/@xterm__xterm@6.0.0.patch', ...Object.keys(pin.patches)]) {
      const bytes = readFileSync(path.join(root, file));
      expect(execFileSync('git', ['check-attr', 'eol', '--', file], { cwd: root, encoding: 'utf8' }).trim()).toBe(`${file}: eol: lf`);
      expect(bytes.includes(Buffer.from('\r\n')), file).toBe(false);
      if (pin.patches[file]) {
        expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(pin.patches[file]);
      }
    }
  });
  it.each([
    ['--model-preflight', '--no-model'],
    ['--model-preflight'],
    ['--model-preflight', '--data-scope', 'com.shellspan.validation.native-input-p3', '--native-jobs'],
  ])('rejects an unsafe model preflight before starting an App: %j', (...args) => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify-ai-session-stream.mjs'), ...args], {
      cwd: root,
      // Every case is rejected during argument validation, before any GUI work.
      env: { ...process.env, SHELLSPAN_ALLOW_FOREGROUND_TESTS: '1' },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--model-preflight is one independent bounded real-model connection test');
  });
  it.each([
    { arguments: ['--browser-only', '--native-only'], error: 'Choose either --browser-only or --native-only' },
    { arguments: ['--browser-only', '--native-only', '--research-profile'], error: "Unknown option '--research-profile'" },
  ])('rejects $arguments before starting a native check', ({ arguments: args, error }) => {
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });
});
