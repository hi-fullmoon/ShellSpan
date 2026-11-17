import {afterEach,expect,it} from 'vitest';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {producerIdentityMatches,observeProducerProcesses,assertProducerIdentitiesExited} from '../native-input-p3/process-identity.mjs';
import {sealCase,verifySeal} from '../native-input-p3/acceptance-evidence.mjs';
import {inside} from '../native-input-p3/acceptance-inputs.mjs';

const expected={pid:42,exe:'D:\\Programs\\nodejs\\node.exe',start:'2026-11-05T06:35:01.614Z',end:'2026-11-05T06:35:01.882Z'};
const observed={pid:42,exe:'d:/programs/nodejs/node.exe',created:'2026-11-05T06:35:01.700Z'};
const roots=[],base=resolve(import.meta.dirname,'../../artifacts/tests/acceptance-process-identity');
afterEach(async()=>{for(const root of roots.splice(0)){inside(base,root);await rm(root,{recursive:true,force:true});}});
async function fixture(){await mkdir(base,{recursive:true});const root=await mkdtemp(resolve(base,'case-'));roots.push(root);await writeFile(resolve(root,'result.json'),'{}');return root;}

it('matches executable and original birth time while rejecting reused PIDs',()=>{
  expect(producerIdentityMatches(expected,observed)).toBe(true);
  expect(producerIdentityMatches(expected,undefined)).toBe(false);
  expect(producerIdentityMatches(expected,{...observed,exe:'C:/VisualStudio/BackgroundDownload.exe',created:'2026-11-05T06:43:32.502Z'})).toBe(false);
  expect(producerIdentityMatches(expected,{...observed,created:'2026-11-05T06:43:32.502Z'})).toBe(false);
  const exact={pid:42,exe:expected.exe,created:observed.created};
  expect(producerIdentityMatches(exact,observed)).toBe(true);
  expect(producerIdentityMatches(exact,{...observed,created:'2026-11-05T06:43:32.502Z'})).toBe(false);
});
it('rejects missing or invalid identity metadata and incomplete original-PID coverage',async()=>{
  expect(()=>producerIdentityMatches(expected,{pid:42,created:observed.created})).toThrow('executable');
  expect(()=>producerIdentityMatches({...expected,start:'invalid'},observed)).toThrow('time');
  expect(()=>producerIdentityMatches({...expected,exe:'relative.exe'},observed)).toThrow('Absolute');
  await expect(assertProducerIdentitiesExited([42],[])).rejects.toThrow('cover every original PID');
});
it('preserves strict live-PID rejection for existing seal callers',async()=>{
  const root=await fixture();await expect(sealCase(root,{status:'pass',producerPids:[process.pid],files:['result.json'],terminationConfirmed:true})).rejects.toThrow('still running');
});
it.skipIf(process.platform!=='win32')('rejects an actual live identity and verifies a v2 seal when that PID belongs to a different birth identity',async()=>{
  const [current]=await observeProducerProcesses([process.pid]);expect(current.pid).toBe(process.pid);
  const root=await fixture(),options={status:'pass',producerPids:[process.pid],files:['result.json'],terminationConfirmed:true};
  await expect(sealCase(root,{...options,producerIdentities:[current]})).rejects.toThrow('original identity');
  // OS-backed guard test with a modeled old identity; no App or lifecycle fact.
  const old={...current,created:new Date(Date.parse(current.created)-60000).toISOString()};
  const seal=await sealCase(root,{...options,producerIdentities:[old]});expect(seal.version).toBe(2);
  expect((await verifySeal(root)).sha256).toBe(seal.sha256);
  const stored=JSON.parse(await readFile(resolve(root,'seal.json'),'utf8'));stored.producerIdentities[0].created=current.created;await writeFile(resolve(root,'seal.json'),JSON.stringify(stored));
  await expect(verifySeal(root)).rejects.toThrow('changed');
});
