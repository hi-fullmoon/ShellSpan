import {expect,it} from 'vitest';
import {matchesNativeFileChainStep,nativeFileChainPathIdentity,nativeFileCoreSetup,readNativeFileLoadedCore} from './native-file-chain-approval';
const plan={fileName:'owned.ps1',content:'approved content',setup:'approved setup',invoke:"& 'D:\\owned\\owned.ps1'",absolutePath:'D:\\owned\\owned.ps1'};
it('reads exactly one computed OS module observation and never the echoed setup source',()=>{
 const path='D:\\owned\\editors\\shellspan_native_input_editors.dll',sha256='a'.repeat(64),line=`NATIVE_CORE_LOADED:${path}|${sha256}|1234`;
 expect(readNativeFileLoadedCore('setup output\r\n'+line+'\r\n')).toEqual({path,sha256,pid:1234});
 expect(readNativeFileLoadedCore('\u001b[6n'+line+'\r\n')).toEqual({path,sha256,pid:1234});
 for(const output of [nativeFileCoreSetup,line+'\n'+line,line.replace(sha256,'bad'),line.replace('|1234','|0'),line.replace('|1234','|999999999999999999999'),line.replace(path,'relative.dll'),line.replace(path,'D:\\owned\\other.dll')])expect(readNativeFileLoadedCore(output)).toBeNull();
});
it('compares canonical Windows drive paths while retaining the returned invocation spelling',()=>{
 expect(nativeFileChainPathIdentity('\\\\?\\D:\\owned\\owned.ps1')).toBe('D:/owned/owned.ps1');
 expect(nativeFileChainPathIdentity('D:/owned/owned.ps1')).toBe('D:/owned/owned.ps1');
 for(const path of ['owned.ps1','\\\\?\\UNC\\host\\share\\owned.ps1','\\\\.\\D:\\owned.ps1'])expect(nativeFileChainPathIdentity(path)).toBeNull();
 const extended={...plan,absolutePath:'\\\\?\\D:\\owned\\owned.ps1',invoke:"& '\\\\?\\D:\\owned\\owned.ps1'"};
 expect(matchesNativeFileChainStep(3,'run_terminal_command',{command:extended.invoke,timeoutMs:5000},extended)).toBe(true);
 expect(matchesNativeFileChainStep(3,'run_terminal_command',{command:plan.invoke,timeoutMs:5000},extended)).toBe(false);
});
it('allows only the predetermined scratch file and absent-file precondition',()=>{
 const args={fileScope:'scratch',path:plan.fileName,content:plan.content,precondition:{mustNotExist:true}};
 expect(matchesNativeFileChainStep(1,'write_file',args,plan)).toBe(true);
 for(const change of [{fileScope:'workspace'},{path:'other.ps1'},{content:'different'},{content:plan.content+'\n'},{content:plan.content+'\r\n'},{content:plan.content+'\r'},{precondition:{sha256:'0'.repeat(64)}}])expect(matchesNativeFileChainStep(1,'write_file',{...args,...change},plan)).toBe(false);
});
it('binds native foreground invocation to the returned path without a Direct override',()=>{
 const args={command:plan.invoke,background:false,timeoutMs:5000};expect(matchesNativeFileChainStep(3,'run_terminal_command',args,plan)).toBe(true);
 expect(matchesNativeFileChainStep(3,'run_terminal_command',{command:plan.invoke,timeoutMs:5000},plan)).toBe(true);
 for(const change of [{command:'different'},{background:true},{lifecycleTrust:'direct'},{timeoutMs:10000}])expect(matchesNativeFileChainStep(3,'run_terminal_command',{...args,...change},plan)).toBe(false);
 expect(matchesNativeFileChainStep(3,'run_terminal_command',args,{...plan,invoke:undefined})).toBe(false);
});
it('bounds the actual scratch read and rejects wrong tools or extra steps',()=>{
 const args={fileScope:'scratch',path:plan.fileName,encoding:'utf8'};expect(matchesNativeFileChainStep(2,'read_file',args,plan)).toBe(true);
 expect(matchesNativeFileChainStep(2,'read_file',{...args,path:plan.absolutePath},plan)).toBe(true);
 expect(matchesNativeFileChainStep(2,'read_file',{...args,maxBytes:8193},plan)).toBe(false);
 expect(matchesNativeFileChainStep(2,'write_file',args,plan)).toBe(false);expect(matchesNativeFileChainStep(4,'read_file',args,plan)).toBe(false);
});
