import {expect,it} from 'vitest';
import {verifyNsisInstalledImage} from '../native-input-p3/windows-package-image.mjs';
import {packageFrontendDirectory,validationPackageMarker,packageResourceMapping,assertPackageResourcePaths,windowsPackageHost,windowsPackageScenario} from '../native-input-p3/package-config.mjs';
import {windowsShortSnapshotLocation} from '../native-input-p3/windows-profiles.mjs';
import path from 'node:path';

it('requires an explicit validation context for model and manual display package scenarios',()=>{
 expect(windowsPackageScenario(undefined,false)).toEqual({modelChain:false,manualDisplay:false});
 expect(windowsPackageScenario('manual-display',true)).toEqual({modelChain:false,manualDisplay:true});
 expect(windowsPackageScenario('model-file-chain',true)).toEqual({modelChain:true,manualDisplay:false});
 expect(windowsPackageScenario('model-semantics',true)).toEqual({modelChain:true,manualDisplay:false});
 expect(windowsPackageScenario('model-validation',true)).toEqual({modelChain:true,manualDisplay:false});
 expect(windowsPackageScenario('resource-admission',true)).toEqual({modelChain:false,manualDisplay:false});
 expect(()=>windowsPackageScenario('resource-admission',false)).toThrow('validation resources');
 expect(()=>windowsPackageScenario('manual-display',false)).toThrow('validation resources');
 expect(()=>windowsPackageScenario('model-file-chain',false)).toThrow('validation resources');
 expect(()=>windowsPackageScenario('model-semantics',false)).toThrow('validation resources');
 expect(()=>windowsPackageScenario('model-validation',false)).toThrow('validation resources');
 expect(()=>windowsPackageScenario('unreviewed',true)).toThrow('Unsupported');
});

it('selects reviewed installed-package hosts explicitly without falling back',()=>{
 expect(windowsPackageHost()).toEqual({shell:'powerShell7',expectedVersion:'7.6.9',executable:'D:/Programs/PowerShell/7/pwsh.exe'});
 expect(windowsPackageHost('windowsPowerShell')).toEqual({shell:'windowsPowerShell',expectedVersion:'5.1.26100.9818',executable:'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'});
 expect(()=>windowsPackageHost('unreviewed-host')).toThrow('Unsupported Windows host');
});

it('keeps both native profile paths within NSIS limits without changing their identities',()=>{
 // Pure path budgeting must not assume the test checkout itself is short.
 // A sealed source copy is deliberately deeper than the packaging workspace.
 const owner=path.resolve(path.parse(path.resolve(import.meta.dirname)).root,'owned'),root=windowsShortSnapshotLocation(owner,'12345678-1234-1234-1234-123456789abc').root;
 const install=path.join(root,'.artifacts/tests/pk/12345678/i');
 const profiles=['powershell-7.6.9','windows-powershell-5.1.26100.9818'].map(host=>`${host}-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native/shellspan_native_input_editors.dll`);
 expect(()=>assertPackageResourcePaths(root,install,profiles)).not.toThrow();
 expect(()=>assertPackageResourcePaths(root,path.join(install,'too-long-install-directory'),profiles)).toThrow('MAX_PATH');
 expect(()=>assertPackageResourcePaths(path.join(root,'long'.repeat(80)),install,profiles)).toThrow('MAX_PATH');
 expect(()=>assertPackageResourcePaths(root,install,['../escape'])).toThrow('Relative resource');
 const mapping=packageResourceMapping(root);
 expect(mapping['../.artifacts/releases/native-input/generated/']).toBeNull();
 expect(mapping[path.resolve(root,'.artifacts/releases/native-input/generated')+'/']).toBe('native-input/generated/');
});

it('binds explicit validation package markers only to owned source-context installations',()=>{
 const root=path.resolve(import.meta.dirname,'../..'),resources=path.join(root,'.artifacts/tests/pk/owned/install/native-input/generated'),digest='a'.repeat(64);
 expect(validationPackageMarker(root,resources,digest)).toEqual({protocol:'shellspan.native-editor-validation',resourceRoot:resources,sourceManifestSha256:digest,editorTargets:['windows-x64']});
 expect(()=>validationPackageMarker(root,path.join(root,'external-install'),digest)).toThrow('owned package cases');
 expect(()=>validationPackageMarker(root,resources,'bad')).toThrow('manifest digest');
});

it('passes frontend assets as a relative directory rather than a Windows drive URL',()=>{
  const root=path.resolve(import.meta.dirname,'../..');
  const frontend=path.join(root,'.artifacts/tests/frontend');
  const configured=packageFrontendDirectory(root,frontend);
  expect(path.resolve(root,'src-tauri',configured)).toBe(frontend);
  expect(configured).toBe('../.artifacts/tests/frontend');
  expect(configured).not.toContain(':');
});

it('checks the complete image allowing only the exact SDK NSIS bundle marker',()=>{
  const compiled=Buffer.from('header\0__TAURI_BUNDLE_TYPE_VAR_UNK\0payload');
  const installed=Buffer.from('header\0__TAURI_BUNDLE_TYPE_VAR_NSS\0payload');
  const proof=verifyNsisInstalledImage(compiled,installed);
  expect(proof.markerOffset).toBe(7);
  expect(proof.installedSha256).toBe(proof.expectedPackagedSha256);
  expect(verifyNsisInstalledImage(compiled,compiled).markerOffset).toBeNull();
  const changed=Buffer.from(installed);changed[0]^=1;
  expect(()=>verifyNsisInstalledImage(compiled,changed)).toThrow('differs beyond');
  expect(()=>verifyNsisInstalledImage(Buffer.from('other'),installed)).toThrow('missing or ambiguous');
  expect(()=>verifyNsisInstalledImage(Buffer.concat([compiled,compiled]),installed)).toThrow('missing or ambiguous');
});
