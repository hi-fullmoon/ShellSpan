export function nativeUserDraftEofPlan(token: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)) throw Error('Owned draft EOF identity required');
  const release = `release-user-eof-${token}.txt`, marker = `effect-user-draft-${token}.txt`, prefix = `USER_EOF_DRAFT_${token}`;
  // The worker only disposes the real managed stream. It never invokes PowerShell,
  // calls the native ABI, writes control frames, or submits the editor buffer.
  const helper = 'using System; using System.IO; using System.Threading; using System.Diagnostics; public static class ShellSpanOwnedDraftEof { public static void Arm(IDisposable pipe,string gate) { if(pipe==null)throw new ArgumentNullException("pipe"); var thread=new Thread(new ThreadStart(delegate { var deadline=Stopwatch.StartNew(); while(!File.Exists(gate)&&deadline.ElapsedMilliseconds<30000)Thread.Sleep(10); if(File.Exists(gate))pipe.Dispose(); })); thread.IsBackground=true; thread.Start(); } }';
  const setup = `Add-Type -TypeDefinition '${helper}'; & $global:__shellspanModule { [ShellSpanOwnedDraftEof]::Arm($script:PrivatePipe,(Join-Path $env:SHELLSPAN_LOCAL_HOME '${release}')) }; Write-Output (('DRAFT_EOF_'+'ARMED:')+$PID)`;
  const draft = `$null='${prefix}'; [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME '${marker}'),'EXPLICIT_ENTER'+[Environment]::NewLine)`;
  return { release, marker, prefix, setup, draft };
}
