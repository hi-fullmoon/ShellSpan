import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// git ls-files needs its repository headers to interpret a copied index. This
// read-only metadata has no refs or commit objects and registers no worktree.
export function createIndexReader(directory,indexSource,head){
  assert(/^[a-f0-9]{40}$/.test(head));
  const gitDirectory=resolve(directory,'git-reader');
  mkdirSync(resolve(gitDirectory,'objects'),{recursive:true});mkdirSync(resolve(gitDirectory,'refs'),{recursive:true});
  writeFileSync(resolve(gitDirectory,'HEAD'),`${head}\n`,{flag:'wx'});
  writeFileSync(resolve(gitDirectory,'config'),'[core]\nrepositoryformatversion = 0\nbare = true\n',{flag:'wx'});
  const index=resolve(directory,'frozen-git-index');copyFileSync(indexSource,index);
  return {gitDirectory,index};
}
