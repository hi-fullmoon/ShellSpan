param([Parameter(Mandatory=$true)][string]$Bootstrap,[Parameter(Mandatory=$true)][string]$Report)
$ErrorActionPreference='Stop'
if([IO.Path]::GetFileName($Bootstrap)-ne 'shellspan-integration.ps1'-or -not [IO.Path]::IsPathRooted($Report)){throw 'Expected an owned generated integration and absolute diagnostic path'}
$text=[IO.File]::ReadAllText($Bootstrap)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Generated integration did not parse before diagnostic instrumentation'}
$functions=@($ast.FindAll({param($node) $node-is [Management.Automation.Language.FunctionDefinitionAst]-and $node.Name-eq 'Install-ShellSpanNativeInput'},$true))
if($functions.Count-ne 1){throw 'Expected exactly one native input installer'}
$statements=@($functions[0].Body.EndBlock.Statements|Where-Object {$_-is [Management.Automation.Language.TryStatementAst]})
if($statements.Count-ne 1-or $statements[0].CatchClauses.Count-ne 1){throw 'Unexpected native installer catch structure'}
$snippet=@'

      $__shellspan_install_error = $_
      $__shellspan_diagnostic_errors = $Error.Clone()
      try {
        $__shellspan_install_record = @{ kind='actual-native-input-installation-error'; errorId=[string]$__shellspan_install_error.FullyQualifiedErrorId; exceptionType=$__shellspan_install_error.Exception.GetType().FullName; historySavePath=[string](PSReadLine\Get-PSReadLineOption).HistorySavePath }
        [IO.File]::WriteAllText('__REPORT_LITERAL__', (Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -InputObject $__shellspan_install_record))
      } catch { } finally { $Error.Clear(); $Error.AddRange($__shellspan_diagnostic_errors) }

'@
$snippet=$snippet.Replace('__REPORT_LITERAL__',$Report.Replace("'","''"))
$offset=$statements[0].CatchClauses[0].Body.Extent.StartOffset+1
$instrumented=$text.Insert($offset,$snippet)
$prompts=@($ast.FindAll({param($node) $node-is [Management.Automation.Language.FunctionDefinitionAst]-and $node.Name-eq 'Invoke-ShellSpanPrompt'},$true))
if($prompts.Count-ne 1-or -not $prompts[0].Body.ParamBlock){throw 'Expected exactly one prompt function with an explicit parameter block'}
$promptSnippet=@'

    $__shellspan_prompt_diagnostic_errors = $Error.Clone()
    try {
      if ($script:NativeEditorTransaction -and -not $script:NativePromptRedraw) {
        $__shellspan_editor_frames = @([Diagnostics.StackTrace]::new().GetFrames() | ForEach-Object { $m=$_.GetMethod(); if ($null-ne $m-and $null-ne $m.DeclaringType-and $m.DeclaringType.FullName-eq 'Microsoft.PowerShell.PSConsoleReadLine') { @{name=$m.Name;public=$m.IsPublic;static=$m.IsStatic} } })
        if ($__shellspan_editor_frames.Count) {
          [IO.File]::WriteAllText('__REPORT_LITERAL__.prompt-origin.json',(Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 5 -Compress -InputObject @{kind='actual-editor-origin-prompt-outside-explicit-redraw-scope';frames=$__shellspan_editor_frames;commandActive=$script:CommandActive}))
        }
      }
    } catch { } finally { $Error.Clear(); $Error.AddRange($__shellspan_prompt_diagnostic_errors) }

