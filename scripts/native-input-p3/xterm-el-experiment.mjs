// Isolated dependency research only. Never records a package patch or changes
// the project's dependency installation, Unicode provider or approved pin.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const owner=resolve(import.meta.dirname,'../..'),action=process.argv[2];
assert(['prepare','build'].includes(action));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const pin=JSON.parse(readFileSync(resolve(owner,'scripts/dependency-builds/xterm/build.json'),'utf8'));
function run(command,args,cwd,log,environment={}){try{const output=execFileSync(command,args,{cwd,env:{...process.env,...environment},encoding:'utf8',maxBuffer:32*1024*1024});writeFileSync(log,output);}catch(error){writeFileSync(log,String(error.stdout??'')+String(error.stderr??''));throw new Error('Isolated upstream dependency build failed; inspect its retained build log');}}
if(action==='prepare'){
 const id=randomUUID(),directory=resolve(owner,'.native-input-p3/xterm-el-experiment',id);mkdirSync(directory,{recursive:true});
 const archive=resolve(owner,'.native-input-p0/formal-xterm-upstream/source.tar.gz');assert.equal(hash(archive),pin.archiveSha256);
 const source=mkdtempSync(join(tmpdir(),'shellspan-p3-xterm-el-'));
 run('tar',['-xzf',archive,'--strip-components=1','-C',source],owner,resolve(directory,'extract.log'));
 for(const[path,expected]of Object.entries(pin.patches)){assert.equal(hash(resolve(owner,path)),expected);run('patch',['--batch','--fuzz=0','-p1','-i',resolve(owner,path)],source,resolve(directory,`${path.split('/').at(-1)}.log`));}
 assert.equal(hash(resolve(source,'package-lock.json')),pin.upstreamLockSha256);
 const tools=resolve(owner,'.native-input-p0/xterm-build-tools'),require=createRequire(resolve(tools,'package.json'));
 const npmPackage=require.resolve('npm/package.json'),npm=JSON.parse(readFileSync(npmPackage));assert.equal(npm.version,pin.npm);
 const npmCli=resolve(dirname(npmPackage),npm.bin.npm);
 run(process.execPath,[npmCli,'ci','--ignore-scripts','--no-audit','--no-fund'],source,resolve(directory,'upstream-install.log'));
 const metadata={id,directory,source,pin,npmCli,approvedInputHandlerSha256:hash(resolve(source,'src/common/InputHandler.ts')),nativeAcceptance:false,formalPatchChanged:false};
 writeFileSync(resolve(directory,'experiment.json'),JSON.stringify(metadata,null,2));console.log(JSON.stringify(metadata));
}else{
 const metadata=JSON.parse(readFileSync(process.argv[3],'utf8')),source=metadata.source,directory=metadata.directory;
 assert(source.startsWith(join(tmpdir(),'shellspan-p3-xterm-el-'))&&directory.startsWith(resolve(owner,'.native-input-p3/xterm-el-experiment')+'/'));
 const require=createRequire(resolve(source,'package.json'));
 for(const name of['typescript','webpack','esbuild'])assert.equal(require(`${name}/package.json`).version,pin[name]);
 const tools=createRequire(resolve(owner,'.native-input-p0/xterm-build-tools/package.json'));
 const esbuildPackage=tools.resolve('esbuild/package.json'),esbuildRequire=createRequire(esbuildPackage);
 const binary=esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
 const environment={ESBUILD_BINARY_PATH:binary};
 assert.equal(hash(require.resolve('esbuild/lib/main.js')),hash(tools.resolve('esbuild/lib/main.js')));
 const inputHandler=resolve(source,'src/common/InputHandler.ts');assert.notEqual(hash(inputHandler),metadata.approvedInputHandlerSha256,'Apply the explicit isolated edit through the file-editing tool first');
 copyFileSync(inputHandler,resolve(directory,'InputHandler.ts'));
 run(process.execPath,[metadata.npmCli,'run','build'],source,resolve(directory,'typescript.log'),environment);
 run(process.execPath,[resolve(source,'node_modules/webpack-cli/bin/cli.js'),'--config','webpack.config.js'],source,resolve(directory,'umd.log'),environment);
 run(process.execPath,['bin/esbuild.mjs','--prod'],source,resolve(directory,'esm.log'),environment);
 const artifacts=Object.fromEntries([...pin.sourceFiles,'src/common/InputHandler.ts',...pin.runtimeFiles].map(path=>[path,hash(resolve(source,path))]));
 writeFileSync(resolve(directory,'result.json'),JSON.stringify({...metadata,inputHandlerSha256:hash(inputHandler),artifacts,nativeAcceptance:false,formalPatchChanged:false},null,2));
 console.log(JSON.stringify({directory,source,artifacts,nativeAcceptance:false,formalPatchChanged:false}));
}
