// Read-only audit of actual public selection text and genuine full-buffer
// receipts. Standard expandtabs defines legal ASCII Tab presentation.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const owner=resolve(import.meta.dirname,'../..'),input=resolve(process.argv[2]);
const result=JSON.parse(await readFile(input,'utf8'));
const source="typeset P3_SSH_TABS=$'A\tB'; [[ $P3_SSH_TABS == $'A\tB' ]] && printf '%s%s\\n' P3-SSH- TABS";
const expected=execFileSync('/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',['-c','import sys; s=sys.stdin.read(); sys.stdout.write(("P3-SSH> "+s).expandtabs(8)[8:])'],{input:source,encoding:'utf8'});
const digest=createHash('sha256').update(source).digest('hex'),length=Buffer.byteLength(source),observations=[];
for(const row of result.results){
 const messages=(await readFile(resolve(row.evidence,'control.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const proof=messages.find(x=>x.requestId==='prepare-8'&&x.payload.kind==='inputConfirmed');assert(proof);assert.equal(proof.payload.sourceDigest,digest);for(const field of['utf8Bytes','cursorUtf8Bytes','endUtf8Bytes'])assert.equal(proof.payload[field],length);
 const legalCopy=row.observed.all.includes(expected);observations.push({columns:row.columns,evidence:row.evidence,sourceDigest:digest,literalTabs:2,legalCopy,publicApisUnmodified:row.observed.publicApisUnmodified});
}
const directory=resolve(owner,'artifacts/tests/native-input-p3/ssh-tab-audit',randomUUID());await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'result.json'),JSON.stringify({input,expectedLegalDisplayText:expected,observations,scope:'existing genuine full-buffer proof and unmodified public selection; no fresh native/App execution'},null,2));
console.log(JSON.stringify({directory,cases:observations.length,passed:observations.filter(x=>x.legalCopy&&x.publicApisUnmodified).length}));assert.equal(observations.length,4);assert(observations.every(x=>x.legalCopy&&x.publicApisUnmodified));
