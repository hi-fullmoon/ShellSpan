import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// tauri-utils 2.10 platform.rs uses this exact marker for BundleType::Nsis.
// The bundler patches the packaged image and restores the compile output.
const unbundled=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const nsis=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function verifyNsisInstalledImage(compiled,installed){
  const compiledSha256=sha(compiled),installedSha256=sha(installed);
  if(compiledSha256===installedSha256)return{compiledSha256,installedSha256,expectedPackagedSha256:compiledSha256,markerOffset:null};
  const offset=compiled.indexOf(unbundled);
  assert(offset>=0&&compiled.indexOf(unbundled,offset+1)===-1,'Compiled Tauri bundle marker is missing or ambiguous');
  const expected=Buffer.from(compiled);nsis.copy(expected,offset);
  const expectedPackagedSha256=sha(expected);
  assert.equal(installedSha256,expectedPackagedSha256,'Installed PE differs beyond the exact Tauri NSIS bundle marker');
  return{compiledSha256,installedSha256,expectedPackagedSha256,markerOffset:offset};
}
