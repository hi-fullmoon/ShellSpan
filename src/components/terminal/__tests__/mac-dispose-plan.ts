import {quotePosixFileSource} from './native-file-chain-posix';

/** Actual ordinary printf producers. The full stdout marker is absent from
 * its command echo, so observation cannot mistake source text for execution. */
export function macDisposePlan(token:string){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token))throw Error('Exact owned dispose identity required');
 const prefix='P2_DISPOSE_'+token.slice(0,8)+'_',pending='PENDING_中_e\u0301_👩🏽‍💻';
 const enter="printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'";
 const marker=(suffix:string)=>`printf '%s%s\\n' ${quotePosixFileSource(prefix)} ${quotePosixFileSource(suffix)}`;
 const armed=enter+'; '+marker('ARMED'),queued=enter+'; '+marker(pending)+'; '+marker('AFTER_PENDING'),successor=marker('SUCCESSOR');
 return{prefix,enter,armed,queued,successor,armedLine:prefix+'ARMED\r\n',pendingLine:prefix+pending+'\r\n',pendingText:prefix+pending,successorLine:prefix+'SUCCESSOR\r\n',shellStdout:'\u001b]1337;SetUserVar=ShellSpanNativeInput=MQ==\u0007'+prefix+'ARMED\n'+'\u001b]1337;SetUserVar=ShellSpanNativeInput=MQ==\u0007'+prefix+pending+'\n'+prefix+'AFTER_PENDING\n'+prefix+'SUCCESSOR\n'};
}