'@
$promptSnippet=$promptSnippet.Replace('__REPORT_LITERAL__',$Report.Replace("'","''"))
# The prompt function precedes the installer, so its original AST offset is
# unchanged by the later catch insertion. No execution branch is suppressed.
if($prompts[0].Body.ParamBlock.Extent.EndOffset-ge $offset){throw 'Unexpected prompt/installer source ordering'}
$instrumented=$instrumented.Insert($prompts[0].Body.ParamBlock.Extent.EndOffset,$promptSnippet)
# Record only phase durations, never caller variables or command text. Insert
# after actual statements and observe the existing rejection catch unchanged.
$phaseTokens=$null;$phaseErrors=$null
$phaseAst=[Management.Automation.Language.Parser]::ParseInput($instrumented,[ref]$phaseTokens,[ref]$phaseErrors)
if($phaseErrors.Count){throw 'Diagnostic source did not parse before capture observation'}
$starts=@($phaseAst.FindAll({param($node) $node-is [Management.Automation.Language.FunctionDefinitionAst]-and $node.Name-eq 'Invoke-ShellSpanNativeJobStart'},$true))
if($starts.Count-ne 1){throw 'Expected exactly one native job starter'}
$captureTries=@($starts[0].Body.FindAll({param($node) $node-is [Management.Automation.Language.TryStatementAst]-and $node.Body.Extent.Text.Contains('$script:NativeStateCaptureClock=[Diagnostics.Stopwatch]::StartNew()')},$true))
if($captureTries.Count-ne 1-or $captureTries[0].CatchClauses.Count-ne 1){throw 'Unexpected native state capture structure'}
$originalCommands=@($starts[0].Body.FindAll({param($node) $node-is [Management.Automation.Language.CommandAst]},$true)|ForEach-Object {$_.Extent.Text})
$originalCaptureStatements=@($captureTries[0].Body.Statements|ForEach-Object {$_.Extent.Text})
$insertions=@()
foreach($statement in $captureTries[0].Body.Statements){
  $phase=if($statement.Extent.Text.StartsWith('$script:NativeStateCaptureClock=')){'start'}elseif($statement-is [Management.Automation.Language.TryStatementAst]){'engine-defaults'}elseif($statement.Extent.Text.StartsWith('$GlobalVariables=')){'global-variable-list'}elseif($statement.Extent.Text.StartsWith('$StyleXml=')){'style'}elseif($statement.Extent.Text.StartsWith('$VersionXml=')){'version'}elseif($statement.Extent.Text.StartsWith('$Variables =')){'caller-variables'}else{$null}
  if($phase){
    $observation=if($phase-eq 'start'){'$script:__shellspan_capture_phases=[Collections.Generic.List[object]]::new()'}else{"`$script:__shellspan_capture_phases.Add(@{phase='$phase';elapsedMs=`$script:NativeStateCaptureClock.ElapsedMilliseconds})"}
    $insertions+=[pscustomobject]@{offset=[int]$statement.Extent.EndOffset;text="`n    $observation`n"}
  }
}
$captureFailure=@'

    $__shellspan_capture_error = $_
    $__shellspan_capture_errors = $Error.Clone()
    try {
      [IO.File]::WriteAllText('__REPORT_LITERAL__.state-capture.json',(Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 5 -Compress -InputObject @{kind='actual-native-state-capture-rejection';elapsedMs=$script:NativeStateCaptureClock.ElapsedMilliseconds;phases=@($script:__shellspan_capture_phases.ToArray());reason=$__shellspan_capture_error.Exception.Message}))
    } catch { } finally { $Error.Clear(); $Error.AddRange($__shellspan_capture_errors) }
    $_=$__shellspan_capture_error

'@
$insertions+=[pscustomobject]@{offset=[int]($captureTries[0].CatchClauses[0].Body.Extent.StartOffset+1);text=$captureFailure.Replace('__REPORT_LITERAL__',$Report.Replace("'","''"))}
$orderedInsertions=@($insertions|Sort-Object -Property {[int]$_.offset} -Descending)
$previousOffset=$instrumented.Length+1
foreach($insertion in $orderedInsertions){
  if($insertion.offset-lt 0-or $insertion.offset-ge $previousOffset){throw 'Diagnostic insertion offsets must be strictly descending'}
  $instrumented=$instrumented.Insert($insertion.offset,$insertion.text)
  $previousOffset=$insertion.offset
}
$tokens=$null;$errors=$null
$finalAst=[Management.Automation.Language.Parser]::ParseInput($instrumented,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Instrumented integration did not parse'}
$observedJobStart=@($finalAst.FindAll({param($node) $node-is [Management.Automation.Language.FunctionDefinitionAst]-and $node.Name-eq 'Invoke-ShellSpanNativeJobStart'},$true))
$observedCapture=@($observedJobStart[0].Body.FindAll({param($node) $node-is [Management.Automation.Language.TryStatementAst]-and $node.Body.Extent.Text.Contains('$script:NativeStateCaptureClock=[Diagnostics.Stopwatch]::StartNew()')},$true))
if($observedJobStart.Count-ne 1-or $observedCapture.Count-ne 1){throw 'Instrumented job structure changed'}
$comparisons=@(
  [pscustomobject]@{name='command';expected=$originalCommands;actual=@($observedJobStart[0].Body.FindAll({param($node) $node-is [Management.Automation.Language.CommandAst]},$true)|ForEach-Object {$_.Extent.Text})}
  [pscustomobject]@{name='capture statement';expected=$originalCaptureStatements;actual=@($observedCapture[0].Body.Statements|ForEach-Object {$_.Extent.Text})}
)
foreach($comparison in $comparisons){
  $next=0
  foreach($expected in $comparison.expected){
    while($next-lt $comparison.actual.Count-and $comparison.actual[$next]-cne $expected){$next++}
    if($next-ge $comparison.actual.Count){throw ('Diagnostic changed an original '+$comparison.name+' AST')}
    $next++
  }
}
[IO.File]::WriteAllText($Bootstrap,$instrumented,[Text.UTF8Encoding]::new($false))
# This function is static public project code, containing no control-channel
# secret or caller source/value. Never export the full generated bootstrap.
@{kind='test-only-native-installer-catch-observation';bootstrapSha256=(Get-FileHash -LiteralPath $Bootstrap).Hash.ToLowerInvariant();originalFailureUnchanged=$true;deadlinesUnchanged=$true;originalCommandsPreserved=$true;originalCaptureStatementsPreserved=$true;originalCommandCount=$originalCommands.Count;insertionOffsets=@($orderedInsertions|ForEach-Object {$_.offset});stateCaptureFunction=$observedJobStart[0].Extent.Text}|ConvertTo-Json -Depth 5|Set-Content -Encoding utf8 ($Report+'.instrumentation.json')
