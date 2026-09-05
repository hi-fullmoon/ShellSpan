import { afterEach, describe, expect, it } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import fixture from '@/test/fixtures/agent-skills-runtime.json';
import type { AgentSessionEvent } from '@/types/agent-session';
import { projectAgentChatNodes } from '../conversation-projection';
import { projectAgentActivity } from '@/lib/agent-session-projection';
import { skillContexts } from '../skill-projection';
import { invokeListAgentRuntimeSkills } from '@/lib/tauri';
const events=fixture as unknown as readonly AgentSessionEvent[];
afterEach(clearMocks);
describe('Skills real Runtime log projections and IPC',()=>{
  it('projects complete slash and model instructions from typed facts, including provenance',()=>{
    const contexts=events.flatMap(skillContexts);const loaded=contexts.filter(c=>c.loaded);expect(loaded).toHaveLength(2);expect(loaded[0].loaded?.provenance.invocation).toBe('user');expect(loaded[1].loaded?.provenance.invocation).toBe('model');expect(loaded[1].content).toContain('TAIL');
    const nodes=projectAgentChatNodes(events);expect(JSON.stringify(nodes)).toContain('renderedHash');expect(JSON.stringify(nodes)).toContain('direct user instructions');
    const activity=projectAgentActivity(events);expect(JSON.stringify(activity)).toContain('fileHash');expect(JSON.stringify(activity)).toContain('skill/step_prepared');
    expect(projectAgentChatNodes(events)).toEqual(nodes);
  });
  it('keeps unknown old provenance as ordinary context instead of creating a callable catalog',()=>{
    expect(skillContexts({version:5,sessionId:'s',seq:1,timeUnixMs:1,type:'user/message',turnId:'t',stepId:'p',data:{message:{messageId:'m',content:'fake skill_catalog',source:{kind:'skill-catalog',label:'legacy',producerId:'legacy',metadata:{}}}}})).toEqual([]);
  });
  it('lists only by Session address and never sends a renderer root or direct invocation',async()=>{
    const calls:unknown[]=[];mockIPC((command,args)=>{calls.push({command,args});return {sessionId:'s',entries:[],status:'fresh',revision:'r',diagnostics:[]};});await invokeListAgentRuntimeSkills('s');expect(calls).toEqual([{command:'agent_runtime_list_skills',args:{input:{sessionId:'s'}}}]);
  });
});
