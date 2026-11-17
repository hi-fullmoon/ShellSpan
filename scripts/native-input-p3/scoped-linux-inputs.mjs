// Copies the reviewed portable Core sources into a new unsealed Linux candidate.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,copyFileSync,mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=resolve(process.argv[2]),meta=resolve(root,'artifacts/tests/native-input-p3');
const stage=JSON.parse(readFileSync(resolve(meta,'candidate-stage.json'),'utf8'));assert(stage.root===root&&!stage.sealed);
const producerFile=process.argv[3]?resolve(process.argv[3]):stage.producerFile;
const producer=process.argv[3]?JSON.parse(readFileSync(producerFile,'utf8')):stage.producer,hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
if(process.argv[3]){
 assert(producer.sealed&&producer.nativeAcceptance===false&&producer.productionChanges===false);
 const parent=JSON.parse(readFileSync(producer.parent,'utf8'));assert.equal(parent.editorSha256,'521e7ca22ecc1727d059d13f5034df71ac0eca88a176c09d5bfc59c0e46c87fc');assert.equal(hash(producer.editor),producer.editorSha256);
}
const destination=resolve(root,'artifacts/tests/native-input-p2/resources/native-input/scoped-core/linux-source');mkdirSync(destination,{recursive:true});
for(const name of['zle_refresh.c','zle_params.c','zle_main.c']){
 const source=resolve(producer.source,'Src/Zle',name),target=resolve(destination,name);assert.equal(hash(source),producer.nativeSourceHashes[name]);
 // Only this new unsealed copy may replace inherited inputs, and only when
 // the inherited digest is the producer's explicitly recorded reviewed parent.
 try{const inherited=hash(target);if(inherited!==producer.nativeSourceHashes[name]){assert.equal(inherited,producer.parentHashes?.[name]);chmodSync(target,0o600);copyFileSync(source,target);}}catch(error){if(error.code!=='ENOENT')throw error;copyFileSync(source,target);}
 chmodSync(target,0o400);assert.equal(hash(target),producer.nativeSourceHashes[name]);
}
writeFileSync(resolve(meta,'scoped-linux-inputs.json'),JSON.stringify({sourceProducer:producerFile,sourceHashes:producer.nativeSourceHashes,archiveSha256:producer.archiveSha256,sourceDirectory:destination,boundMainSha256:'1ebc9b7012541bdc45fe8cbb9f752c0dc49aeb47dea0fd76d755639e7554e6d3',unicode9Default:false,reason:'The actual Debian main imports glibc wcwidth and does not export u9_wcwidth; preserve this default',nativeAcceptance:false,productionChanges:false},null,2));
console.log(JSON.stringify({root,sourceDirectory:destination,nativeAcceptance:false}));
