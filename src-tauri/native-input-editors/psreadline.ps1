# Parameters are injected by the trusted startup loader, after user profiles.
# Native callbacks return an execution plan to ConsoleHost; source is never
# evaluated inside a widget, this module, or the ReadLine wrapper.
param([string]$Library,[string]$PipeName,[string]$ProfileJson,[string]$TransportSource,[uint32]$ExpectedClientPid,[string]$ExpectedEditorHash,[string]$JobHelpersPath,[string]$JobHostPath,[string]$ConsoleSignalPath,[string]$HostReferencePath)
if($null-ne (Microsoft.PowerShell.Utility\Get-Variable -Name __shellspanModule -Scope Global -ErrorAction Ignore)){throw 'TERMINAL_NATIVE_PRIVATE_BINDING_UNAVAILABLE'}
# -File imports can be visible to this caller without being exported globally.
# Capture the real command here; do not force a global module import or invent
# a reader when the user's command resolution does not provide the upstream one.
$__shellspanNipReadLine=Microsoft.PowerShell.Core\Get-Command PSConsoleHostReadLine -ErrorAction Ignore
if($null -eq $__shellspanNipReadLine -or $__shellspanNipReadLine.CommandType -ne [Management.Automation.CommandTypes]::Function -or $__shellspanNipReadLine.Source -cne 'PSReadLine'){throw 'TERMINAL_NATIVE_CUSTOM_HOST_UNSUPPORTED'}
$__shellspanNipModule = New-Module -Name ShellSpanTerminalIntegration -ArgumentList $Library,$PipeName,$ProfileJson,$TransportSource,$ExpectedClientPid,$ExpectedEditorHash,$JobHelpersPath,$JobHostPath,$ConsoleSignalPath,$HostReferencePath,$__shellspanNipReadLine -ScriptBlock {
  param($Library,$PipeName,$ProfileJson,$TransportSource,$ExpectedClientPid,$ExpectedEditorHash,$JobHelpersPath,$JobHostPath,$ConsoleSignalPath,$HostReferencePath,$ReadLineCandidate)
  $Expected=Microsoft.PowerShell.Utility\ConvertFrom-Json $ProfileJson
  $Loaded=Microsoft.PowerShell.Core\Get-Module PSReadLine
  $Assembly=[Microsoft.PowerShell.PSConsoleReadLine].Assembly
  if($ExpectedEditorHash.Length -ne 64 -or (Microsoft.PowerShell.Utility\Get-FileHash $Assembly.Location -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedEditorHash -or $Loaded.Version.ToString() -cne $Expected.editorVersion -or $PSVersionTable.PSVersion.ToString() -cne $Expected.shellVersion -or $Host.Name -cne 'ConsoleHost'){
    throw 'TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH'
  }
  # This independent module scope still sees an existing global user override.
  # Refuse it even when the startup script has a scoped upstream import.
  $ReferenceTokens=$null;$ReferenceErrors=$null
  $ReferenceAst=[Management.Automation.Language.Parser]::ParseFile($HostReferencePath,[ref]$ReferenceTokens,[ref]$ReferenceErrors)
  $ReferenceFunctions=@($ReferenceAst.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq 'PSConsoleHostReadLine'},$false))
  if($ReferenceErrors.Count -or $ReferenceFunctions.Count -ne 1){throw 'TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH'}
  $script:ExpectedReaderText=$ReferenceFunctions[0].Extent.Text.Replace("`r`n","`n")
  function Test-NativeReaderCommand {
    param($Command)
    return $null -ne $Command -and $Command.CommandType -eq [Management.Automation.CommandTypes]::Function -and $Command.Source -ceq 'PSReadLine' -and
      $Command.Module.Version.ToString() -ceq $Expected.editorVersion -and $Command.ScriptBlock.Ast -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $Command.ScriptBlock.Ast.Extent.Text.Replace("`r`n","`n") -ceq $script:ExpectedReaderText
  }
  $VisibleReadLine=Microsoft.PowerShell.Core\Get-Command PSConsoleHostReadLine -ErrorAction Ignore
  if($null -ne $VisibleReadLine -and -not (Test-NativeReaderCommand $VisibleReadLine)){throw 'TERMINAL_NATIVE_CUSTOM_HOST_UNSUPPORTED'}
  $script:OriginalReadLine=$ReadLineCandidate
  if(-not (Test-NativeReaderCommand $script:OriginalReadLine)){throw 'TERMINAL_NATIVE_CUSTOM_HOST_UNSUPPORTED'}
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $TransportSource -ErrorAction Stop
  if(@(PSReadLine\Get-PSReadLineKeyHandler -Chord 'Ctrl+x,a','Ctrl+x,Ctrl+b').Count -gt 0){throw 'TERMINAL_NATIVE_PRIVATE_BINDING_UNAVAILABLE'}
  $script:OriginalPrompt=(Microsoft.PowerShell.Core\Get-Command prompt -CommandType Function).ScriptBlock
  $script:Redraw=$false
  # This ACL belongs only to the newly created private pipe. No user or system
  # permission is changed. Both supported runtimes use the mature .NET ACL APIs.
  if($PSVersionTable.PSEdition -ne 'Desktop'){Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.IO.Pipes.AccessControl -ErrorAction Stop}
  $Security=[IO.Pipes.PipeSecurity]::new()
  $Security.SetAccessRuleProtection($true,$false)
  $User=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $Security.SetOwner($User)
  $Security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($User,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  if($PSVersionTable.PSEdition -eq 'Desktop'){
    $PrivatePipe=[IO.Pipes.NamedPipeServerStream]::new($PipeName,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,131072,131072,$Security)
  }else{
    $PrivatePipe=[IO.Pipes.NamedPipeServerStreamAcl]::Create($PipeName,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,131072,131072,$Security,[IO.HandleInheritability]::None,[IO.Pipes.PipeAccessRights]0)
  }
  $ActualSecurity=if($PSVersionTable.PSEdition -eq 'Desktop'){$PrivatePipe.GetAccessControl()}else{[IO.Pipes.PipesAclExtensions]::GetAccessControl($PrivatePipe)}
  $ActualRules=$ActualSecurity.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if(-not $ActualSecurity.AreAccessRulesProtected -or $ActualSecurity.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $User.Value -or $ActualRules.Count -ne 1 -or $ActualRules[0].IdentityReference.Value -cne $User.Value -or $ActualRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($ActualRules[0].PipeAccessRights -band [IO.Pipes.PipeAccessRights]::ReadWrite) -ne [IO.Pipes.PipeAccessRights]::ReadWrite){
    $PrivatePipe.Dispose();throw 'TERMINAL_NATIVE_PRIVATE_ENDPOINT_ACCESS_MISMATCH'
  }
  $script:Context=[ShellSpanNativeEditor]::new($Library,$PrivatePipe,$ExpectedClientPid,$ProfileJson,$true)
  $script:ReadLineFailureReported=$false
  $script:JobsLoaded=$false
  if($JobHelpersPath -and $JobHostPath -and $ConsoleSignalPath){
    $script:NativeJobHostSource=[IO.File]::ReadAllText($JobHostPath)
    $script:ConsoleSignalSource=[IO.File]::ReadAllText($ConsoleSignalPath)
    if($null -eq ('ShellSpanConsoleSignals' -as [type])){Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $script:ConsoleSignalSource -ErrorAction Stop}
    [ShellSpanConsoleSignals]::SetIgnore($false)
    $script:NativeJobRollout=$env:SHELLSPAN_NATIVE_POWERSHELL_JOBS -ne '0'
    . $JobHelpersPath
    $script:JobsLoaded=$true
  }
  function Send-ShellSpanControl {
    param([string[]]$Fields)
    if($Fields[0] -ceq 'B'){$Status=if($Fields[3] -eq '-'){$null}else{[int]$Fields[3]};$script:Context.ObserveJob($Fields[1],$Fields[2],$Status)}
    elseif($Fields[0] -ceq 'F'){$script:Context.ObserveJob($Fields[1],'finished',[int]$Fields[2])}
    else{throw 'TERMINAL_NATIVE_UNEXPECTED_LEGACY_EVENT'}
  }
  function Get-NativeBuffer {
    $Line=$null; $Cursor=0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
    return @([string]$Line,[int]$Cursor)
  }
  function Invoke-NativeService {
    $EditorType=[Microsoft.PowerShell.PSConsoleReadLine]
    $EditorActive=$false
    foreach($Frame in [Diagnostics.StackTrace]::new().GetFrames()){
      $Method=$Frame.GetMethod()
      if($null -ne $Method -and $Method.IsPublic -and $Method.IsStatic -and $Method.DeclaringType -eq $EditorType -and $Method.Name -ceq 'ReadLine'){$EditorActive=$true;break}
    }
    if(-not $EditorActive){return}
    $Clock=[Diagnostics.Stopwatch]::StartNew()
    $JobReady=$script:JobsLoaded -and (Test-ShellSpanNativeJobs)
    $OptionsPublished=$false
    do {
      $Buffer=Get-NativeBuffer
      $script:Context.Pump($Buffer[0],$Buffer[1])
      if(-not $OptionsPublished){$null=$script:Context.Event(11,$(if($JobReady){2}else{0}),$null);$OptionsPublished=$true}
      if(-not $script:Context.Event(9,0,$null)){$null=$script:Context.Event(5,0,(Get-Location).ProviderPath)}
      $Action=$script:Context.Action()
      if($Action -lt 0){ throw 'TERMINAL_INPUT_RECOVERY_REQUIRED' }
      if($Action -eq 3){
        $Text=$script:Context.Text(); $Tokens=$null; $ParseErrors=$null
        $Ast=[Management.Automation.Language.Parser]::ParseInput($Text,[ref]$Tokens,[ref]$ParseErrors)
        $Background=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.PipelineAst] -and $Node.PSObject.Properties['Background'] -and $Node.Background},$true)
        $Valid=$ParseErrors.Count -eq 0 -and $null -eq $Background
        if($Valid){
          $ExecutionSource=if($script:Context.Job(0) -eq 'launch'){$script:Context.Job(3)}else{$Text}
          $Valid=$script:Context.SetHostPlan([ShellSpanNativeEditor]::BuildHostPlan($ExecutionSource))
        }
        $null=$script:Context.Event(10,[int]$Valid,$null)
      }elseif($Action -gt 0){
        $Text=$script:Context.Text()
        if($script:JobsLoaded -and $script:NativeShellJobs.Count -gt 0){
          $PreviousRedraw=$script:Redraw;$script:Redraw=$true
          try{
            if([Console]::CursorLeft -gt 0){[Console]::WriteLine()}
            [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt($null,[int][Console]::CursorTop)
          }finally{$script:Redraw=$PreviousRedraw}
          $After=Get-NativeBuffer
          if($After[0] -cne $Buffer[0] -or $After[1] -ne $Buffer[1]){throw 'TERMINAL_INPUT_PROOF_MISMATCH'}
        }
        if($Action -eq 1){[Console]::Write("$([char]27)]1337;SetUserVar=ShellSpanNativeInput=MQ==$([char]7)")}
        $PreviousRedraw=$script:Redraw; $script:Redraw=$true
        try{[Microsoft.PowerShell.PSConsoleReadLine]::Replace(0,$Buffer[0].Length,$Text)}finally{$script:Redraw=$PreviousRedraw}
        $Buffer=Get-NativeBuffer
        $script:Context.Observe($Buffer[0],$Buffer[1])
        if(-not $script:Context.Event(1,0,$null)){throw 'TERMINAL_INPUT_PROOF_MISMATCH'}
        if($Action -eq 2){[Console]::Write("$([char]27)]1337;SetUserVar=ShellSpanNativeInput=MA==$([char]7)")}
      }
      if($script:Context.Event(8,0,$null) -or -not $script:Context.Event(9,0,$null)){break}
      if($Clock.ElapsedMilliseconds -ge 5000){throw 'TERMINAL_NATIVE_DEADLINE_EXPIRED'}
      [Threading.Thread]::Sleep(16)
    }while($true)
  }
  function Invoke-NativeAccept {
    $Buffer=Get-NativeBuffer
    $script:Context.Observe($Buffer[0],$Buffer[1])
    $JobKind=$script:Context.Job(0)
    if($JobKind -eq 'launch'){
      $Line=$script:Context.Job(3);$Tokens=$null;$ParseErrors=$null
      $Ast=[Management.Automation.Language.Parser]::ParseInput($Line,[ref]$Tokens,[ref]$ParseErrors)
      if($ParseErrors.Count -or -not (Install-ShellSpanNativeMarker $Line $Ast)){throw 'TERMINAL_NATIVE_JOB_MARKER_REJECTED'}
    }
    if(-not $script:Context.Event(2,0,$null)){return}
    if($JobKind -eq 'control'){
      $Handle=$script:Context.Job(1);$Action=$script:Context.Job(2)
      [Console]::Write($script:Context.Marker($false))
      if(-not $script:Context.Event(3,0,$null)){throw 'TERMINAL_NATIVE_START_REJECTED'}
      Invoke-ShellSpanNativeJobControl $Handle $Action
      [Console]::Write($script:Context.Marker($true))
      $null=$script:Context.Event(4,0,$null)
      $null=$script:Context.Event(5,0,(Get-Location).ProviderPath)
      return
    }
    $PreviousRedraw=$script:Redraw; $script:Redraw=$true
    try{[Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()}finally{$script:Redraw=$PreviousRedraw}
  }
  function Invoke-NativeReadLine {
    param([bool]$PreviousSuccess)
    try{$Line=[Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace,$ExecutionContext,$PreviousSuccess)}catch{
      if(-not $script:ReadLineFailureReported){
        $script:ReadLineFailureReported=$true
        $Cause=$_.Exception.GetBaseException()
        [Console]::Error.WriteLine('TERMINAL_NATIVE_READLINE_FAILED:{0}', $Cause.GetType().FullName)
        if($env:SHELLSPAN_P3_STARTUP_DIAGNOSTIC -eq '1'){
          $Diagnostic=@{kind='actual-native-readline-failure';exceptionType=$Cause.GetType().FullName;message=$Cause.Message;errorId=$_.FullyQualifiedErrorId;scriptStack=$_.ScriptStackTrace}
          [IO.File]::WriteAllText((Join-Path $env:SHELLSPAN_DATA_DIR 'native-readline-failure.json'),(Microsoft.PowerShell.Utility\ConvertTo-Json $Diagnostic))
        }
      }
      $script:Context.Fail()
      throw
    }
    if($null -eq $Line){return $null}
    try{
      $Accepted=$script:Context.Accepted()
      if(-not $Accepted){return $Line}
      $Plan=$script:Context.Plan($Line)
      if($Accepted -and $null -eq $Plan){throw 'TERMINAL_INPUT_PROOF_MISMATCH'}
    }catch{
      $script:Context.Fail()
      throw 'TERMINAL_INPUT_RECOVERY_REQUIRED'
    }
    [Console]::Write("$([char]27)]1337;SetUserVar=ShellSpanNativeInput=MA==$([char]7)")
    [Console]::Write($script:Context.Marker($false))
    if($null -ne $Plan){return $Plan}
    return $Line
  }
  function Invoke-NativePrompt {
    param([bool]$Success)
    foreach($Frame in [Diagnostics.StackTrace]::new().GetFrames()){
      $Method=$Frame.GetMethod()
      if($null -ne $Method -and $Method.IsPublic -and $Method.IsStatic -and $Method.DeclaringType -eq [Microsoft.PowerShell.PSConsoleReadLine] -and $Method.Name -ceq 'ReadLine'){
        Restore-NativeStatus -PreviousSuccess $Success -ErrorAction Ignore
        return & $script:OriginalPrompt
      }
    }
    if(-not $script:Redraw){
      if($script:JobsLoaded){Remove-ShellSpanNativeMarker}
      [Console]::Write($script:Context.Marker($true))
      $LastExit=$ExecutionContext.SessionState.PSVariable.GetValue('global:LASTEXITCODE',$null)
      $Status=if($Success){0}elseif($LastExit -is [int] -and $LastExit -ne 0){$LastExit}else{1}
      $null=$script:Context.Event(4,$Status,$null)
      [Console]::Write("$([char]27)]1337;SetUserVar=ShellSpanNativeInput=MA==$([char]7)")
    }
    Restore-NativeStatus -PreviousSuccess $Success -ErrorAction Ignore
    & $script:OriginalPrompt
  }
  function Restore-NativeStatus {
    [CmdletBinding()]param([bool]$PreviousSuccess)
    if(-not $PreviousSuccess){$PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new(),'ShellSpanPreviousStatus',[Management.Automation.ErrorCategory]::NotSpecified,$null))}
  }
  # -File's startup scope ends before ConsoleHost invokes global callbacks.
  # The collision-checked global integration reference survives that scope.
  # Keep callbacks in this known module; closure modules cannot preserve the
  # caller's state in the existing native job inheritance contract.
  $NativeModule=$ExecutionContext.SessionState.Module
  Set-Item Function:\global:__shellspan_nip_begin -Value {
    [CmdletBinding()]param([bool]$PreviousSuccess)
    & $global:__shellspanModule {
      if(-not $script:Context.Event(3,0,$null)){throw 'TERMINAL_NATIVE_START_REJECTED'}
    }
    if(-not $PreviousSuccess){$PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new(),'ShellSpanPreviousStatus',[Management.Automation.ErrorCategory]::NotSpecified,$null))}
  }
  Set-Item Function:\global:PSConsoleHostReadLine -Value {
    [CmdletBinding()]param()
    $Success=$?
    $Line=& $global:__shellspanModule {param($Value) Invoke-NativeReadLine $Value} $Success
    if(-not $Success){
      $local:ErrorActionPreference='Ignore'
      $PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new(),'ShellSpanReadLinePreviousStatus',[Management.Automation.ErrorCategory]::NotSpecified,$null))
    }
    return $Line
  }
  Set-Item Function:\global:prompt -Value { $Success=$?; & $global:__shellspanModule {param($Value) Invoke-NativePrompt $Value} $Success }
  PSReadLine\Set-PSReadLineKeyHandler -Chord 'Ctrl+x,Ctrl+b' -ScriptBlock { & $global:__shellspanModule {Invoke-NativeService} }
  PSReadLine\Set-PSReadLineKeyHandler -Chord 'Ctrl+x,a' -ScriptBlock { & $global:__shellspanModule {Invoke-NativeAccept} }
  # Engine actions have their own module and ignore MessageData. Bind the actual
  # owner into that action's public module state. Only this fixed callback code
  # is created here; user/model source is never evaluated by the event action.
  $IdleAction=[scriptblock]::Create('& $ShellSpanNativeOwner {Invoke-NativeService}')
  $script:IdleSubscription=Microsoft.PowerShell.Utility\Register-EngineEvent -SourceIdentifier PowerShell.OnIdle -Action $IdleAction
  $script:IdleSubscription.Module.SessionState.PSVariable.Set('ShellSpanNativeOwner',$NativeModule)
}
# Existing native job markers deliberately stay unbound to preserve the caller's
# StrictMode, functions and language mode. Their reserved module reference must
# survive -File's startup scope, too; no user variable is replaced.
$global:__shellspanModule=$__shellspanNipModule
