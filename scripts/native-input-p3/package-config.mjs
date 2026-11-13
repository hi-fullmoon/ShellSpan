import assert from 'node:assert/strict';
import {resolve,relative,isAbsolute,sep,posix} from 'node:path';
import {selectWindowsProfiles} from './windows-profiles.mjs';
import {nativeInputGeneratedPath,nativeInputReleaseDirectory} from '../native-input-p2/resource-paths.mjs';

export function windowsPackageHost(shell='powerShell7'){
  const [profile]=selectWindowsProfiles([shell]);
  return {...profile,executable:'D:/Programs/PowerShell/7/pwsh.exe'};
}

export function windowsPackageScenario(value,validationOnly){
  assert(value===undefined||value==='model-file-chain'||value==='model-semantics'||value==='model-validation'||value==='manual-display'||value==='resource-admission','Unsupported package scenario');
  assert(value===undefined||validationOnly,'Native package scenario requires explicit validation resources');
  return {modelChain:value==='model-file-chain'||value==='model-semantics'||value==='model-validation',manualDisplay:value==='manual-display'};
}

// FrontendDist tries URL deserialization before PathBuf. A Windows drive prefix
// becomes an opaque URL, so pass an explicit path relative to the Tauri crate.
export function packageFrontendDirectory(root,directory){
  const path=relative(resolve(root,'src-tauri'),resolve(directory));
  assert(path&&!isAbsolute(path),'Frontend assets must be on the Tauri project drive');
  return path.split(sep).join('/');
}

export function validationPackageMarker(root,installedResources,sourceManifestSha256){
  const directory=resolve(installedResources),base=resolve(root,'.artifacts/tests/pk'),child=relative(base,directory);
  assert(child&&!child.startsWith('..')&&!isAbsolute(child),'Validation installation must stay inside the owned package cases');
  assert(/^[a-f0-9]{64}$/.test(sourceManifestSha256),'Exact source manifest digest required');
  return {protocol:'shellspan.native-editor-validation',resourceRoot:directory,sourceManifestSha256,editorTargets:['windows-x64']};
}

export function packageResourceMapping(root){
  // Use the normalized absolute path for the Windows installer inputs.
  const configuredPath=posix.relative('src-tauri',nativeInputGeneratedPath);
  return {[`${configuredPath}/`]:null,
    [nativeInputReleaseDirectory(root)+'/']:'native-input/generated/'};
}

export function assertPackageResourcePaths(root,install,files){
  for(const file of files){
    assert(file&&!isAbsolute(file)&&!file.split(/[\\/]/).includes('..'),'Relative resource required');
    for(const absolute of [resolve(nativeInputReleaseDirectory(root),file),resolve(install,'native-input/generated',file)])
      assert(absolute.length<260,`NSIS resource path exceeds MAX_PATH (${absolute.length}): ${absolute}`);
  }
}
