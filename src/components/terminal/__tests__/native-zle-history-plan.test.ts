import {describe,it,expect} from 'vitest';
import {zleHistoryArgumentJson} from './native-zle-history-plan';
describe('exact ZLE history source instruction',()=>{
 it('round trips decomposition, emoji, literal CR/Tab/LF and JSON quoting without normalization',()=>{
  const args={command:'typeset P="中文-e\u0301-👩🏽‍💻"; builtin printf "literal!!\\n"\r\t\n',background:false,timeoutMs:10000};
  const encoded=zleHistoryArgumentJson(args);
  expect(/[^\x00-\x7f]/.test(encoded)).toBe(false);
  expect(JSON.parse(encoded)).toEqual(args);
  expect(JSON.parse(encoded).command).toContain('e\u0301');
  expect(JSON.parse(encoded).command).not.toContain('é');
 });
});
