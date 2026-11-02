import assert from 'node:assert/strict';
import {readFileSync,copyFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {requireEditorResources} from './editor-resources.mjs';
const owner=resolve(import.meta.dirname,'../..'),producer=resolve(process.argv[2]),target=process.argv[3];
assert(producer.startsWith(resolve(owner,'.native-input-p3/acceptance-source')+'/')&&['linux-aarch64-glibc-2.36'].includes(target));
const source=resolve(producer,'.native-input-p2/resources/native-input-v1'),destination=resolve(owner,'.native-input-p2/resources/native-input-v1');
const catalogueName=`editors-${target}.json`;requireEditorResources(producer,target);
const catalogue=JSON.parse(readFileSync(resolve(source,catalogueName),'utf8'));
for(const[path,expected]of Object.entries(catalogue.sources)){
 const {createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(readFileSync(resolve(owner,path))).digest('hex'),expected,`Owner differs from the actual producer: ${path}`);
}
for(const profile of catalogue.profiles)for(const path of[profile.module,profile.relay,profile.core,profile.coreLicense].filter(Boolean)){
 assert(path.startsWith(profile.profile.verifiedProfileId+'/')&&!path.includes('..'));
 mkdirSync(dirname(resolve(destination,path)),{recursive:true});copyFileSync(resolve(source,path),resolve(destination,path));
}
copyFileSync(resolve(source,catalogueName),resolve(destination,catalogueName));requireEditorResources(owner,target);
if(catalogue.profiles.some(profile=>profile.core)){
 const{createHash}=await import('node:crypto'),pin=JSON.parse(readFileSync(resolve(owner,'scripts/dependency-builds/zsh/pin.json'),'utf8'));
 const from=resolve(producer,`.native-input-p3/dependencies/zsh-${pin.version}.tar.xz`),to=resolve(owner,`.native-input-p3/dependencies/zsh-${pin.version}.tar.xz`);
 const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');assert.equal(sha(from),pin.archiveSha256);
 if(existsSync(to))assert.equal(sha(to),pin.archiveSha256);else{mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);assert.equal(sha(to),pin.archiveSha256);}
}
console.log(JSON.stringify({producer,target,profiles:catalogue.profiles.map(value=>value.profile.verifiedProfileId),importOnly:true,producerActualRebuild:true,nativeAcceptance:false}));
