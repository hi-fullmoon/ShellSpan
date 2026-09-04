import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AiSkillsMenu } from '../workspace/ai-skills-menu';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { SkillUserList } from '@/types/agent-skill';
const list: SkillUserList = { sessionId: 's', revision: 'r', status: 'fresh', diagnostics: [], entries: [{ name: 'one', description: 'Do one thing', relativePath: '.agents/skills/one.md', resourceBase: '.agents/skills', modelInvocable: false, userInvocable: true, fileHash: 'a', instructionHash: 'b', extensions: {} }] };
beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);
describe('Skills menu', () => {
  it('allows explicit project-root input before making a request', async () => {
    const user = userEvent.setup(); const query = vi.fn(async () => list);
    render(<AiSkillsMenu needsRoot targetLabel="Local" query={query} onSelect={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Skills' }));
    expect(query).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: 'Project directory' }), '/project');
    await user.click(screen.getByRole('button', { name: 'Load skills' }));
    await waitFor(() => expect(query).toHaveBeenCalledWith('/project'));
  });
  it('queries each opening and only inserts the selected slash', async () => {
    const user=userEvent.setup(); const query=vi.fn(async()=>list);const select=vi.fn();render(<AiSkillsMenu query={query} onSelect={select} />);
    await user.click(screen.getByRole('button',{name:'Skills'}));expect(await screen.findByText('User only')).toBeInTheDocument();await user.click(screen.getByRole('menuitem',{name:/one/}));expect(select).toHaveBeenCalledWith('one');
    await user.click(screen.getByRole('button',{name:'Skills'}));await waitFor(()=>expect(query).toHaveBeenCalledTimes(2));
  });
  it('shows stale status and bounded server diagnostics',async()=>{
    const user=userEvent.setup();render(<AiSkillsMenu query={async()=>({...list,status:'stale',diagnostics:[{path:'one',code:'readFailure',message:'Limit'}]})} onSelect={()=>undefined}/>);await user.click(screen.getByRole('button',{name:'Skills'}));expect(await screen.findByRole('alert')).toHaveTextContent('last known');expect(screen.getByText('one: Limit')).toBeInTheDocument();
  });
  it('drops an old Session response after a task switch',async()=>{
    let resolve!: (value:SkillUserList)=>void;const old=new Promise<SkillUserList>(r=>{resolve=r;});const user=userEvent.setup();const {rerender}=render(<AiSkillsMenu key="old" query={()=>old} onSelect={()=>undefined}/>);await user.click(screen.getByRole('button',{name:'Skills'}));rerender(<AiSkillsMenu key="new" query={async()=>({...list,sessionId:'new',entries:[]})} onSelect={()=>undefined}/>);resolve(list);await user.click(screen.getByRole('button',{name:'Skills'}));expect(await screen.findByText('No user-invocable skills')).toBeInTheDocument();expect(screen.queryByText('Do one thing')).not.toBeInTheDocument();
  });
  it('supports keyboard selection and Chinese unavailable feedback',async()=>{
    const user=userEvent.setup();useAppStore.setState({locale:'zh-CN'});await initI18n('zh-CN');render(<AiSkillsMenu query={async()=>({...list,status:'unavailable',entries:[]})} onSelect={()=>undefined}/>);await user.tab();await user.keyboard('{Enter}');expect(await screen.findByRole('alert')).toHaveTextContent('此目标的技能不可用');
  });
});
