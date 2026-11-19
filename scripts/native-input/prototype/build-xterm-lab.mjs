// Explicitly authorized isolated dependency experiment. Never edits node_modules
// or the production lockfile; no command/source/lease metadata enters the patch.
import {cpSync,mkdirSync,readFileSync,writeFileSync,realpathSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const source=realpathSync(process.env.SHELLSPAN_P0_ORIGINAL_PACKAGE??path.join(root,'node_modules/@xterm/xterm'));
const copyFix=process.argv.includes('--copy-fix');
const out=path.join(root,copyFix?'artifacts/tests/native-input/prototype/xterm-copy-lab':'artifacts/tests/native-input/prototype/xterm-reflow-lab');
const baseline=process.argv.includes('--baseline');
mkdirSync(out,{recursive:true});
const copy=path.join(out,baseline?'source-baseline-copy':'source-copy');
const sourceDigest=createHash('sha256').update(readFileSync(path.join(source,'src/common/buffer/Buffer.ts'))).digest('hex');
if(sourceDigest!=='7d48cc12cf3c32b9cac1b6f6cfcee01215a1edb66e0dab48ceb3f87d9c25b422')
  throw new Error('Frozen xterm 6.0.0 source changed; refuse to apply this lab patch');
if(copyFix)for(const [name,expected]of [
  ['src/browser/services/SelectionService.ts','0bd2c55a0119dd91549b5d62778c649ec45f3c8aecf160be6324e5e2590a3d7c'],
  ['src/common/buffer/BufferReflow.ts','becf26872f7e9ed8be04018106959a27e7393412416a439f9b3ae535aa3f4585']
])if(createHash('sha256').update(readFileSync(path.join(source,name))).digest('hex')!==expected)
  throw new Error(`Frozen copy source changed: ${name}`);
cpSync(source,copy,{recursive:true,dereference:true});
if(lstatSync(copy).isSymbolicLink()) throw new Error('Lab source must be a separate regular directory');
const dependencies=path.join(out,'dependencies');
mkdirSync(dependencies,{recursive:true});
cpSync(path.join(root,'scripts/native-input/prototype/xterm-lab-dependencies.json'),path.join(dependencies,'package.json'));
function run(command,args,cwd) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8'});
  if(result.status!==0)throw new Error(`${command} exit ${result.status}: ${result.stderr}\n${result.stdout}`);
}
run('pnpm',['install','--ignore-workspace','--ignore-scripts'],dependencies);
const patch=path.join(root,'scripts/native-input/prototype/xterm-cursor-reflow.patch');
const copyPatch=path.join(root,'scripts/native-input/prototype/xterm-copy-serialization.patch');
if(!baseline||copyFix) run('patch',['--batch','-p1','-i',patch],copy);
if(copyFix&&!baseline) run('patch',['--batch','-p1','-i',copyPatch],copy);
const require=createRequire(path.join(dependencies,'package.json'));
const esbuild=require('esbuild');
await esbuild.build({entryPoints:[path.join(copy,'src/browser/public/Terminal.ts')],bundle:true,
  outfile:path.join(out,baseline?'xterm-baseline.js':'xterm.js'),format:'iife',globalName:'XtermP0',target:'es2020',
  alias:{browser:path.join(copy,'src/browser'),common:path.join(copy,'src/common'),vs:path.join(copy,'src/vs')},
  tsconfigRaw:{compilerOptions:{experimentalDecorators:true,useDefineForClassFields:false}},
  footer:{js:'globalThis.Terminal=XtermP0.Terminal;'},logLevel:'silent'});
const sha=filename=>createHash('sha256').update(readFileSync(filename)).digest('hex');
writeFileSync(path.join(out,baseline?'baseline-manifest.json':'manifest.json'),JSON.stringify({
  originalPackage:JSON.parse(readFileSync(path.join(source,'package.json'))).version,
  originalBufferSha256:sha(path.join(source,'src/common/buffer/Buffer.ts')),
  patchSha256:baseline&&!copyFix?null:sha(patch),patchedBufferSha256:sha(path.join(copy,'src/common/buffer/Buffer.ts')),
  copyPatchSha256:copyFix&&!baseline?sha(copyPatch):null,
  originalSelectionSha256:sha(path.join(source,'src/browser/services/SelectionService.ts')),
  selectionSha256:sha(path.join(copy,'src/browser/services/SelectionService.ts')),
  bundleSha256:sha(path.join(out,baseline?'xterm-baseline.js':'xterm.js')),esbuild:esbuild.version,
  authorization:copyFix?'isolated generic cursor/copy dependency experiment; no formal adoption or production change':
    'isolated generic terminal dependency cursor-reflow experiment; no production change'
},null,2));
console.log(out);
