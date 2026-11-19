// Preserve raw equality for ordinary default-zero controls, separately from
// the owned Tab requirement that intentionally emits actual trailing spaces.
import assert from 'node:assert/strict';
import {readFile,mkdir,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const owner=resolve(import.meta.dirname,'../../..'),stockPath=resolve(process.argv[2]),candidatePath=resolve(process.argv[3]);
const stock=JSON.parse(await readFile(resolve(stockPath,'result.json'),'utf8')),candidate=JSON.parse(await readFile(resolve(candidatePath,'result.json'),'utf8'));
assert(!stock.ordinaryCoreProducer&&candidate.ordinaryCoreProducer);assert.equal(stock.results.length,12);assert.equal(candidate.results.length,12);
const producer=JSON.parse(await readFile(candidate.ordinaryCoreProducer,'utf8'));
assert.equal(createHash('sha256').update(await readFile(producer.editor)).digest('hex'),producer.editorSha256);
for(const index of[10,11,12]){
 const base=resolve(candidatePath,`literal-${index}/ordinary-zle-baseline`),entries=await readdir(base);assert.equal(entries.length,1);
 const evidence=resolve(base,entries[0]),actual=JSON.parse(await readFile(resolve(evidence,'result.json'),'utf8'));
 assert(actual.ok&&actual.actualBudget===0&&actual.sourceExecuted===false);assert.equal(actual.scopedDefaultCoreProducer.editorSha256,producer.editorSha256);
 assert.equal(createHash('sha256').update(await readFile(resolve(evidence,'actual-buffer'))).digest('hex'),actual.sourceSha256);
}
const comparisons=candidate.results.map(row=>{
 const expected=stock.results.find(x=>x.engine===row.engine&&x.renderer===row.renderer&&x.index===row.index);assert(expected);assert.equal(row.sourceDigest,expected.sourceDigest);
 const actual=row.observations.find(x=>x.mode==='ordinary'),baseline=expected.observations.find(x=>x.mode==='ordinary');assert(actual&&baseline);
 const sameRawCells=JSON.stringify(actual.cells)===JSON.stringify(baseline.cells),sameCopy=actual.copied===baseline.copied;
 return{engine:row.engine,renderer:row.renderer,index:row.index,sourceDigest:row.sourceDigest,sameRawCells,sameCopy};
});
const directory=resolve(owner,'artifacts/tests/native-input/acceptance/scoped-default-compare',randomUUID());await mkdir(directory,{recursive:true});
await writeFile(resolve(directory,'result.json'),JSON.stringify({stockPath,candidatePath,coreSha256:producer.editorSha256,scope:'actual ordinary stock vs candidate default-zero LF/Tab/CR; exact raw cells, wrap flags and public copy; no full ABI or native-App claim',comparisons},null,2));
console.log(JSON.stringify({directory,cases:comparisons.length,passed:comparisons.filter(x=>x.sameRawCells&&x.sameCopy).length}));assert(comparisons.every(x=>x.sameRawCells&&x.sameCopy));
