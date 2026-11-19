// Known request corpus compared with actual producer's complete-buffer proofs.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const evidence=resolve(process.argv[2]);
const messages=readFileSync(resolve(evidence,'control.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const corpus=[
 {requestId:'prepare-10',source:"[[ $? == 1 ]] && typeset -g P3_MULTI=$'first\nsecond'; [[ $P3_MULTI == $'first\nsecond' ]] && printf '%s%s\\n' P3-MULTILINE- STATUS"},
 {requestId:'prepare-11',source:"typeset -g P3_TABS=$'A\tB'; [[ $P3_TABS == $'A\tB' ]] && printf '%s%s\\n' P3-REDUCED- TABS"}
];
const observations=corpus.map(value=>{
 const actual=messages.find(message=>message.requestId===value.requestId&&message.payload.kind==='inputConfirmed');assert(actual);
 const digest=createHash('sha256').update(value.source).digest('hex');assert.equal(actual.payload.sourceDigest,digest);assert.equal(actual.payload.utf8Bytes,Buffer.byteLength(value.source));assert.equal(actual.payload.cursorUtf8Bytes,actual.payload.utf8Bytes);assert.equal(actual.payload.endUtf8Bytes,actual.payload.utf8Bytes);
 return{requestId:value.requestId,actualDigest:digest,actualUtf8Bytes:actual.payload.utf8Bytes,literalLf:[...value.source].filter(char=>char==='\n').length,literalTab:[...value.source].filter(char=>char==='\t').length,noNipReceiptSynthesized:true};
});
assert.equal(observations[0].literalLf,2);assert.equal(observations[1].literalTab,2);
writeFileSync(resolve(evidence,'literal-character-audit.json'),JSON.stringify({evidence,scope:'known exact source matched to actual full UTF8 native-buffer digest; not clipboard/cell acceptance',observations},null,2),{flag:'wx'});
console.log(JSON.stringify({evidence,observations}));
