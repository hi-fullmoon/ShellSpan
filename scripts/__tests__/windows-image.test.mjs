import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { windowsValidationPaths } from '../native-input-p3/windows-profiles.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const artifacts = path.join(root, 'artifacts/tests/windows-image');
const execute = promisify(execFile);

describe.runIf(process.platform === 'win32')('owned Windows image inspection', () => {
  it('stops the verified application tree while preserving a sibling process', async()=>{
    await mkdir(artifacts,{recursive:true});const directory=await mkdtemp(path.join(artifacts,'stop-tree-'));
    const fixture=path.join(directory,'owned-root.mjs');
    await writeFile(fixture,"import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});process.stdout.write('ready\\n');setInterval(()=>{},1000);");
    const owned=spawn(process.execPath,[fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,windowsHide:true,stdio:'ignore'});
    const ownedEnded=new Promise(resolve=>owned.once('close',resolve)),siblingEnded=new Promise(resolve=>sibling.once('close',resolve));
    try{
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned fixture did not start')),5000);owned.once('error',error=>{clearTimeout(timer);reject(error);});owned.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
      const args=['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(root,'scripts/native-input-p3/windows-image.ps1'),'-Action','Stop','-ApplicationPid',String(owned.pid),'-RunnerPid',String(process.pid),'-Executable',process.execPath];
      const stopped=JSON.parse((await execute('powershell.exe',args,{cwd:root,windowsHide:true,encoding:'utf8',timeout:20000})).stdout);
      expect(stopped.treeKillUsed).toBe(false);expect(stopped.termination).toBe('verified-process-handles');await ownedEnded;
      expect(sibling.exitCode).toBeNull();expect(()=>process.kill(sibling.pid,0)).not.toThrow();
    }finally{
      if(owned.exitCode===null)owned.kill();if(sibling.exitCode===null)sibling.kill();await Promise.allSettled([ownedEnded,siblingEnded]);
      const relative=path.relative(artifacts,directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe owned-stop fixture cleanup');await rm(directory,{recursive:true,force:true});
    }
  },30000);
  it('rejects a foreign App before enumerating its native Shell', async()=>{
    await mkdir(artifacts,{recursive:true});const directory=await mkdtemp(path.join(artifacts,'shell-owner-'));
    try{
      const record=path.join(directory,'app.json');await writeFile(record,JSON.stringify({executable:process.execPath,applicationPid:process.pid}));
      await expect(execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(root,'scripts/native-input-p3/windows-native-shell.ps1'),
        '-AppRecord',record,'-AppHelper',path.join(root,'scripts/native-input-p3/windows-image.ps1'),'-OwnedRoot',directory,'-Shell',process.execPath,
        '-ExpectedShellSha256','0'.repeat(64),'-ExpectedModuleSha256','1'.repeat(64)],{cwd:directory,windowsHide:true,encoding:'utf8',timeout:20000,
        env:{...process.env,PSModulePath:directory,PSModuleAnalysisCachePath:path.join(directory,'module.cache')}})).rejects.toThrow('App image is outside the owned acceptance directory');
    }finally{const relative=path.relative(artifacts,directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Unsafe Shell ownership fixture cleanup');await rm(directory,{recursive:true,force:true});}
  },25000);
  it('keeps frozen symbol input guards available with isolated module paths', async () => {
    await mkdir(artifacts,{recursive:true});const directory=await mkdtemp(path.join(artifacts,'symbol-modules-'));
    const image=path.join(directory,'image.exe'),symbols=directory,source=path.join(directory,'source.rs');
    try{
      await Promise.all([writeFile(image,'owned invalid image'),writeFile(path.join(symbols,'image.pdb'),'owned symbols'),writeFile(source,'owned source')]);
      const args=['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(root,'scripts/native-input-p3/windows-debug-symbols.ps1'),
        '-Image',image,'-Symbols',symbols,'-Source',source,'-Line','1','-ExpectedImageSha256','0'.repeat(64),'-ExpectedPdbSha256','1'.repeat(64),'-ExpectedSourceSha256','2'.repeat(64)];
      await expect(execute('powershell.exe',args,{cwd:directory,windowsHide:true,encoding:'utf8',timeout:20000,
        env:{...process.env,PSModulePath:directory,PSModuleAnalysisCachePath:path.join(directory,'module.cache')}})).rejects.toThrow('Frozen symbol input identity changed');
    }finally{
      const relative=path.relative(artifacts,directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Unsafe symbol fixture cleanup path');
      await rm(directory,{recursive:true,force:true});
    }
  },25000);
  it('requires the exact inspected creation time and digest before crashing an owned process', async () => {
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,windowsHide:true,stdio:'ignore'});
    const ended=new Promise(resolve=>child.once('close',resolve));
    const args=['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(root,'scripts/native-input-p3/windows-image.ps1'),
      '-Action','Inspect','-ApplicationPid',String(child.pid),'-RunnerPid',String(process.pid),'-Executable',process.execPath];
    const options={cwd:root,windowsHide:true,encoding:'utf8',timeout:20_000};
    try{
      const inspected=JSON.parse((await execute('powershell.exe',args,options)).stdout);
      const crash=[...args];crash[crash.indexOf('-Action')+1]='Crash';
      await expect(execute('powershell.exe',crash,options)).rejects.toThrow('Crash requires');
      for(const [created,digest,handleCreated] of [['2000-01-01T00:00:00.0000000Z',inspected.sha256,inspected.handleCreated],[inspected.created,'0'.repeat(64),inspected.handleCreated],[inspected.created,inspected.sha256,'2000-01-01T00:00:00.0000000Z']]){
        await expect(execute('powershell.exe',[...crash,'-ExpectedCreated',created,'-ExpectedHandleCreated',handleCreated,'-ExpectedSha256',digest],options)).rejects.toThrow('identity changed');
        expect(child.exitCode).toBeNull();expect(()=>process.kill(child.pid,0)).not.toThrow();
      }
      const result=JSON.parse((await execute('powershell.exe',[...crash,'-ExpectedCreated',inspected.created,'-ExpectedHandleCreated',inspected.handleCreated,'-ExpectedSha256',inspected.sha256],options)).stdout);
      expect(result.crashRequested).toBe(true);expect(result.descendantsTerminatedByHelper).toBe(false);
      await ended;
    }finally{if(child.exitCode===null)child.kill();await ended;}
  },45_000);
  it('keeps the delayed PowerShell5 observer module cache out of its working source tree', async () => {
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(path.join(artifacts, 'module-cache-'));
    const home = path.join(directory, 'home');
    await mkdir(home);
    const output = path.join(directory, 'foreground.jsonl');
    const cache = windowsValidationPaths(directory).powerShellModuleAnalysisCachePath;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      path.join(root, 'scripts/fixtures/windows-foreground-observe.ps1'), '-Output', output], {
      cwd: directory, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, HOME: home, USERPROFILE: home, PSModuleAnalysisCachePath: cache },
    });
    const ended = new Promise(resolve => child.once('close', resolve));
    try {
      const deadline = Date.now() + 25_000;
      while (!existsSync(cache) && Date.now() < deadline && child.exitCode === null) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(existsSync(cache), 'The actual deferred cache write was not observed').toBe(true);
      expect(existsSync(path.join(directory, 'Microsoft/Windows/PowerShell/ModuleAnalysisCache'))).toBe(false);
      await writeFile(output + '.stop', 'stop', { flag: 'wx' });
      expect(await ended).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await ended;
      const relative = path.relative(artifacts, directory);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
      await rm(directory, { recursive: true, force: true });
    }
  }, 35_000);
  it('uses system modules with an isolated module path and rejects a foreign parent', async () => {
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(path.join(artifacts, 'run-'));
    const environment = { ...process.env, PSModulePath: directory };
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: root, env: environment, windowsHide: true, stdio: 'ignore',
    });
    const ended = new Promise(resolve => child.once('close', resolve));
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      path.join(root, 'scripts/native-input-p3/windows-image.ps1'), '-Action', 'Inspect',
      '-ApplicationPid', String(child.pid), '-RunnerPid', String(process.pid), '-Executable', process.execPath];
    try {
      const options = { cwd: root, env: environment, windowsHide: true, encoding: 'utf8', timeout: 20_000 };
      const inspected = await execute('powershell.exe', args, options);
      const observed = JSON.parse(inspected.stdout);
      expect(observed.applicationPid).toBe(child.pid);
      expect(observed.runnerPid).toBe(process.pid);
      expect(observed.sha256).toBe(createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
      const rejected = [...args];
      rejected[rejected.indexOf('-RunnerPid') + 1] = String(process.pid + 1);
      await expect(execute('powershell.exe', rejected, options)).rejects.toThrow('identity changed');
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      const stop = [...args];
      stop[stop.indexOf('-Action') + 1] = 'Stop';
      await execute('powershell.exe', stop, options);
      await ended;
      const repeated = JSON.parse((await execute('powershell.exe', stop, options)).stdout);
      expect(repeated.alreadyExited).toBe(true);
    } finally {
      child.kill();
      await ended;
      const relative = path.relative(artifacts, directory);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
