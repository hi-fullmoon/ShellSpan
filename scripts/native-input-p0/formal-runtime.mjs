import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import YAML from 'yaml';

export const formalRuntime=process.env.SHELLSPAN_P0_FORMAL_XTERM==='1';
export const originalRuntime=process.env.SHELLSPAN_P0_ORIGINAL_XTERM??'.artifacts/tests/native-input-p0/formal-adoption-baseline/original-xterm/lib/xterm.js';
export const candidateRuntime=lab=>formalRuntime?'node_modules/@xterm/xterm/lib/xterm.js':lab;
export async function displayModuleJavaScript(){
  const source=await readFile('src/lib/terminal/native-input-display.ts','utf8');
  return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
}
export async function installedRuntimeManifest(){
  const directory=await realpath('node_modules/@xterm/xterm');
  const expected=JSON.parse(await readFile('scripts/dependency-builds/xterm/artifacts.json','utf8'));
  const pkg=JSON.parse(await readFile(`${directory}/package.json`,'utf8'));
  assert.equal(pkg.version,expected.version);
  const digests={};
  for(const[name,digest]of Object.entries(expected.artifacts)){
    digests[name]=createHash('sha256').update(await readFile(`${directory}/${name}`)).digest('hex');
    assert.equal(digests[name],digest,`Formal installed artifact differs: ${name}`);
  }
  const workspace=YAML.parse(await readFile('pnpm-workspace.yaml','utf8'));
  const lock=YAML.parse(await readFile('pnpm-lock.yaml','utf8'));
  const key=`@xterm/xterm@${expected.version}`,patch=workspace.patchedDependencies[key];
  const patchHash=lock.patchedDependencies[key];assert.equal(typeof patchHash,'string');
  assert.equal(lock.importers['.'].dependencies['@xterm/xterm'].specifier,expected.version);
  assert(lock.importers['.'].dependencies['@xterm/xterm'].version.includes(`patch_hash=${patchHash}`));
  return {kind:'formally installed pnpm package',directory,version:pkg.version,
    patch,patchHash,
    patchSha256:createHash('sha256').update(await readFile(patch)).digest('hex'),artifacts:digests};
}
