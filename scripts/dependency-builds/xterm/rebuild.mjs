// Rebuild using the pinned upstream TypeScript/webpack/esbuild workflow.
// Only pnpm patch-commit writes the dependency patch/installation (--record).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const args=process.argv.slice(2),record=args.includes('--record');
const pin=JSON.parse(readFileSync(path.join(root,'scripts/dependency-builds/xterm/build.json'),'utf8'));
const base=path.join(root,'src-tauri/target/dependencies/xterm/builds',new Date().toISOString().replaceAll(':','-'));
mkdirSync(base,{recursive:true});
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const run=(command,parameters,cwd,log,env={})=>{
  let executable=command,arguments_=parameters;
  if(process.platform==='win32'&&command==='pnpm'){
    const cli=process.env.npm_execpath;
    assert(cli&&/pnpm\.(?:mjs|cjs|js)$/.test(cli),'Run the Windows rebuild through pnpm check:xterm:rebuild');
    executable=process.execPath;arguments_=[cli,...parameters];
  }
  const result=spawnSync(executable,arguments_,{cwd,env:{...process.env,...env},encoding:'utf8',maxBuffer:32*1024*1024});
  writeFileSync(path.join(base,log),`${result.stdout??''}${result.stderr??''}\nexit=${result.status}\n`);
  if(result.status!==0)throw new Error(`${command} failed; see ${path.join(base,log)}`);
};
for(const[file,digest]of Object.entries(pin.patches))assert.equal(sha(path.join(root,file)),digest,`Approved source patch changed: ${file}`);
const toolsDir=path.join(root,'src-tauri/target/dependencies/xterm/tools');mkdirSync(toolsDir,{recursive:true});
for(const file of ['package.json','pnpm-lock.yaml'])copyFileSync(path.join(root,'scripts/dependency-builds/xterm',file),path.join(toolsDir,file));
run('pnpm',['install','--dir',toolsDir,'--frozen-lockfile','--ignore-workspace','--ignore-scripts'],root,'tools-install.log');
const toolsRequire=createRequire(path.join(toolsDir,'package.json'));
const esbuildPackage=toolsRequire.resolve('esbuild/package.json');
const esbuildRequire=createRequire(esbuildPackage);
const binary=esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform==='win32'?'esbuild.exe':'bin/esbuild'}`);
const npmPackage=toolsRequire.resolve('npm/package.json');
const npmMetadata=JSON.parse(readFileSync(npmPackage,'utf8'));
assert.equal(npmMetadata.version,pin.npm);
const npmCli=path.resolve(path.dirname(npmPackage),npmMetadata.bin.npm);
const cachedArchive=path.join(root,'artifacts/tests/native-input/prototype/formal-xterm-upstream/source.tar.gz');
const archive=path.join(base,'source.tar.gz');
if(existsSync(cachedArchive)&&sha(cachedArchive)===pin.archiveSha256)copyFileSync(cachedArchive,archive);
else{const response=await fetch(pin.archiveUrl);if(!response.ok)throw new Error(`Archive HTTP ${response.status}`);writeFileSync(archive,new Uint8Array(await response.arrayBuffer()));}
assert.equal(sha(archive),pin.archiveSha256,'Upstream source archive changed');
if(args.includes('--prepared-source'))throw new Error('Maintained rebuilds require a fresh pinned source archive');
// External build roots prevent a parent's @xterm declarations from entering tsc.
const source=mkdtempSync(path.join(tmpdir(),'shellspan-xterm-6.0.0-'));
run('tar',['-xzf',archive,'--strip-components=1','-C',source],root,'extract.log');
const patchCommand=process.env.SHELLSPAN_XTERM_PATCH??'patch';
for(const file of Object.keys(pin.patches))run(patchCommand,['--batch','--fuzz=0','-p1','-i',path.join(root,file)],source,`${path.basename(file)}.log`);
assert.equal(sha(path.join(source,'package-lock.json')),pin.upstreamLockSha256,'Upstream lock differs');
const upstreamPackage=JSON.parse(readFileSync(path.join(source,'package.json'),'utf8'));
assert.equal(upstreamPackage.version,pin.version);assert.equal(upstreamPackage.name,'@xterm/xterm');
run(process.execPath,[npmCli,'ci','--ignore-scripts','--no-audit','--no-fund'],source,'upstream-install.log');
const upstreamRequire=createRequire(path.join(source,'package.json'));
for(const name of ['typescript','webpack','esbuild'])assert.equal(upstreamRequire(`${name}/package.json`).version,pin[name]);
// Upstream's lock omits esbuild platform records/integrity. Use a separately
// pnpm-locked official binary, and verify its JS bridge equals the pinned tool.
assert.equal(sha(upstreamRequire.resolve('esbuild/lib/main.js')),sha(toolsRequire.resolve('esbuild/lib/main.js')),'esbuild JS bridge differs');
const env={ESBUILD_BINARY_PATH:binary};
run(process.execPath,[npmCli,'run','build'],source,'typescript.log',env);
run(process.execPath,[path.join(source,'node_modules/webpack-cli/bin/cli.js'),'--config','webpack.config.js'],source,'umd.log',env);
run(process.execPath,['bin/esbuild.mjs','--prod'],source,'esm.log',env);
const files=[...pin.sourceFiles,...pin.runtimeFiles];
const artifacts=Object.fromEntries(files.map(file=>[file,sha(path.join(source,file))]));
const manifest={...pin,node:process.version,buildRoot:source,reusedPreparedInstall:false,patchCommand,
  toolsLockSha256:sha(path.join(toolsDir,'pnpm-lock.yaml')),esbuildBinarySha256:sha(binary),artifacts,
  commands:['npm ci --ignore-scripts','npm run build','webpack --config webpack.config.js','node bin/esbuild.mjs --prod'],record};
writeFileSync(path.join(base,'manifest.json'),JSON.stringify(manifest,null,2));
if(record){
  const edit=path.join(base,'package');
  run('pnpm',['patch',`@xterm/xterm@${pin.version}`,'--ignore-existing','--edit-dir',edit],root,'patch-prepare.log');
  for(const file of files)copyFileSync(path.join(source,file),path.join(edit,file));
  // Retain context for pnpm's insertion matching, while emitting blank context
  // lines without trailing spaces in the recorded unified diff.
  run('pnpm',['patch-commit',edit],root,'patch-commit.log',{
    GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'diff.suppressBlankEmpty',GIT_CONFIG_VALUE_0:'true'
  });
  writeFileSync(path.join(root,'scripts/dependency-builds/xterm/artifacts.json'),JSON.stringify({
    version:pin.version,commit:pin.commit,archiveSha256:pin.archiveSha256,upstreamLockSha256:pin.upstreamLockSha256,
    node:process.version,npm:pin.npm,typescript:pin.typescript,webpack:pin.webpack,esbuild:pin.esbuild,
    toolsLockSha256:manifest.toolsLockSha256,esbuildBinarySha256:manifest.esbuildBinarySha256,artifacts,
    generatedBy:'node scripts/dependency-builds/xterm/rebuild.mjs --record'
  },null,2)+'\n');
}else{
  const installed=path.join(root,'node_modules/@xterm/xterm');
  for(const file of files)assert.equal(sha(path.join(installed,file)),artifacts[file],`Installed package differs from reproducible build: ${file}`);
}
console.log(`xterm ${record?'patch recorded':'rebuild verified'}: ${path.join(base,'manifest.json')}`);
