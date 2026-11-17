import {it,expect} from 'vitest';
import fs from 'node:fs/promises';import p from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {windowsPackageFileWitness} from '../native-input-p3/windows-package-witness.mjs';
it('reads only the owned actual scratch files and separates missing resources from unreadable data',async()=>{
 const base=p.resolve(import.meta.dirname,'../../artifacts/tests/package-witness');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(p.join(base,'case-')),data=p.join(root,'data'),home=p.join(root,'home'),token=randomUUID();
 try{
  await fs.mkdir(data);await fs.mkdir(home);expect(await windowsPackageFileWitness(data,home,token)).toEqual({files:[],records:[],effectEntries:[],nativeBootstrap:{bootstraps:[]}});
  const scratch=p.join(data,'tmp','a'.repeat(16)),records=p.join(data,'agent-runtime/scratch/records');await fs.mkdir(scratch,{recursive:true});await fs.mkdir(records,{recursive:true});
  const content='owned witness bytes';await fs.writeFile(p.join(scratch,`acceptance-${token}.ps1`),content);await fs.writeFile(p.join(records,'b'.repeat(64)+'.json'),JSON.stringify({fixture:'filesystem-only'}));await fs.writeFile(p.join(home,`scratch-effect-${token}.txt`),'ONCE\r\n');
  const actual=await windowsPackageFileWitness(data,home,token);expect(actual.files[0].sha256).toBe(createHash('sha256').update(content).digest('hex'));expect(actual.files[0].content).toBe(content);expect(actual.records).toEqual([{fixture:'filesystem-only'}]);expect(actual.effectEntries).toEqual(['ONCE']);
  expect((await windowsPackageFileWitness(data,home,token,true)).unexpectedBodyExists).toBe(false);await fs.writeFile(p.join(home,`semantic-body-${token}.txt`),'BODY');expect((await windowsPackageFileWitness(data,home,token,true)).unexpectedBodyExists).toBe(true);
  await fs.writeFile(p.join(records,'b'.repeat(64)+'.json'),'{');await expect(windowsPackageFileWitness(data,home,token)).rejects.toMatchObject({witnessStage:'scratch-record-read'});
 }finally{const child=p.relative(base,p.resolve(root));if(!child||child.startsWith('..')||p.isAbsolute(child))throw new Error('Unsafe fixture cleanup');await fs.rm(root,{recursive:true});}
});
it('rejects directory links instead of reporting outside scratch content',async()=>{
 const base=p.resolve(import.meta.dirname,'../../artifacts/tests/package-witness');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(p.join(base,'link-')),data=p.join(root,'data'),home=p.join(root,'home'),outside=p.join(root,'outside');
 try{await fs.mkdir(p.join(data,'tmp'),{recursive:true});await fs.mkdir(home);await fs.mkdir(outside);await fs.symlink(outside,p.join(data,'tmp','c'.repeat(16)),process.platform==='win32'?'junction':'dir');await expect(windowsPackageFileWitness(data,home,randomUUID())).rejects.toThrow('must not be a link');}
 finally{const child=p.relative(base,p.resolve(root));if(!child||child.startsWith('..')||p.isAbsolute(child))throw new Error('Unsafe fixture cleanup');await fs.rm(root,{recursive:true});}
});
