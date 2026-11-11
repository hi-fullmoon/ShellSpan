param([Parameter(Mandatory=$true)][string]$GateSource)
$ErrorActionPreference='Stop'
$controls=@'
public static class ForegroundGateControls {
 public static void Run() {
  var expected = new IntPtr(100); long time = 0; int reads = 0;
  if (!ShellSpanForegroundGate.Wait(expected,1500,
      () => ++reads < 3 ? new IntPtr(200) : expected,
      () => time, value => time += value)) throw new Exception("Delayed real ownership was refused");
  if (reads != 3 || time != 40) throw new Exception("Ownership observations were not bounded/ordered");
  time = 0; reads = 0;
  if (ShellSpanForegroundGate.Wait(expected,1500,
      () => { reads++; return new IntPtr(200); },
      () => time, value => time += value)) throw new Exception("Foreign foreground was accepted");
  if (time != 1500 || reads != 76) throw new Exception("Original bounded gate expired incorrectly");
  bool invalid = false;
  try { ShellSpanForegroundGate.Wait(IntPtr.Zero,1500,() => expected,() => 0,value => {}); }
  catch (ArgumentException) { invalid = true; }
  if (!invalid) throw new Exception("An unowned window was accepted");
  invalid = false;
  try { ShellSpanForegroundGate.Wait(expected,1501,() => expected,() => 0,value => {}); }
  catch (ArgumentException) { invalid = true; }
  if (!invalid) throw new Exception("An extended gate deadline was accepted");
  time = 1501;
  if (ShellSpanForegroundGate.Wait(expected,1500,() => expected,() => time,value => {}))
   throw new Exception("A late foreground match was accepted after the original gate budget");
 }
}
'@
Add-Type -TypeDefinition ([IO.File]::ReadAllText($GateSource)+[Environment]::NewLine+$controls)
[ForegroundGateControls]::Run()
