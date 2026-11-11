import {quotePosixFileSource} from './native-file-chain-posix';
export function macEofPlan(token:string){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token))throw Error('Exact owned EOF identity required');
 const prefix='P2_EOF_'+token.slice(0,8)+'_',tailValue='TAIL_中文_e\u0301_👩🏽‍💻';
 const enter="printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'",exit="printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MA==\\007'";
 const marker=(suffix:string)=>`printf '%s%s\\n' ${quotePosixFileSource(prefix)} ${quotePosixFileSource(suffix)}`;
 const partial='\u001b]0;P2_EOF_PARTIAL_'+token.slice(0,8);
 const handler=marker(tailValue)+`; printf '\\033]0;P2_EOF_PARTIAL_${token.slice(0,8)}'; exit 0`;
 const setup=`trap ${quotePosixFileSource(handler)} HUP TERM; ${enter}; ${marker('ARMED')}`;
 const natural=`${enter}; ${marker('NATURAL')}; exec /usr/bin/printf '\\342\\202'`;
 const privateClose=(family:'zsh'|'bash')=>`${family==='zsh'?'builtin ss_nip close':'builtin enable -d ss_native_input'}; printf '%s%s%d\\n' ${quotePosixFileSource(prefix)} PRIVATE_CLOSE_STATUS_ "$?"; ${marker('PRIVATE_CLOSED')}`;
 return{prefix,enter,exit,marker,setup,natural,privateClose,partial,armed:prefix+'ARMED\r\n',tail:prefix+tailValue+'\r\n',naturalMarker:prefix+'NATURAL\r\n',cancelSource:`printf '%s' SHOULD_NOT_EXECUTE > "$HOME/phase2-eof-cancel-${token}"`,nonPtyHupExpected:'\u001b]1337;SetUserVar=ShellSpanNativeInput=MQ==\u0007'+prefix+'ARMED\n'+prefix+tailValue+'\n'+partial};
}
