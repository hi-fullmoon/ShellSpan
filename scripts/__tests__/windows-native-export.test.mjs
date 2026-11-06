import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {nativeExportRva,nativeExports,renameNativeExport} from '../native-input-p3/windows-native-export.mjs';

it.runIf(process.platform==='win32'&&process.arch==='x64')('resolves a real Node x64 native export and rejects an absent symbol',()=>{
  const bytes=readFileSync(process.execPath);expect(nativeExportRva(bytes,'napi_get_version')).toBeGreaterThan(0);
  expect(()=>nativeExportRva(bytes,'shellspan_absent_export')).toThrow('PE export not found');
});
it.runIf(process.platform==='win32'&&process.arch==='x64')('renames one real export while preserving every other address and sorted ordinal lookup',()=>{
  const bytes=readFileSync(process.execPath),before=nativeExports(bytes),replacement='xapi_get_version',mutant=renameNativeExport(bytes,'napi_get_version',replacement);
  expect(nativeExports(bytes)).toEqual(before);
  expect(()=>nativeExportRva(mutant,'napi_get_version')).toThrow('PE export not found');
  expect(nativeExportRva(mutant,replacement)).toBe(nativeExportRva(bytes,'napi_get_version'));
  expect(nativeExports(mutant)).toEqual(before.map(value=>value.name==='napi_get_version'?{...value,name:replacement}:value).sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name))));
  expect(()=>renameNativeExport(bytes,'napi_get_version','napi_get_version')).toThrow('distinct');
  expect(()=>renameNativeExport(bytes,'napi_get_version','short')).toThrow('Equal-length');
});
it('rejects truncated and non-PE export inputs',()=>{
  for(const bytes of [Buffer.alloc(0),Buffer.from('not a PE'),Buffer.from([0x4d,0x5a])])expect(()=>nativeExportRva(bytes,'ss_editor_event')).toThrow();
  expect(()=>nativeExportRva(Buffer.alloc(64),'../invalid')).toThrow('Invalid export lookup');
});
