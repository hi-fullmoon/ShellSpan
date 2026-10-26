# Loaded inside the existing integration module. Only its parent runspace can
# write Send-ShellSpanControl; console workers receive no original control pipe.
$script:NativeShellJobs = @{}
function Get-ShellSpanJobMapComparer {
  param([hashtable]$Value)
  $Info=[Runtime.Serialization.SerializationInfo]::new([hashtable],[Runtime.Serialization.FormatterConverter]::new())
  $Value.GetObjectData($Info,[Runtime.Serialization.StreamingContext]::new([Runtime.Serialization.StreamingContextStates]::All))
  $Comparer=$null
  $Enumerator=$Info.GetEnumerator()
  while($Enumerator.MoveNext()){
    if($Enumerator.Name -eq 'KeyComparer'){$Comparer=$Enumerator.Value}
    elseif($Enumerator.Name -in @('Comparer','HashCodeProvider') -and $null-ne $Enumerator.Value){throw 'Native job state does not support legacy custom hash comparers'}
  }
  if($null-eq $Comparer){return 'default'}
  if($Comparer.GetType().Assembly-ne [StringComparer].Assembly -or $Comparer.GetType().FullName-notin @('System.CultureAwareComparer','System.OrdinalComparer','System.OrdinalCaseSensitiveComparer','System.OrdinalIgnoreCaseComparer')){throw 'Native job state does not support custom hash comparers'}
  foreach($Name in @('Ordinal','OrdinalIgnoreCase','InvariantCulture','InvariantCultureIgnoreCase','CurrentCulture','CurrentCultureIgnoreCase')){
    $Known=[StringComparer]::$Name
    if([object]::Equals($Comparer,$Known)){return $Name}
  }
  throw 'Native job state does not support custom hash comparers'
}
function ConvertTo-ShellSpanJobValue {
  param($Value,[int]$Depth=0,$Seen=$null)
  if($null-eq $Seen){$Seen=[Collections.Generic.HashSet[object]]::new([ShellSpanReferenceComparer]::new())}
  if ($Depth -gt 64) { throw 'Native job state nesting exceeds 64 levels' }
  if($null-ne $script:NativeStateCaptureClock -and $script:NativeStateCaptureClock.ElapsedMilliseconds-gt 3000){throw 'Native job state capture exceeded three seconds'}
  if ($null -eq $Value) { return @{Kind='null'} }
  if(($Value-is [string] -and $Value.Length-gt 4194304) -or (($Value-is [array] -or $Value-is [hashtable] -or $Value-is [Collections.ArrayList]) -and $Value.Count-gt 100000)){throw 'Native job variable exceeds bounded state transfer limits'}
  $Type=$Value.GetType()
  if ($Value.PSObject.TypeNames[0] -ne $Type.FullName) { throw 'Native job state does not support custom PowerShell type names' }
  if ($Value.PSObject.Members.Match('*',[System.Management.Automation.PSMemberTypes]'ScriptProperty,CodeProperty,ScriptMethod,CodeMethod').Count) { throw 'Native job state does not support custom executable members' }
  if($Value -is [array] -or $Value -is [hashtable] -or $Type -eq [Collections.ArrayList] -or $Type -eq [System.Management.Automation.PSCustomObject]){
    if(-not $Seen.Add($Value)){throw 'Native job state cannot transfer cyclic or shared mutable references without identity loss'}
    if($Type -ne [System.Management.Automation.PSCustomObject] -and $Value.PSObject.Properties.Match('*',[System.Management.Automation.PSMemberTypes]::NoteProperty).Count){throw 'Native job collections cannot carry custom note properties'}
  }
  if ($Type.IsEnum -and $Type.Assembly -eq [System.Management.Automation.ActionPreference].Assembly) {
    if($Value.PSObject.Properties.Match('*',[System.Management.Automation.PSMemberTypes]::NoteProperty).Count){throw 'Native job enum values cannot carry custom note properties'}
    return @{Kind='enum';Type=$Type.FullName;Xml=[System.Management.Automation.PSSerializer]::Serialize($Value)}
  }
  if ($Value -is [array]) {
    if ($Value.Rank -ne 1 -or $Value.GetLowerBound(0) -ne 0) { throw 'Native job state supports only zero-based one-dimensional arrays' }
    $Items=@(foreach($Item in $Value){ & ${function:ConvertTo-ShellSpanJobValue} $Item ($Depth+1) $Seen })
    $Element=$Type.GetElementType()
    if ($Element -notin @([object],[string],[bool],[char],[byte],[sbyte],[int16],[uint16],[int32],[uint32],[int64],[uint64],[single],[double],[decimal],[datetime],[timespan],[guid])) { throw ('Unsupported native job array element type: '+$Element.FullName) }
    return @{Kind='array';Type=$Element.FullName;Items=$Items}
  }
  if ($Type -eq [hashtable] -or $Type -eq [System.Management.Automation.DefaultParameterDictionary]) {
    $Comparer=& ${function:Get-ShellSpanJobMapComparer} $Value
    if($Type -ne [hashtable] -and $Comparer -ne (& ${function:Get-ShellSpanJobMapComparer} ([System.Management.Automation.DefaultParameterDictionary]::new()))){throw 'Native job default-parameter comparer differs from native defaults'}
    $Entries=@(foreach($Key in $Value.Keys){ @{Key=(& ${function:ConvertTo-ShellSpanJobValue} $Key ($Depth+1) $Seen);Value=(& ${function:ConvertTo-ShellSpanJobValue} $Value[$Key] ($Depth+1) $Seen)} })
    return @{Kind=$(if($Type -eq [hashtable]){'map'}else{'defaults'});Comparer=$Comparer;Entries=$Entries}
  }
  if ($Type -eq [System.Collections.ArrayList]) {
    return @{Kind='list';Items=@(foreach($Item in $Value){& ${function:ConvertTo-ShellSpanJobValue} $Item ($Depth+1) $Seen})}
  }
  if ($Type -eq [System.Management.Automation.PSCustomObject]) {
    $Properties=@(foreach($Property in $Value.PSObject.Properties){
      if($Property -isnot [System.Management.Automation.PSNoteProperty]){throw 'Native job objects require ordinary note properties'}
      @{Name=$Property.Name;Value=(& ${function:ConvertTo-ShellSpanJobValue} $Property.Value ($Depth+1) $Seen)}
    })
    return @{Kind='object';Properties=$Properties}
  }
  if ($Type -notin @([string],[bool],[char],[byte],[sbyte],[int16],[uint16],[int32],[uint32],[int64],[uint64],[single],[double],[decimal],[datetime],[datetimeoffset],[timespan],[guid],[version],[uri],[System.Management.Automation.Remoting.PSSessionOption])) {
    throw ('Unsupported native job variable type: '+$Type.FullName)
  }
  $Notes=@(foreach($Property in $Value.PSObject.Properties){if($Property -is [System.Management.Automation.PSNoteProperty]){@{Name=$Property.Name;Value=(& ${function:ConvertTo-ShellSpanJobValue} $Property.Value ($Depth+1) $Seen)}}})
  $Xml=[System.Management.Automation.PSSerializer]::Serialize($Value,100)
  $Restored=[System.Management.Automation.PSSerializer]::Deserialize($Xml)
  if ($null -eq $Restored -or $Restored.GetType() -ne $Type) { throw ('Native job variable cannot round-trip its type: '+$Type.FullName) }
  return @{Kind='scalar';Xml=$Xml;Notes=$Notes}
}
function Get-ShellSpanJobStyleSnapshot {
  param($Style)
  if($null-eq $Style){return $null}
  if($Style.GetType().Assembly-ne [System.Management.Automation.ActionPreference].Assembly -or $Style.GetType().FullName-ne 'System.Management.Automation.PSStyle'){throw 'Native style state has an unsupported type'}
  $Queue=[Collections.Generic.Queue[object]]::new()
  $Queue.Enqueue($Style)
  $Seen=[Collections.Generic.HashSet[object]]::new([ShellSpanReferenceComparer]::new())
  $Extensions=[Collections.Generic.List[object]]::new()
  while($Queue.Count-gt 0){
    $Part=$Queue.Dequeue()
    if($null-eq $Part -or -not $Seen.Add($Part)){continue}
    if($Seen.Count-gt 10000){throw 'Native style state exceeds bounded transfer limits'}
    if($Part.PSObject.Members.Match('*',[System.Management.Automation.PSMemberTypes]'ScriptProperty,CodeProperty,ScriptMethod,CodeMethod,NoteProperty,AliasProperty').Count){throw 'Native style state has custom extended members'}
    $Type=$Part.GetType()
    if($Type.IsPrimitive -or $Type.IsEnum -or $Type-eq [string]){continue}
    if($Type.Assembly-eq [System.Management.Automation.ActionPreference].Assembly -and $Type.FullName-eq 'System.Management.Automation.PSStyle+FileInfoFormatting+FileExtensionDictionary'){
      foreach($Key in $Part.Keys){
        $Value=$Part[$Key]
        if($Key-isnot [string] -or $Value-isnot [string]){throw 'Native file style entries require strings'}
        $Extensions.Add([pscustomobject][ordered]@{Key=$Key;Value=$Value})
        $Queue.Enqueue($Key);$Queue.Enqueue($Value)
      }
      continue
    }
    if($Part-is [Collections.Generic.IDictionary[string,string]] -and ($Type-eq [Collections.Generic.Dictionary[string,string]] -or ($Type.Assembly-eq [System.Management.Automation.ActionPreference].Assembly -and $Type.FullName.StartsWith('System.Management.Automation.PSStyle',[StringComparison]::Ordinal)))){foreach($Entry in $Part.GetEnumerator()){$Queue.Enqueue($Entry.Key);$Queue.Enqueue($Entry.Value)};continue}
    if($Type.Assembly-ne [System.Management.Automation.ActionPreference].Assembly -or -not $Type.FullName.StartsWith('System.Management.Automation.PSStyle',[StringComparison]::Ordinal)){throw ('Native style state contains unsupported objects: '+$Type.FullName)}
    foreach($Property in $Part.PSObject.Properties){$Queue.Enqueue($Property.Value)}
  }
  return [System.Management.Automation.PSSerializer]::Serialize([pscustomobject][ordered]@{Style=[System.Management.Automation.PSSerializer]::Serialize($Style,100);Extensions=$Extensions.ToArray()},100)
}
function Get-ShellSpanJobVersionSnapshot {
  param($Table)
  if($Table -isnot [hashtable] -or $Table.Count-gt 100){throw 'Native version state has an unsupported shape'}
  if($Table.PSObject.Members.Match('*',[System.Management.Automation.PSMemberTypes]'ScriptProperty,CodeProperty,ScriptMethod,CodeMethod,NoteProperty,AliasProperty').Count){throw 'Native version state has custom extended members'}
  foreach($Key in $Table.Keys){if($Key-isnot [string]){throw 'Native version state requires string keys'}}
  $Keys=[string[]]@($Table.Keys)
  [array]::Sort($Keys,[StringComparer]::Ordinal)
  $Records=@(foreach($Key in $Keys){
    $Value=$Table[$Key]
    if($null-eq $Value){throw 'Native version state has null values'}
    $Values=@(foreach($Item in @($Value)){
      if($null-eq $Item -or ($Item.GetType()-notin @([string],[version]) -and ($Item.GetType().Assembly-ne [System.Management.Automation.ActionPreference].Assembly -or $Item.GetType().FullName-ne 'System.Management.Automation.SemanticVersion'))){throw 'Native version state contains unsupported values'}
      if($Item.PSObject.Members.Match('*',[System.Management.Automation.PSMemberTypes]'ScriptProperty,CodeProperty,ScriptMethod,CodeMethod,NoteProperty,AliasProperty').Count){throw 'Native version values have custom extended members'}
      [Convert]::ToString($Item,[Globalization.CultureInfo]::InvariantCulture)
    })
    [pscustomobject][ordered]@{Name=$Key;Type=$Value.GetType().FullName;Values=[string[]]$Values}
  })
  return [System.Management.Automation.PSSerializer]::Serialize($Records,100)
}
function Get-ShellSpanJobCulture {
  param([Globalization.CultureInfo]$Culture)
  $Vista=$Culture.GetType().FullName-eq 'Microsoft.PowerShell.VistaCultureInfo' -and $Culture.GetType().Assembly-eq [System.Management.Automation.PSObject].Assembly
  if($Culture.GetType()-ne [Globalization.CultureInfo] -and -not $Vista){throw 'Native job state does not support custom culture classes'}
  $Native=[Globalization.CultureInfo]::new($Culture.Name,$Culture.UseUserOverride)
  if($Culture.IsReadOnly){$Native=[Globalization.CultureInfo]::ReadOnly($Native)}
  foreach($Name in @('DateTimeFormat','NumberFormat','TextInfo','Calendar')){
    $Actual=$Culture.$Name
    if($Actual.GetType().Assembly-ne [string].Assembly -or $Actual.PSObject.Members.Match('*',[System.Management.Automation.PSMemberTypes]'ScriptProperty,CodeProperty,ScriptMethod,CodeMethod,NoteProperty,AliasProperty').Count){throw 'Native culture state has unsupported extensions'}
    if([System.Management.Automation.PSSerializer]::Serialize($Actual,100)-cne [System.Management.Automation.PSSerializer]::Serialize($Native.$Name,100)){throw 'Native job state cannot preserve custom culture formatting'}
  }
  return @{Name=$Culture.Name;UseUserOverride=$Culture.UseUserOverride;IsReadOnly=$Culture.IsReadOnly;NativeType=$Culture.GetType().FullName}
}
function ConvertFrom-ShellSpanJobValue {
  param($Record)
  switch($Record.Kind) {
    'null' { return $null }
    'scalar' {
      $Value=[System.Management.Automation.PSSerializer]::Deserialize($Record.Xml)
      foreach($Property in $Record.Notes){Microsoft.PowerShell.Utility\Add-Member -InputObject $Value -MemberType NoteProperty -Name $Property.Name -Value (& ${function:ConvertFrom-ShellSpanJobValue} $Property.Value) -Force}
      return ,$Value
    }
    'enum' { return [System.Management.Automation.LanguagePrimitives]::ConvertTo([System.Management.Automation.PSSerializer]::Deserialize($Record.Xml),([System.Management.Automation.PSTypeName]$Record.Type).Type) }
    'array' {
      $Array=[array]::CreateInstance(([System.Management.Automation.PSTypeName]$Record.Type).Type,$Record.Items.Count)
      for($Index=0;$Index-lt $Record.Items.Count;$Index++){ $Array.SetValue((& ${function:ConvertFrom-ShellSpanJobValue} $Record.Items[$Index]),$Index) }
      return ,$Array
    }
    'map' {
      $Map=if($Record.Comparer-eq 'default'){[hashtable]::new()}else{[hashtable]::new([StringComparer]::($Record.Comparer))}
      foreach($Entry in $Record.Entries){$Map.Add((& ${function:ConvertFrom-ShellSpanJobValue} $Entry.Key),(& ${function:ConvertFrom-ShellSpanJobValue} $Entry.Value))};return ,$Map
    }
    'defaults' {
      $Map=[System.Management.Automation.DefaultParameterDictionary]::new()
      foreach($Entry in $Record.Entries){$Map.Add((& ${function:ConvertFrom-ShellSpanJobValue} $Entry.Key),(& ${function:ConvertFrom-ShellSpanJobValue} $Entry.Value))};return ,$Map
    }
    'list' { $List=[System.Collections.ArrayList]::new();foreach($Item in $Record.Items){$null=$List.Add((& ${function:ConvertFrom-ShellSpanJobValue} $Item))};return ,$List }
    'object' { $Object=[pscustomobject]@{};foreach($Property in $Record.Properties){Microsoft.PowerShell.Utility\Add-Member -InputObject $Object -MemberType NoteProperty -Name $Property.Name -Value (& ${function:ConvertFrom-ShellSpanJobValue} $Property.Value)};return $Object }
    default { throw 'Invalid native job value kind' }
  }
}
$script:NativeJobWorker = @'
param($Packet,$Pipe)
$ErrorActionPreference='Stop'
$State=[hashtable]::Synchronized(@{ExitCode=$null;Published=$false;SourceStarted=$false;SourceReturned=$false;SourceSucceeded=$null;CaughtError=$false;CaughtNativeExit=$null;TrackingActive=$false;NativeInvocations=0;LastCmdletErrorNativeCount=-1;NativeTrackingTrusted=$true;NativeBreakpointId=$null})
$State.RuntimeCulture=[Globalization.CultureInfo]::CurrentCulture
$State.RuntimeUICulture=[Globalization.CultureInfo]::CurrentUICulture
$Runspace=$null
$Pipeline=$null
$Tracker=$null
$JobHost=$null
try {
  Add-Type -TypeDefinition $Packet.SignalSource -ErrorAction Stop
  [ShellSpanConsoleSignals]::SetIgnore($true)
  $Pipe.WriteByte(0xA1);$Pipe.Flush()
  Add-Type -TypeDefinition $Packet.HostSource -ErrorAction Stop
  $JobHost=New-Object ShellSpanJobHost -ArgumentList $Host
  $Initial=[System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
  $Initial.Commands.Add([System.Management.Automation.Runspaces.SessionStateCmdletEntry]::new('Trace-ShellSpanJobStatus',[ShellSpanJobStatus],$null))
  $Runspace=[System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace($JobHost,$Initial)
  $Runspace.ApartmentState=[Threading.ApartmentState]$Packet.Snapshot.ApartmentState
  $Runspace.Open()
  $Tracker=[ShellSpanNativeStatusTracker]::new($Runspace,$State)
  $Pipeline=[powershell]::Create()
  $Pipeline.Runspace=$Runspace
  $null=$Pipeline.AddScript($Packet.Body).AddArgument($Packet.Source).AddArgument($Packet.Snapshot).AddArgument($State).AddArgument($Packet.Restore).AddArgument($Packet.VersionSnapshot).AddArgument($Packet.StyleSnapshot)
  $null=$Pipeline.Invoke()
  if(-not $State.Published){$Pipeline.Streams.Error | Out-Host}
  if($null-ne $JobHost.ExitCode -and $State.SourceStarted){$State.ExitCode=$JobHost.ExitCode}
} catch { $_ | Out-Host } finally {
  $Result=@{SourceStarted=$State.SourceStarted;Published=$State.Published;ExitCode=$State.ExitCode}
  $Bytes=[Text.Encoding]::UTF8.GetBytes([System.Management.Automation.PSSerializer]::Serialize($Result))
  $Writer=[IO.BinaryWriter]::new($Pipe,[Text.Encoding]::UTF8,$true)
  $Writer.Write([int]$Bytes.Length);$Writer.Write($Bytes);$Writer.Flush()
  if($null-ne $Tracker){$Tracker.Dispose()}
  if($null-ne $Pipeline){$Pipeline.Dispose()}
  if($null-ne $Runspace){$Runspace.Dispose()}
  $Pipe.Dispose()
}
'@
function Test-ShellSpanNativeJobs {
  if (-not $script:NativeJobRollout) { return $false }
  try {
    # Definition text alone cannot carry a module's private closure state into
    # a new runspace. Refuse that context instead of claiming inheritance.
    $UnsupportedFunctions = @(Microsoft.PowerShell.Management\Get-ChildItem Function: | Microsoft.PowerShell.Core\Where-Object {
      $_.ModuleName -and $_.ModuleName -notin @('ShellSpanTerminalIntegration','PSReadLine','Microsoft.PowerShell.Core','Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security','PSWorkflow','PSWorkflowUtility')
    })
    if ($UnsupportedFunctions.Count -ne 0) { return $false }
    if ($null -eq $Host.UI -or $null -eq $Host.UI.RawUI) { return $false }
    if ($null -eq ('ShellSpanJobHost' -as [type])) {
      # Preserve Add-Type's runtime-specific default references (including
      # System.Console on PowerShell 7 and System.Management.Automation).
      Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $script:NativeJobHostSource -ErrorAction Stop
    }
    return $true
  } catch { return $false }
}
function Remove-ShellSpanNativeMarker {
  if ($script:NativeMarkerName) {
    $Current=Microsoft.PowerShell.Management\Get-Item -LiteralPath ('Function:\global:'+$script:NativeMarkerName) -ErrorAction Ignore
    if ($null-ne $Current -and $Current.ScriptBlock-eq $script:NativeMarkerBody) {
      Microsoft.PowerShell.Management\Remove-Item -LiteralPath ('Function:\global:'+$script:NativeMarkerName)
    }
  }
  $script:NativeMarkerName=$null
  $script:NativeMarkerBody=$null
}
function Install-ShellSpanNativeMarker {
  param([string]$Line,[System.Management.Automation.Language.ScriptBlockAst]$Ast)
  if ($Line -cnotmatch '^job-[0-9a-f]{32} ') { return $true }
  if ($Ast.EndBlock.Statements.Count-ne 1 -or $Ast.EndBlock.Statements[0]-isnot [System.Management.Automation.Language.PipelineAst]) { return $false }
  $Pipeline=$Ast.EndBlock.Statements[0]
  if ($Pipeline.PipelineElements.Count-ne 1 -or $Pipeline.PipelineElements[0]-isnot [System.Management.Automation.Language.CommandAst]) { return $false }
  $Command=$Pipeline.PipelineElements[0]
  if ($Command.CommandElements.Count-ne 2 -or $Command.CommandElements[1]-isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $Command.CommandElements[1].StringConstantType-ne [System.Management.Automation.Language.StringConstantType]::SingleQuoted) { return $false }
  $Handle=$Command.GetCommandName()
  if ($Handle -cnotmatch '^job-[0-9a-f]{32}$') { return $false }
  $Source=$Command.CommandElements[1].Value
  $Tokens=$null; $Errors=$null
  $null=[System.Management.Automation.Language.Parser]::ParseInput($Source,[ref]$Tokens,[ref]$Errors)
  if ($Errors.Count-ne 0 -or (Microsoft.PowerShell.Core\Get-Command $Handle -ErrorAction Ignore)) { return $false }
  # An unbound global function runs in the caller's native scope. Probe inherited
  # StrictMode there, before entering the integration module, as in the original
  # submission. The native parser decodes the literal; it is never invoked here.
  $Body=@'
param([string]$__shellspanSource)
$__shellspan_saved_errors = $Error.Clone()
try { $null=${__shellspan_strict_probe___HANDLE__}; $__shellspanStrict=$false }
catch { $Error.Clear(); $Error.AddRange($__shellspan_saved_errors); $__shellspanStrict=$true }
$__shellspanFunctions=@(& { $d=$ExecutionContext.SessionState.PSVariable.Get('global:PSDefaultParameterValues'); if($null-eq $d -or -not ($d.Options-band [System.Management.Automation.ScopedItemOptions]::AllScope)) { $local:PSDefaultParameterValues=@{}; Microsoft.PowerShell.Management\Get-ChildItem Function: } })
& $__shellspanModule { param($s,$strict,$functions,$language) & ${function:Invoke-ShellSpanNativeJobStart} '__HANDLE__' $s $strict $functions $language } $__shellspanSource $__shellspanStrict $__shellspanFunctions $ExecutionContext.SessionState.LanguageMode
'@
  $script:NativeMarkerBody=[scriptblock]::Create($Body.Replace('__HANDLE__',$Handle))
  Microsoft.PowerShell.Management\Set-Item -LiteralPath ('Function:\global:'+$Handle) -Value $script:NativeMarkerBody
  $script:NativeMarkerName=$Handle
  return $true
}
function Receive-ShellSpanPrivateControl {
  $script:PrivateDescriptor=$null
  $Line=$null; $Cursor=0
  [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
  if (-not [string]::IsNullOrEmpty($Line)) { Send-ShellSpanControl @('M','',$Line); return }
  Send-ShellSpanControl @('W')
  try {
    $Data=[ShellSpanConsoleSignals]::ReadEditorData()
    if ($Data-cmatch '^[ps][0-9a-f]{64}$') { $script:PrivateDescriptor=$Data }
  } catch { $script:PrivateDescriptor=$null }
  Send-ShellSpanControl @('M',[string]$script:PrivateDescriptor,$Line)
}
function Complete-ShellSpanPrivateControl {
  $Descriptor=$script:PrivateDescriptor
  $script:PrivateDescriptor=$null
  $script:NativeEditorTransaction=$false
  $Line=$null; $Cursor=0
  [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
  if (-not [string]::IsNullOrEmpty($Line) -or $Descriptor-cnotmatch '^[ps][0-9a-f]{64}$') { return }
  $Handle='job-'+$Descriptor.Substring(1,32)
  $Action=if($Descriptor[0]-ceq 's'){'stop'}else{'poll'}
  $Submission="& `$__shellspanModule { param(`$h,`$a) & `${function:Invoke-ShellSpanNativeJobControl} `$h `$a } '$Handle' '$Action'"
  Send-ShellSpanControl @('S',$Submission,(Get-Location).ProviderPath)
  & ${function:Invoke-ShellSpanNativeJobControl} $Handle $Action
  Send-ShellSpanControl @('E','0',(Get-Location).ProviderPath)
  Send-ShellSpanControl @('P',(Get-Location).ProviderPath)
  Send-ShellSpanControl @('I','1')
  Send-ShellSpanControl @('H','1')
  Send-ShellSpanControl @('V','1')
  Send-ShellSpanControl @('K',$(if(Test-ShellSpanNativeJobs){'1'}else{'0'}))
  Send-ShellSpanControl @('Q')
}
function Invoke-ShellSpanNativeJobStart {
  param([string]$Handle, [string]$Source, [object]$StrictModeActive=$null, [object[]]$CallerFunctions, [object]$CallerLanguageMode=$null)
  if($CallerLanguageMode-isnot [System.Management.Automation.PSLanguageMode] -or $CallerLanguageMode-ne [System.Management.Automation.PSLanguageMode]::FullLanguage){
    Microsoft.PowerShell.Utility\Write-Warning 'TERMINAL_INPUT_UNSUPPORTED: native jobs require FullLanguage without caller debugger breakpoints; no source was executed'
    Send-ShellSpanControl @('B',$Handle,'rejected','-')
    return
  }
  $GlobalDefaults=$ExecutionContext.SessionState.PSVariable.Get('global:PSDefaultParameterValues')
  if($null-ne $GlobalDefaults -and ($GlobalDefaults.Options-band [System.Management.Automation.ScopedItemOptions]::AllScope)){
    Microsoft.PowerShell.Utility\Write-Warning 'TERMINAL_INPUT_UNSUPPORTED: AllScope PSDefaultParameterValues cannot be isolated from native management; no source was executed'
    Send-ShellSpanControl @('B',$Handle,'rejected','-');return
  }
  $local:PSDefaultParameterValues=[System.Management.Automation.DefaultParameterDictionary]::new()
  if(@(Microsoft.PowerShell.Utility\Get-PSBreakpoint).Count-gt 0){
    Microsoft.PowerShell.Utility\Write-Warning 'TERMINAL_INPUT_UNSUPPORTED: caller debugger breakpoints cannot be inherited; no source was executed'
    Send-ShellSpanControl @('B',$Handle,'rejected','-');return
  }
  if ($StrictModeActive -isnot [bool] -or $StrictModeActive) {
    Microsoft.PowerShell.Utility\Write-Warning 'TERMINAL_INPUT_UNSUPPORTED: native jobs cannot preserve caller StrictMode; no job was created'
    Send-ShellSpanControl @('B',$Handle,'rejected','-')
    return
  }
  if (-not (Test-ShellSpanNativeJobs) -or $script:NativeShellJobs.ContainsKey($Handle)) {
    Send-ShellSpanControl @('B',$Handle,'rejected','-')
    return
  }
  $Tokens = $null
  $Errors = $null
  $Ast = [System.Management.Automation.Language.Parser]::ParseInput($Source,[ref]$Tokens,[ref]$Errors)
  $Background = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.PipelineAst] -and $Node.PSObject.Properties['Background'] -and $Node.Background },$true)
  if ($Errors.Count -gt 0 -or $null -ne $Background) {
    Send-ShellSpanControl @('J',$Source,'TERMINAL_INPUT_UNSUPPORTED')
    return
  }
  if ($null -ne $Ast.ScriptRequirements -or ($Ast.PSObject.Properties['CleanBlock'] -and $null -ne $Ast.CleanBlock)) {
    Microsoft.PowerShell.Utility\Write-Warning 'TERMINAL_INPUT_UNSUPPORTED: native jobs do not support script requirements or clean blocks; no job was created'
    Send-ShellSpanControl @('B',$Handle,'rejected','-')
    return
  }
  # Engine-owned PSVariable subclasses (args/input/PSBoundParameters, etc.)
  # belong to the new invocation and may be optimized, non-writable slots.
  try {
    $script:NativeStateCaptureClock=[Diagnostics.Stopwatch]::StartNew()
    # A fresh native runspace supplies same-version engine defaults. Leave an
    # unchanged encoding in the worker's native default type; custom encodings
    # must not silently degrade to a deserialized PSObject.
    $DefaultRunspace=[System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    try {
      $DefaultRunspace.Open()
      $DefaultEncoding=$DefaultRunspace.SessionStateProxy.GetVariable('OutputEncoding')
      $DefaultEncodingXml=[System.Management.Automation.PSSerializer]::Serialize($DefaultEncoding,100)
      $DefaultFeatures=$DefaultRunspace.SessionStateProxy.GetVariable('EnabledExperimentalFeatures')
      $CallerFeatures=$EnabledExperimentalFeatures
      if(($null-eq $DefaultFeatures)-ne ($null-eq $CallerFeatures) -or ($null-ne $CallerFeatures -and $DefaultFeatures.GetType()-ne $CallerFeatures.GetType())){throw 'Native engine feature state has an unsupported type'}
      $FeatureNames=@($CallerFeatures | Microsoft.PowerShell.Core\Where-Object {$null-ne $_} | Microsoft.PowerShell.Utility\Sort-Object -CaseSensitive)
    } finally {$DefaultRunspace.Dispose()}
    $Seen=[Collections.Generic.HashSet[object]]::new([ShellSpanReferenceComparer]::new())
    $GlobalVariables=@(Microsoft.PowerShell.Utility\Get-Variable -Scope Global)
    foreach($Variable in $GlobalVariables){if($Variable.GetType()-ne [System.Management.Automation.PSVariable] -and $Variable.GetType().Assembly-ne [System.Management.Automation.PSVariable].Assembly){throw 'Native job state cannot preserve custom PSVariable subclasses'}}
    $EngineVariables=@($GlobalVariables | Microsoft.PowerShell.Core\Where-Object {$_.Name-in @('HOME','PSHOME','PSEdition','IsCoreCLR','IsLinux','IsMacOS','IsWindows','ShellId')} | Microsoft.PowerShell.Core\ForEach-Object {
      if($_.Value-isnot [string] -and $_.Value-isnot [bool]){throw 'Native engine identity state has an unsupported type'}
      $null=& ${function:ConvertTo-ShellSpanJobValue} $_.Value
      if($_.Value.PSObject.Properties.Match('*',[System.Management.Automation.PSMemberTypes]::NoteProperty).Count){throw 'Native engine identity state has extended properties'}
      @{Name=$_.Name;Value=$_.Value}
    })
    $StyleXml=& ${function:Get-ShellSpanJobStyleSnapshot} $PSStyle
    $VersionXml=& ${function:Get-ShellSpanJobVersionSnapshot} $PSVersionTable
    $Culture=& ${function:Get-ShellSpanJobCulture} ([Globalization.CultureInfo]::CurrentCulture)
    $UICulture=& ${function:Get-ShellSpanJobCulture} ([Globalization.CultureInfo]::CurrentUICulture)
    $Variables = @($GlobalVariables | Microsoft.PowerShell.Core\Where-Object { $_.GetType() -eq [System.Management.Automation.PSVariable] -and $_.Name -notlike '__shellspan*' -and $_.Name -notin @('Host','ExecutionContext','PSHOME','PSVersionTable','HOME','Error','PWD','PID','PSStyle','EnabledExperimentalFeatures','true','false','null','PSEdition','IsCoreCLR','IsLinux','IsMacOS','IsWindows','ShellId') } | Microsoft.PowerShell.Core\ForEach-Object {
      if($_.Name -eq 'OutputEncoding' -and [System.Management.Automation.PSSerializer]::Serialize($_.Value,100) -eq $DefaultEncodingXml){return}
      @{ Name=$_.Name; Value=(& ${function:ConvertTo-ShellSpanJobValue} $_.Value 0 $Seen); Options=$_.Options }
    })
  } catch {
    Microsoft.PowerShell.Utility\Write-Warning ('TERMINAL_INPUT_UNSUPPORTED: native job state cannot be transferred without type loss: '+$_.Exception.Message)
    Send-ShellSpanControl @('B',$Handle,'rejected','-')
    return
  }
  # Standard module commands resolve through native module loading in the new
  # runspace. Copy only plain user functions, never a module's Definition text.
  $Functions = @($CallerFunctions | Microsoft.PowerShell.Core\Where-Object { -not $_.ModuleName -and $_.Name -ne $Handle -and $_.Name -notin @('prompt','PSConsoleHostReadLine') -and $_.Name -notlike '__shellspan*' } | Microsoft.PowerShell.Core\ForEach-Object {
    @{ Name=$_.Name; Definition=$_.Definition; Options=$_.Options }
  })
  $Aliases = @(Microsoft.PowerShell.Utility\Get-Alias | Microsoft.PowerShell.Core\ForEach-Object { @{ Name=$_.Name; Definition=$_.Definition; Options=$_.Options } })
  $Snapshot = @{ Variables=$Variables; Functions=$Functions; Aliases=$Aliases; Location=(Microsoft.PowerShell.Management\Get-Location).ProviderPath; NativeDirectory=[Environment]::CurrentDirectory; Culture=$Culture; UICulture=$UICulture; Features=$FeatureNames; StyleXml=$StyleXml; VersionXml=$VersionXml; EngineVariables=$EngineVariables; ApartmentState=[Threading.Thread]::CurrentThread.GetApartmentState().ToString() }
  try {
    $Body = {
      param($__shellspanJobSource,$__shellspanJobSnapshot,$__shellspanJobState,$__shellspanRestore,$__shellspanVersionSnapshot,$__shellspanStyleSnapshot)
      try {
        $__shellspanStatusSink=Microsoft.PowerShell.Core\Get-Command Trace-ShellSpanJobStatus -CommandType Cmdlet -ErrorAction Stop
        $__shellspanDefaultSetter=Microsoft.PowerShell.Core\Get-Command Microsoft.PowerShell.Utility\New-Variable -CommandType Cmdlet -ErrorAction Stop
        $__shellspanDefaultEntry=$null
        $__shellspanCulture=[Globalization.CultureInfo]::new($__shellspanJobSnapshot.Culture.Name,$__shellspanJobSnapshot.Culture.UseUserOverride)
        if($__shellspanJobSnapshot.Culture.NativeType-ne 'System.Globalization.CultureInfo'){
          if($__shellspanJobState.RuntimeCulture.GetType().FullName-cne $__shellspanJobSnapshot.Culture.NativeType -or $__shellspanJobState.RuntimeCulture.Name-cne $__shellspanJobSnapshot.Culture.Name -or $__shellspanJobState.RuntimeCulture.UseUserOverride-ne $__shellspanJobSnapshot.Culture.UseUserOverride){throw 'Native worker culture type differs from caller; source was not executed'}
          $__shellspanCulture=$__shellspanJobState.RuntimeCulture.Clone()
        }
        if($__shellspanJobSnapshot.Culture.IsReadOnly){$__shellspanCulture=[Globalization.CultureInfo]::ReadOnly($__shellspanCulture)}
        $__shellspanUICulture=[Globalization.CultureInfo]::new($__shellspanJobSnapshot.UICulture.Name,$__shellspanJobSnapshot.UICulture.UseUserOverride)
        if($__shellspanJobSnapshot.UICulture.NativeType-ne 'System.Globalization.CultureInfo'){
          if($__shellspanJobState.RuntimeUICulture.GetType().FullName-cne $__shellspanJobSnapshot.UICulture.NativeType -or $__shellspanJobState.RuntimeUICulture.Name-cne $__shellspanJobSnapshot.UICulture.Name -or $__shellspanJobState.RuntimeUICulture.UseUserOverride-ne $__shellspanJobSnapshot.UICulture.UseUserOverride){throw 'Native worker UI culture type differs from caller; source was not executed'}
          $__shellspanUICulture=$__shellspanJobState.RuntimeUICulture.Clone()
        }
        if($__shellspanJobSnapshot.UICulture.IsReadOnly){$__shellspanUICulture=[Globalization.CultureInfo]::ReadOnly($__shellspanUICulture)}
        [Threading.Thread]::CurrentThread.CurrentCulture=$__shellspanCulture
        [Threading.Thread]::CurrentThread.CurrentUICulture=$__shellspanUICulture
        $__shellspanValueModule=Microsoft.PowerShell.Core\New-Module -ScriptBlock ([scriptblock]::Create(('function ConvertFrom-ShellSpanJobValue {'+$__shellspanRestore+'}; function Get-ShellSpanJobVersionSnapshot {'+$__shellspanVersionSnapshot+'}; function Get-ShellSpanJobStyleSnapshot {'+$__shellspanStyleSnapshot+'}')))
        $__shellspanValueRestore=& $__shellspanValueModule { ${function:ConvertFrom-ShellSpanJobValue} }
        $__shellspanVersionRestore=& $__shellspanValueModule { ${function:Get-ShellSpanJobVersionSnapshot} }
        $__shellspanStyleRestore=& $__shellspanValueModule { ${function:Get-ShellSpanJobStyleSnapshot} }
        if((& $__shellspanVersionRestore $PSVersionTable)-cne $__shellspanJobSnapshot.VersionXml){throw 'Native worker version state differs from caller; source was not executed'}
        $__shellspanFeatures=@($EnabledExperimentalFeatures | Microsoft.PowerShell.Core\Where-Object {$null-ne $_} | Microsoft.PowerShell.Utility\Sort-Object -CaseSensitive)
        if([string]::Join([char]0,$__shellspanFeatures) -cne [string]::Join([char]0,@($__shellspanJobSnapshot.Features))){throw 'Native worker engine features differ from caller; source was not executed'}
        foreach($__shellspanEngineVariable in $__shellspanJobSnapshot.EngineVariables){
          $__shellspanEngineValue=$ExecutionContext.SessionState.PSVariable.Get(('global:'+$__shellspanEngineVariable.Name)).Value
          if($null-eq $__shellspanEngineValue -or $__shellspanEngineValue.GetType()-ne $__shellspanEngineVariable.Value.GetType() -or -not [object]::Equals($__shellspanEngineValue,$__shellspanEngineVariable.Value)){throw ('Native worker engine identity '+$__shellspanEngineVariable.Name+' differs from caller; source was not executed')}
        }
        if($null-ne $__shellspanJobSnapshot.StyleXml -and (& $__shellspanStyleRestore $PSStyle)-cne $__shellspanJobSnapshot.StyleXml){throw 'Native worker style differs from caller; source was not executed'}
        foreach ($__shellspanJobEntry in $__shellspanJobSnapshot.Variables) {
          $__shellspanDecoded=& $__shellspanValueRestore $__shellspanJobEntry.Value
          if($__shellspanJobEntry.Name-eq 'PSDefaultParameterValues'){$__shellspanDefaultEntry=$__shellspanJobEntry;$__shellspanDefaultValue=$__shellspanDecoded;continue}
          $__shellspanJobExisting = Microsoft.PowerShell.Utility\Get-Variable -Scope Global -Name ([System.Management.Automation.WildcardPattern]::Escape($__shellspanJobEntry.Name)) -ErrorAction SilentlyContinue
          if ($null -ne $__shellspanJobExisting -and ($__shellspanJobExisting.Options -band [System.Management.Automation.ScopedItemOptions]'ReadOnly,Constant')) { continue }
          Microsoft.PowerShell.Utility\New-Variable -Scope Global -Name $__shellspanJobEntry.Name -Value $__shellspanDecoded -Option $__shellspanJobEntry.Options -Force -ErrorAction Stop
        }
        foreach ($__shellspanJobEntry in $__shellspanJobSnapshot.Functions) {
          $__shellspanExistingFunction=Microsoft.PowerShell.Management\Get-Item -LiteralPath ('Function:'+$__shellspanJobEntry.Name) -ErrorAction SilentlyContinue
          if($null-ne $__shellspanExistingFunction -and ($__shellspanExistingFunction.Options-band [System.Management.Automation.ScopedItemOptions]::Constant)){
            if($__shellspanExistingFunction.Definition-ceq $__shellspanJobEntry.Definition -and $__shellspanExistingFunction.Options-eq $__shellspanJobEntry.Options){continue}
            throw 'Native function state cannot replace a different constant function'
          }
          Microsoft.PowerShell.Management\Set-Item -LiteralPath ('Function:global:'+$__shellspanJobEntry.Name) -Value ([scriptblock]::Create($__shellspanJobEntry.Definition)) -Options $__shellspanJobEntry.Options -Force -ErrorAction Stop
        }
        foreach ($__shellspanJobEntry in $__shellspanJobSnapshot.Aliases) {
          $__shellspanJobExisting = Microsoft.PowerShell.Utility\Get-Alias -Name ([System.Management.Automation.WildcardPattern]::Escape($__shellspanJobEntry.Name)) -ErrorAction SilentlyContinue
          if ($null -ne $__shellspanJobExisting -and $__shellspanJobExisting.Definition -eq $__shellspanJobEntry.Definition -and $__shellspanJobExisting.Options -eq $__shellspanJobEntry.Options) { continue }
          Microsoft.PowerShell.Utility\Set-Alias -Scope Global -Name $__shellspanJobEntry.Name -Value $__shellspanJobEntry.Definition -Option $__shellspanJobEntry.Options -Force -ErrorAction Stop
        }
        Microsoft.PowerShell.Management\Set-Location -LiteralPath $__shellspanJobSnapshot.Location -ErrorAction Stop
        $__shellspanNativeBreakpoint=Microsoft.PowerShell.Utility\Set-PSBreakpoint -Command '*' -ErrorAction Stop
        $__shellspanJobState.NativeBreakpointId=$__shellspanNativeBreakpoint.Id
        & {
          if($null-ne $__shellspanDefaultEntry){& $__shellspanDefaultSetter -Scope Global -Name PSDefaultParameterValues -Value $__shellspanDefaultValue -Option $__shellspanDefaultEntry.Options -Force -ErrorAction Stop}
          $__shellspanJobState.SourceStarted = $true
          $__shellspanJobState.TrackingActive = $true
          try {
            $__shellspanJobRunnable = [ShellSpanJobHost]::InstrumentSource($__shellspanJobSource)
            & $__shellspanJobRunnable
          } finally { $__shellspanJobState.TrackingActive=$false }
        # Out-Default is special-cased by the native engine as standalone
        # console IO; StopProcessing deliberately does not kill that process.
        # An explicit native host sink keeps engine-owned process cancellation
        # and streams objects directly without completion-time job replay.
        } *>&1 | & $__shellspanStatusSink -State $__shellspanJobState | Microsoft.PowerShell.Core\Out-Host
      } catch {
        $__shellspanJobState.CaughtError = $true
        if($_.Exception.GetType().Assembly-eq [System.Management.Automation.PSObject].Assembly -and $_.Exception.GetType().FullName-eq 'System.Management.Automation.NativeCommandExitException'){$__shellspanJobState.CaughtNativeExit=$_.Exception.ExitCode}
        $_ | Microsoft.PowerShell.Core\Out-Default
      } finally {
        if ($__shellspanJobState.SourceStarted) {
          if($null-ne $__shellspanJobState.CaughtNativeExit){$__shellspanJobState.ExitCode=$__shellspanJobState.CaughtNativeExit}
          elseif($__shellspanJobState.CaughtError){$__shellspanJobState.ExitCode=1}
          elseif ($__shellspanJobState.SourceSucceeded -eq $false -and $__shellspanJobState.SourceNativeTrackingTrusted) {
            $__shellspanJobState.ExitCode = if ($__shellspanJobState.SourceNativeInvocations-gt 0 -and $__shellspanJobState.SourceLastCmdletErrorNativeCount-lt $__shellspanJobState.SourceNativeInvocations -and $__shellspanJobState.SourceNativeExitCode -is [int] -and $__shellspanJobState.SourceNativeExitCode -ne 0) { $__shellspanJobState.SourceNativeExitCode } else { 1 }
          }
          elseif ($__shellspanJobState.SourceReturned -and $__shellspanJobState.SourceSucceeded -eq $true) { $__shellspanJobState.ExitCode = 0 }
        }
        # An exit/stop that bypassed observable status is unknown, not zero.
        $__shellspanJobState.Published = $true
      }
    }
    $Packet=@{Source=$Source;Snapshot=$Snapshot;SignalSource=$script:ConsoleSignalSource;HostSource=$script:NativeJobHostSource;Body=$Body.ToString();Restore=${function:ConvertFrom-ShellSpanJobValue}.ToString();VersionSnapshot=${function:Get-ShellSpanJobVersionSnapshot}.ToString();StyleSnapshot=${function:Get-ShellSpanJobStyleSnapshot}.ToString();Worker=$script:NativeJobWorker}
    $CurrentProcess=[Diagnostics.Process]::GetCurrentProcess()
    try{$Executable=$CurrentProcess.MainModule.FileName}finally{$CurrentProcess.Dispose()}
    if([IO.Path]::GetFileName($Executable)-notin @('powershell.exe','pwsh.exe')){throw 'Native jobs require a standard PowerShell console executable'}
    $Job=[ShellSpanProcessJob]::new($Executable,$Snapshot.NativeDirectory,[System.Management.Automation.PSSerializer]::Serialize($Packet,100))
    $script:NativeShellJobs[$Handle] = @{ Job=$Job; InstanceId=$Job.InstanceId }
    Send-ShellSpanControl @('B',$Handle,'running','-')
  } catch { Send-ShellSpanControl @('B',$Handle,'uncertain','-') }
}
function Invoke-ShellSpanNativeJobControl {
  param([string]$Handle,[string]$Action)
  $Entry = $script:NativeShellJobs[$Handle]
  if ($null -eq $Entry) { Send-ShellSpanControl @('B',$Handle,'uncertain','-'); return }
  if ($Entry.Job -isnot [ShellSpanProcessJob] -or $Entry.Job.InstanceId -ne $Entry.InstanceId) {
    Send-ShellSpanControl @('B',$Handle,'uncertain','-'); return
  }
  if ($Action -eq 'stop' -and $Entry.Job.ActiveProcesses -gt 0) {
    try { $Entry.Job.Stop() } catch { Send-ShellSpanControl @('B',$Handle,'uncertain','-'); return }
    Send-ShellSpanControl @('B',$Handle,'stopRequested','-')
    return
  }
  if ($Entry.Job.ActiveProcesses -eq 0 -and $Entry.Job.HasExited) {
    if ($Entry.Job.StopRequested) {
      Send-ShellSpanControl @('B',$Handle,'terminated','-')
    } else {
      try {
        if(-not $Entry.Job.ResultReady){Send-ShellSpanControl @('B',$Handle,'uncertain','-');return}
        $Result=[System.Management.Automation.PSSerializer]::Deserialize($Entry.Job.ReadResult())
        if(-not $Result.SourceStarted){Send-ShellSpanControl @('B',$Handle,'rejected','-')}
        elseif($Result.Published -and $null-ne $Result.ExitCode){Send-ShellSpanControl @('F',$Handle,[string]$Result.ExitCode);Send-ShellSpanControl @('B',$Handle,'settled','-')}
        else{Send-ShellSpanControl @('B',$Handle,'uncertain','-');return}
      } catch {Send-ShellSpanControl @('B',$Handle,'uncertain','-');return}
    }
    $Entry.Job.Dispose()
    $script:NativeShellJobs.Remove($Handle)
    return
  }
  Send-ShellSpanControl @('B',$Handle,'running','-')
}
