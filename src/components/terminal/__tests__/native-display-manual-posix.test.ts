import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {macDisplayOutputCommand} from './native-display-manual-posix';
import {nativeDisplaySamples} from './native-display-manual-plan';

it.skipIf(process.platform!=='darwin')('writes exact display samples through the real macOS POSIX pipeline',()=>{
 const payload=Object.values(nativeDisplaySamples).join('\n');
 const command=macDisplayOutputCommand(payload);
 expect(command.endsWith('\r')).toBe(true);
 expect(command.slice(0,-1)).not.toMatch(/[\r\n]/);
 const actual=execFileSync('/bin/sh',['-c',command.slice(0,-1)]);
 expect(actual.equals(Buffer.from(payload+'\n','utf8'))).toBe(true);
 expect(actual.includes(Buffer.from('e\u0301'))).toBe(true);
});
it('rejects invalid fixture input before constructing a shell command',()=>{
 expect(()=>macDisplayOutputCommand('invalid\0text')).toThrow('NUL');
});
