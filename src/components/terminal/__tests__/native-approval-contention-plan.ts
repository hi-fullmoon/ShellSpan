export function approvalContentionSources(token:string):Readonly<{owner:string;contender:string}>{
 if(!/^[a-f0-9-]{36}$/.test(token))throw Error('Owned contention token required');
 const file=(role:string)=>`(Join-Path $env:SHELLSPAN_LOCAL_HOME 'contention-${role}-${token}.txt')`;
 return {owner:`[IO.File]::AppendAllText(${file('owner')},'START'+[Environment]::NewLine); Start-Sleep -Seconds 10; [IO.File]::AppendAllText(${file('owner')},'END'+[Environment]::NewLine)`,contender:`[IO.File]::AppendAllText(${file('contender')},'ONCE'+[Environment]::NewLine)`};
}
export function matchesApprovalContentionArgs(value:unknown,source:string,owner:boolean):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const args=value as Record<string,unknown>;
 return Object.keys(args).every(key=>['command','background','timeoutMs','explanation'].includes(key))&&args.command===source&&(args.background===undefined||args.background===false)&&args.timeoutMs===(owner?30000:5000);
}
