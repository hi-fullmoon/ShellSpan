import { beforeEach, expect, it, vi } from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn()}));
import { invokeListAgentFileReferences } from '../tauri';
beforeEach(()=>invoke.mockReset());
it('passes only Session, query, and unique request identity and cancels exactly that IPC',async()=>{
  let resolve!:(v:unknown)=>void;
  invoke.mockImplementation((command)=>command==='agent_runtime_list_file_references'?new Promise(r=>{resolve=r;}):Promise.resolve());
  const a=new AbortController();const promise=invokeListAgentFileReferences('session-A','space dir/',a.signal);
  const call=invoke.mock.calls[0];expect(call[0]).toBe('agent_runtime_list_file_references');expect(Object.keys(call[1].input).sort()).toEqual(['query','requestId','sessionId']);
  a.abort();expect(invoke).toHaveBeenLastCalledWith('agent_runtime_cancel_file_references',{input:{sessionId:'session-A',requestId:call[1].input.requestId}});
  resolve({entries:[{path:'late.txt',kind:'file'}]});await expect(promise).rejects.toMatchObject({name:'AbortError'});
});
it('does not dispatch pre-cancelled requests and removes cancellation handler after completion',async()=>{
  const a=new AbortController();a.abort();await expect(invokeListAgentFileReferences('s','',a.signal)).rejects.toMatchObject({name:'AbortError'});expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue({entries:[]});const b=new AbortController();await invokeListAgentFileReferences('s','',b.signal);b.abort();expect(invoke).toHaveBeenCalledTimes(1);
});
