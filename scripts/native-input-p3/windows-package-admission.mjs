import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {renameNativeExport} from './windows-native-export.mjs';

export const packageAdmissionCases=Object.freeze(['baseline','unknown-source','unknown-adapter','unknown-profile','bad-digest','wrong-platform','wrong-shell-family','missing-handoff','restored']);
export function admissionBootstrapList(witness){assert(witness&&Array.isArray(witness.bootstraps),'Invalid actual bootstrap witness');return witness.bootstraps;}
export function packageAdmissionFault(original,host,name,library){
 assert(packageAdmissionCases.includes(name),'Unknown admission case');assert(Buffer.isBuffer(library));
 const catalogue=structuredClone(original),selected=catalogue.profiles.find(entry=>entry.profile.shell===host);assert(selected,'Admission host missing');let bytes=Buffer.from(library);
 if(name==='unknown-source')catalogue.sources['src-tauri/native-input-editors/src/lib.rs']='0'.repeat(64);
 if(name==='unknown-adapter')selected.profile.adapterVersion='unreviewed-build';
 if(name==='unknown-profile')selected.profile.verifiedProfileId=selected.profile.verifiedProfileId.replace('shellspan1','shellspan9');
 if(name==='bad-digest')selected.moduleSha256='0'.repeat(64);
 if(name==='wrong-platform')selected.profile.verifiedProfileId=selected.profile.verifiedProfileId.replace('windows-x64','macos-arm64');
 if(name==='wrong-shell-family')selected.profile.shell=host==='powerShell7'?'windowsPowerShell':'powerShell7';
 if(name==='missing-handoff'){bytes=renameNativeExport(bytes,'ss_editor_guarded_handoff','xs_editor_guarded_handoff');selected.moduleSha256=createHash('sha256').update(bytes).digest('hex');}
 if(['unknown-profile','wrong-platform'].includes(name))selected.module=selected.profile.verifiedProfileId+'/shellspan_native_input_editors.dll';
 assert(/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(selected.profile.verifiedProfileId));assert.equal(selected.module,selected.profile.verifiedProfileId+'/shellspan_native_input_editors.dll');
 return{catalogue,module:selected.module,bytes,expectedNative:['baseline','restored'].includes(name),expectedRaw:!['baseline','restored','missing-handoff'].includes(name),explicitAbiRefusal:name==='missing-handoff'};
}
