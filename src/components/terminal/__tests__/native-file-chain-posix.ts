import {isCurrentNativeEditorProfile} from './native-editor-profile';
import type {NativeFileChainPlan} from './native-file-chain-approval';

export const quotePosixFileSource=(value:string)=>"'"+value.split("'").join("'\\''")+"'";

type FileChainPeer=NonNullable<Parameters<typeof isCurrentNativeEditorProfile>[0]>&{editorNumericVersion?:number};
export function isMacFileChainProfile(profile:FileChainPeer|null|undefined,family:string|null):boolean{
 if(family==='zsh')return isCurrentNativeEditorProfile(profile,'zsh')&&profile?.verifiedProfileId==='zsh-5.9-zle-5.9-macos-arm64-native';
 if(family!=='bash'||profile?.shell!=='bash'||profile.editor!=='readline'||profile.adapterVersion!=='1')return false;
 // Match the existing native protocol contract. The pinned Bash 4.x archives
 // report Readline's compatibility string 5.1; the verified numeric ABI is 6/7.
 return [{shell:'4.1',editor:'6.0',numeric:0x0600},{shell:'4.4',editor:'7.0',numeric:0x0700},{shell:'5.3',editor:'8.3.6',numeric:0x0803}]
  .some(({shell,editor,numeric})=>profile.shellVersion?.startsWith(shell+'.')&&profile.editorNumericVersion===numeric
   &&(numeric===0x0803?profile.editorVersion?.startsWith('8.3'):profile.editorVersion==='5.1')
   &&profile.verifiedProfileId===`gnu-bash-${shell}-readline-${editor}-macos-arm64-native`);
}

export function macFileChainPlan(token:string,cwd:string):NativeFileChainPlan{
 if(!/^[0-9a-f-]{36}$/.test(token)||!cwd.startsWith('/')||cwd.includes('\0'))throw Error('Actual owned POSIX file chain identity missing');
 return{
  fileName:`acceptance-${token}.sh`,
  setup:"export NATIVE_FILE_PARENT=PARENT; NativeFileParentFn() { printf %s FN; }; printf '%s\\n' B08_SETUP_READY",
  content:`[ "$NATIVE_FILE_PARENT" = PARENT ] || return 91; [ "$(NativeFileParentFn)" = FN ] || return 92; [ "$PWD" = ${quotePosixFileSource(cwd)} ] || return 93; printf '%s\\n' ONCE >> "$SHELLSPAN_LOCAL_HOME/scratch-effect-${token}.txt"; printf '%s\\n' NATIVE_FILE_OK`,
 };
}
