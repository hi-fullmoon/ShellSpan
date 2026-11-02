// Reconstruct only the frozen baseline in memory. Never restores workspace files.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parsePatch,applyPatch} from 'diff';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const baseline=path.join(root,'.native-input-p0/continuation-baseline');
const patches=parsePatch(readFileSync(path.join(baseline,'worktree.patch'),'utf8'));
const patch=patches.find(item=>item.newFileName==='b/src/types/index.ts');
assert(patch);
const head=execFileSync('git',['show','HEAD:src/types/index.ts'],{cwd:root,encoding:'utf8'});
const frozen=applyPatch(head,patch);
assert.equal(typeof frozen,'string');
const current=readFileSync(path.join(root,'src/types/index.ts'),'utf8');
const names=new Set(['TerminalCommandObservation','TerminalInputObservation','TerminalBrokerSessionSnapshot']);
function declarations(source) {
  const file=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  return new Map(file.statements.filter(statement=>ts.isInterfaceDeclaration(statement)&&names.has(statement.name.text))
    .map(statement=>[statement.name.text,statement.getText(file)]));
}
const left=declarations(frozen),right=declarations(current);
assert.equal(left.size,3);
for(const [name,value] of left) assert.equal(right.get(name),value,`P1 declaration changed: ${name}`);
const ipcPath='src/lib/ipc/tauri.ts';
const ipcPatch=patches.find(item=>item.newFileName===`b/${ipcPath}`);assert(ipcPatch);
const ipcHead=execFileSync('git',['show',`HEAD:${ipcPath}`],{cwd:root,encoding:'utf8'});
const ipcFrozen=applyPatch(ipcHead,ipcPatch);assert.equal(typeof ipcFrozen,'string');
const ipcCurrent=readFileSync(path.join(root,ipcPath),'utf8');
function observationFunction(source) {
  const file=ts.createSourceFile('tauri.ts',source,ts.ScriptTarget.Latest,true);
  const declaration=file.statements.find(statement=>ts.isFunctionDeclaration(statement)&&
    statement.name?.text==='invokeGetTerminalBrokerSnapshot');
  assert(declaration);return declaration.getText(file);
}
assert.equal(observationFunction(ipcCurrent),observationFunction(ipcFrozen),'P1 typed observation adapter changed');
const sha=value=>createHash('sha256').update(value).digest('hex');
const result={result:'PASS',p1Declarations:[...names],baselineWholeFileSha256:sha(frozen),
  currentWholeFileSha256:sha(current),wholeFileChangedOutsideP1:current!==frozen,
  ipcObservationFunction:'invokeGetTerminalBrokerSnapshot',ipcObservationPreserved:true,
  ipcWholeFileChangedOutsideP1:ipcCurrent!==ipcFrozen};
writeFileSync(path.join(root,'.native-input-p0/p1-preservation-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
