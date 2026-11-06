import {expect,it} from 'vitest';
import {packageAdmissionCases,packageAdmissionFault,admissionBootstrapList} from '../native-input-p3/windows-package-admission.mjs';
const id='powershell-7.6.9-psreadline-2.4.5-shellspan1-conpty1.25.260930003-graphemes-windows-x64-native';
const catalogue={version:1,sources:{'src-tauri/native-input-editors/src/lib.rs':'a'.repeat(64)},profiles:[{profile:{shell:'powerShell7',adapterVersion:'1',verifiedProfileId:id},module:id+'/shellspan_native_input_editors.dll',moduleSha256:'b'.repeat(64)}]};
it('reads the actual witness object rather than treating it as an array or missing data as empty',()=>{
 expect(admissionBootstrapList({bootstraps:[]})).toEqual([]);
 expect(admissionBootstrapList({bootstraps:[{directory:'owned'}]})).toHaveLength(1);
 expect(()=>admissionBootstrapList([])).toThrow('Invalid actual');
 expect(()=>admissionBootstrapList({})).toThrow('Invalid actual');
});
it('keeps positive controls and changes only explicitly selected fault metadata',()=>{
 const baseline=structuredClone(catalogue),bytes=Buffer.from('fixture bytes,not a native receipt');
 for(const name of packageAdmissionCases.filter(name=>name!=='missing-handoff')){
  const fault=packageAdmissionFault(catalogue,'powerShell7',name,bytes);expect(catalogue).toEqual(baseline);expect(bytes.toString()).toBe('fixture bytes,not a native receipt');expect(fault.bytes).toEqual(bytes);
  expect(fault.expectedNative).toBe(['baseline','restored'].includes(name));
  expect(fault.module).not.toContain('..');
  if(name==='unknown-profile')expect(fault.module).toContain('shellspan9');
  if(name==='wrong-platform')expect(fault.module).toContain('macos-arm64');
 }
 expect(()=>packageAdmissionFault(catalogue,'powerShell7','unreviewed',bytes)).toThrow('Unknown admission case');
 expect(()=>packageAdmissionFault(catalogue,'missing','baseline',bytes)).toThrow('host missing');
});
