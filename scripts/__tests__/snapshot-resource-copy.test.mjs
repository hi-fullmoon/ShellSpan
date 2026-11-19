import {expect,it} from 'vitest';
import {mkdirSync,copyFileSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {copySnapshotResources} from '../native-input/acceptance/acceptance-snapshot-resources.mjs';

it('copies actual source bytes into regular independent files so validation metadata writes cannot alter retained inputs',()=>{
 const root=resolve(import.meta.dirname,'../..'),directory=resolve(root,'artifacts/tests/snapshot-resource-copy',randomUUID()),source=resolve(directory,'source'),destination=resolve(directory,'destination');
 mkdirSync(source,{recursive:true});
 const file='native-zle-source.c';copyFileSync(resolve(root,'src-tauri/native-input-editors/zle.c'),resolve(source,file));
 const original=readFileSync(resolve(source,file));copySnapshotResources(source,destination);
 expect(readFileSync(resolve(destination,file))).toEqual(original);expect(lstatSync(resolve(destination,file)).isFile()).toBe(true);expect(lstatSync(resolve(destination,file)).isSymbolicLink()).toBe(false);
 const changed=Buffer.concat([original,Buffer.from('\n/* owned copy independence check */\n')]);writeFileSync(resolve(destination,file),changed);
 expect(readFileSync(resolve(source,file))).toEqual(original);expect(readFileSync(resolve(destination,file))).toEqual(changed);
});
