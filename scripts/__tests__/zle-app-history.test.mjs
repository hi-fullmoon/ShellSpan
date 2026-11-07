import {describe,it,expect} from 'vitest';
import {mkdirSync,writeFileSync,lstatSync,appendFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {prepareZleAppHistory,readZleHistoryObservation,readZleAppHistoryDisk,zleAppHistoryModes} from '../native-input-p3/zle-app-history.mjs';
const root=resolve(import.meta.dirname,'../..');
describe('owned ZLE App history observation',()=>{
 it.skipIf(process.platform!=='darwin'||process.env.SHELLSPAN_ALLOW_FOREGROUND_TESTS!=='1')('runs the real PTY observer without blocking later hooks or changing parent status',()=>{
  const directory=resolve(root,'.artifacts/tests/zle-app-history',randomUUID());mkdirSync(resolve(directory,'home'),{recursive:true,mode:0o700});
  const plan=prepareZleAppHistory(root,directory,'default');
  appendFileSync(resolve(plan.home,'.zshrc'),'p3_probe_later_hook() { builtin print -r -- entered >> "$HOME/after-observer-hook"; }\nzle -N p3_probe_later_hook\nadd-zle-hook-widget line-init p3_probe_later_hook\n');
  execFileSync('python3',['-B',resolve(root,'scripts/native-input-p3/zle-app-history-observer-probe.py'),'/bin/zsh',plan.home,directory],{stdio:'pipe',timeout:20000});
  const parent=resolve(plan.home,'history-observations'),snapshots=readdirSync(parent).filter(name=>existsSync(resolve(parent,name,'ready'))).map(name=>readZleHistoryObservation(resolve(parent,name)));
  expect(snapshots.some(value=>value.editor.buffer===''&&value.entries.includes('builtin print -r -- PASSIVE_OBSERVER_REAL_SOURCE'))).toBe(true);
  expect(readFileSync(resolve(directory,'raw.bin'),'utf8')).toContain('PASSIVE_STATUS=7\r\n');
  expect(readFileSync(resolve(plan.home,'after-observer-hook'),'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(4);
  expect(JSON.parse(readFileSync(resolve(directory,'pty-exit.json'),'utf8')).status).toBe(0);
 });
 it.skipIf(process.platform!=='darwin').each(zleAppHistoryModes)('retains real Zsh public history/configuration for %s',mode=>{
  const directory=resolve(root,'.artifacts/tests/zle-app-history',randomUUID());mkdirSync(resolve(directory,'home'),{recursive:true,mode:0o700});
  const plan=prepareZleAppHistory(root,directory,mode),observation=resolve(plan.home,'history-observations/0');
  execFileSync('/bin/zsh',['-f','-c','source "$1"; fc -R "$2"; print -s -- OWNED_OBSERVER_CURRENT_EVENT; p3_history_export "$3"','owned-history-test',resolve(plan.home,'.zshrc'),plan.history,observation],{env:{...process.env,HOME:plan.home,ZDOTDIR:plan.home,LC_ALL:'en_US.UTF-8'},stdio:'pipe'});
  const actual=readZleHistoryObservation(observation);expect(actual.ready).toBe(true);expect(actual.entries).toEqual(plan.seedSources);
  expect(actual.configuration.histsize).toBe(String(plan.maximum));expect(actual.configuration['histfile-set']).toBe(mode==='unset'?'0':'1');
  expect(actual.configuration.histfile).toBe(['empty','unset'].includes(mode)?'':plan.history);
  expect(actual.configuration['option-incappendhistory']).toBe(mode==='incremental'?'on':'off');expect(actual.configuration['option-sharehistory']).toBe(mode==='shared'?'on':'off');
  expect(readZleAppHistoryDisk(directory,'/bin/zsh').entries).toEqual(plan.seedSources);
  expect(()=>prepareZleAppHistory(root,directory,mode)).toThrow('Never replace');
  expect(lstatSync(resolve(plan.home,'.zshrc')).mode&0o777).toBe(0o600);
 });
 it.each([
  ['--native-input-p3-zle-history','default'],
  ['--native-input-p3-zle-history','unknown','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
  ['--native-input-p3-zle-history','default','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3','--no-model'],
 ])('rejects mixed or unowned history runs before App launch: %j',(...args)=>{
  const outcome=spawnSync(process.execPath,[resolve(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:5000});
  expect(outcome.error).toBeUndefined();expect(outcome.status).toBe(1);expect(outcome.stderr).toContain('--native-input-p3-zle-history requires one isolated');
 });
 it('does not treat absent public completion as an empty successful history',()=>{
  const directory=resolve(root,'.artifacts/tests/zle-app-history',randomUUID());mkdirSync(directory,{recursive:true});
  expect(readZleHistoryObservation(directory)).toEqual({ready:false});writeFileSync(resolve(directory,'ready'),'wrong');expect(()=>readZleHistoryObservation(directory)).toThrow();
 });
});
