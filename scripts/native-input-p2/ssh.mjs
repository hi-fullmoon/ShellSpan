import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import {bashProfileId,BASH_READLINE_VERSIONS} from './bash-profiles.mjs';

const root=resolve(import.meta.dirname,'../..');
const configuration=`Port 22229\nListenAddress 0.0.0.0\nHostKey /tmp/nip-sshd/host_key\nPidFile /tmp/nip-sshd/pid\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nAllowUsers native41* native44* native53* nativeRaw\nSubsystem sftp internal-sftp\nSetEnv LANG=en_US.UTF-8\nPrintMotd no\nLogLevel ERROR\n`;
const target='linux-aarch64-glibc-2.36';
const resources=resolve(root,'.artifacts/tests/native-input-p2/resources/native-input');
const users={'4.1':'native41','4.4':'native44','5.3':'native53'};
function readProfiles(){
  const catalogue=JSON.parse(readFileSync(resolve(resources,`catalogue-${target}.json`),'utf8'));
  const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(catalogue.version,1);
  assert(catalogue.profiles.length>0&&new Set(catalogue.profiles.map(profile=>profile.bashVersion)).size===catalogue.profiles.length);
  for(const[path,expected]of Object.entries(catalogue.sources))assert.equal(sha(resolve(root,path)),expected,`Stale fixture source: ${path}`);
  for(const profile of catalogue.profiles){
    assert(Object.hasOwn(BASH_READLINE_VERSIONS,profile.bashVersion));
    assert.equal(profile.id,bashProfileId(profile.bashVersion,target));
    assert.equal(profile.readlineDisplayAbi,1);
    assert.equal(profile.module,`${profile.id}/adapter.so`);assert.equal(profile.relay,`${profile.id}/native-input-relay`);
    for(const[path,expected]of[[`${profile.id}/bash`,profile.shellSha256],[profile.module,profile.moduleSha256],[profile.relay,profile.relaySha256]])assert.equal(sha(resolve(resources,path)),expected,`Fixture artifact changed: ${path}`);
  }
  return catalogue.profiles;
}
function bindBuiltShells(container,profiles){
  for(const profile of profiles){
    assert.equal(execFileSync('docker',['exec',container,'sha256sum',profile.buildShell],{encoding:'utf8'}),`${profile.shellSha256}  ${profile.buildShell}\n`);
    execFileSync('docker',['exec',container,'usermod','-s',profile.buildShell,users[profile.bashVersion]],{stdio:'pipe'});
  }
}
if(process.argv[2]==='--from-resources'){
  const image=process.argv[3];assert(/^sha256:[a-f0-9]{64}$/.test(image),'An immutable owned fixture image is required');
  const profiles=readProfiles();
  const id=randomUUID(),directory=resolve(root,'.artifacts/tests/native-input-p2/ssh',id),container=`shellspan-nip-p2-${id}`;
  mkdirSync(directory,{recursive:true,mode:0o700});
  writeFileSync(resolve(directory,'owner.json'),JSON.stringify({id,container,image,root,directory},null,2),{mode:0o600});
  execFileSync('docker',['run','-d','--name',container,'--label',`shellspan.native-input-p2=${id}`,
    '-p','127.0.0.1::22229','-v',`${root}:/work`,image,'sleep','infinity'],{stdio:'pipe'});
  execFileSync('docker',['exec',container,'mkdir','-p','/opt/shellspan-native-gnu','/tmp/nip-sshd']);
  const shells={};
  for(const profile of profiles){
    const destination=`/opt/shellspan-native-gnu/${profile.id}`,path=`${destination}/bash`;
    execFileSync('docker',['exec',container,'mkdir','-p',destination]);
    execFileSync('docker',['cp',resolve(resources,profile.id,'bash'),`${container}:${path}`]);
    execFileSync('docker',['exec',container,'chmod','755',path]);
    assert.equal(execFileSync('docker',['exec',container,'sha256sum',path],{encoding:'utf8'}),`${profile.shellSha256}  ${path}\n`);
    const user=users[profile.bashVersion];
    execFileSync('docker',['exec',container,'usermod','-s',path,user]);
    shells[profile.bashVersion]={path,sha256:profile.shellSha256,user};
  }
  writeFileSync(resolve(directory,'sshd_config'),configuration,{mode:0o600});
  execFileSync('docker',['exec',container,'ssh-keygen','-q','-t','ed25519','-N','','-f','/tmp/nip-sshd/host_key']);
  execFileSync('docker',['cp',resolve(directory,'sshd_config'),`${container}:/tmp/nip-sshd/sshd_config`]);
  execFileSync('docker',['cp',resolve(import.meta.dirname,'system-profile-audit.sh'),`${container}:/etc/profile.d/shellspan-p2-audit.sh`]);
  execFileSync('docker',['exec',container,'/usr/sbin/sshd','-D','-e','-t','-f','/tmp/nip-sshd/sshd_config']);
  execFileSync('docker',['exec','-d',container,'/usr/sbin/sshd','-D','-e','-f','/tmp/nip-sshd/sshd_config']);
  const ports=JSON.parse(execFileSync('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',container],{encoding:'utf8'}));
  const fixture={container,port:Number(ports['22229/tcp'][0].HostPort),host:'127.0.0.1',users:Object.values(shells).map(shell=>shell.user),image,directory,shells,
    scope:'New loopback fixture from source-matching verified GNU resources; no rebuild or acceptance claim'};
  writeFileSync(resolve(directory,'fixture.json'),JSON.stringify(fixture,null,2),{mode:0o600});
  console.log(resolve(directory,'fixture.json'));
}else if(process.argv[2]==='--stop'||process.argv[2]==='--refresh'){
  const fixture=JSON.parse(readFileSync(resolve(process.argv[3]),'utf8'));
  assert(/^shellspan-nip-p2-[a-f0-9-]{36}$/.test(fixture.container));
  const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspan.native-input-p2"}}',fixture.container],{encoding:'utf8'}).trim();
  assert(fixture.container===`shellspan-nip-p2-${label}`);
  if(process.argv[2]==='--stop')execFileSync('docker',['rm','-f',fixture.container],{stdio:'ignore'});
  else{
    assert(resolve(fixture.directory).startsWith(resolve(root,'.artifacts/tests/native-input-p2/ssh')+'/'));
    const profiles=readProfiles();
    writeFileSync(resolve(fixture.directory,'sshd_config'),configuration,{mode:0o600});
    execFileSync('docker',['exec',fixture.container,'/usr/sbin/sshd','-t','-f',`/work/.artifacts/tests/native-input-p2/ssh/${label}/sshd_config`]);
    const pid=execFileSync('docker',['exec',fixture.container,'cat','/tmp/nip-sshd/pid'],{encoding:'utf8'}).trim();assert(/^\d+$/.test(pid));
    execFileSync('docker',['exec',fixture.container,'kill','-HUP',pid]);
    execFileSync('docker',['cp',resolve(import.meta.dirname,'system-profile-audit.sh'),`${fixture.container}:/etc/profile.d/shellspan-p2-audit.sh`]);
    try{execFileSync('docker',['exec',fixture.container,'getent','passwd','nativeRaw'],{stdio:'ignore'});}catch(error){
      assert.equal(error.status,2);
      execFileSync('docker',['exec',fixture.container,'useradd','-m','-s','/bin/bash','nativeRaw']);
    }
    bindBuiltShells(fixture.container,profiles);
  }
}else{
  const id=randomUUID();
  const directory=resolve(root,'.artifacts/tests/native-input-p2/ssh',id);
  mkdirSync(directory,{recursive:true,mode:0o700});
  mkdirSync(resolve(root,'.artifacts/tests/native-input-p2/cargo-registry'),{recursive:true});
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  const container=`shellspan-nip-p2-${id}`;
  execFileSync('docker',['run','-d','--name',container,'--label',`shellspan.native-input-p2=${id}`,
    '-p',`127.0.0.1:${port}:22229`,'-v',`${root}:/work`,'-v',`${resolve(root,'.artifacts/tests/native-input-p2/cargo-registry')}:/usr/local/cargo/registry`,
    'shellspan-native-input-p2:local','sleep','infinity'],{stdio:'pipe'});
  const log=openSync(resolve(directory,'build.log'),'wx',0o600);
  const build=spawn('docker',['exec',container,'python3','scripts/native-input-p2/build.py'],{stdio:['ignore',log,log]});
  const code=await new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',resolve);});
  closeSync(log);
  writeFileSync(resolve(directory,'build-result.json'),JSON.stringify({exitCode:code}));
  assert.equal(code,0,`Linux build failed; evidence at ${directory}`);
  const profiles=readProfiles();
  bindBuiltShells(container,profiles);
  writeFileSync(resolve(directory,'sshd_config'),configuration,{mode:0o600});
  execFileSync('docker',['exec',container,'mkdir','-m','700','/tmp/nip-sshd']);
  execFileSync('docker',['exec',container,'ssh-keygen','-q','-t','ed25519','-N','','-f','/tmp/nip-sshd/host_key']);
  execFileSync('docker',['cp',resolve(import.meta.dirname,'system-profile-audit.sh'),`${container}:/etc/profile.d/shellspan-p2-audit.sh`]);
  const path=`/work/.artifacts/tests/native-input-p2/ssh/${id}/sshd_config`;
  execFileSync('docker',['exec','-d',container,'/usr/sbin/sshd','-D','-e','-f',path]);
  const fixture={container,port,host:'127.0.0.1',users:profiles.map(profile=>users[profile.bashVersion]),image:'shellspan-native-input-p2:local',directory};
  writeFileSync(resolve(directory,'fixture.json'),JSON.stringify(fixture,null,2),{mode:0o600});
  console.log(resolve(directory,'fixture.json'));
}
