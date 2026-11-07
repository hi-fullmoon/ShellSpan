import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {quotePosixFileSource,isMacFileChainProfile} from './native-file-chain-posix';
import capturedProfiles from './fixtures/native-file-gnu-profiles.json';

it.skipIf(process.platform==='win32')('preserves an absolute source path with quotes, spaces, Unicode and shell metacharacters in the real POSIX shell',()=>{
 const path="/owned/中文 ' $(printf unintended) ; script.sh";
 expect(execFileSync('/bin/sh',['-c',`printf %s ${quotePosixFileSource(path)}`],{encoding:'utf8'})).toBe(path);
});
it('accepts the three actual captured GNU profiles with their full Shell versions and verified numeric Readline ABIs',()=>{
 expect(capturedProfiles.captures).toHaveLength(3);
 for(const {profile} of capturedProfiles.captures){
  expect(isMacFileChainProfile(profile,'bash')).toBe(true);
  expect(isMacFileChainProfile({...profile,editorVersion:'unknown'},'bash')).toBe(false);
  expect(isMacFileChainProfile({...profile,editorNumericVersion:0},'bash')).toBe(false);
  expect(isMacFileChainProfile({...profile,shellVersion:'unsupported'},'bash')).toBe(false);
  expect(isMacFileChainProfile({...profile,verifiedProfileId:profile.verifiedProfileId.replace('macos-arm64','linux-aarch64')},'bash')).toBe(false);
  expect(isMacFileChainProfile(profile,'zsh')).toBe(false);
 }
});
