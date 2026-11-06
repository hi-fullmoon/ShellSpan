/** Exact user-authored dot-source expressions; the native adapter adds no wrapper. */
export function nativeValidationCommands(token:string,cwd:string):readonly string[]{
 if(!/^[a-f0-9-]{36}$/.test(token)||!cwd)throw Error('Owned validation identity required');
 const quoted="'"+cwd.replace(/'/g,"''")+"'";
 return [
  "$global:B04GoodValidationCount=0; . { param([ValidateScript({$global:B04GoodValidationCount++; [Console]::WriteLine('B04_VALIDATOR_'+'GOOD'); $_ -ceq 'OK'})][string]$B04GoodArg) $B04ValidatedValue=$B04GoodArg; [Console]::WriteLine('B04_VALID_BODY_'+'OK') } 'OK'",
  `$global:B04BadValidationCount=0; . { param([ValidateScript({$global:B04BadValidationCount++; [Console]::WriteLine('B04_VALIDATOR_'+'BAD'); throw 'B04_EXPECTED_ARGUMENT_FAILURE'})][string]$B04BadArg) [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'semantic-body-${token}.txt'),'BODY'); [Console]::WriteLine('B04_BODY_'+'UNEXPECTED') } 'BAD'`,
  `if($B04Bare -cne 'PARENT' -or (B04ParentFn) -cne 'FN' -or $B04Header -cne 'HEADER' -or $B04ValidatedValue -cne 'OK' -or $global:B04GoodValidationCount -ne 1 -or $global:B04BadValidationCount -ne 1){throw 'validation or parent state changed'}; if((Get-Location).ProviderPath -cne ${quoted}){throw 'cwd changed'}; [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'scratch-effect-${token}.txt'),'ONCE'+[Environment]::NewLine); [Console]::WriteLine('B04_RECOVERY_'+'OK')`,
 ];
}
