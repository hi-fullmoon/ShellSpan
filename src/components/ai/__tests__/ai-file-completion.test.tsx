import { selectEditorText } from '@/test/composer-editor-user';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { FileReferenceList } from '@/types/agent-file-reference';
const result: FileReferenceList = { entries: [{ path: 'space dir', kind: 'directory' }, { path: 'plain.txt', kind: 'file' }], scope: null, status: 'ready', code: null, excluded: 0 };
const deferred = <T,>() => { let resolve!: (v:T)=>void; let reject!: (e: unknown)=>void; const promise = new Promise<T>((r,j)=>{resolve=r;reject=j;}); return { promise, resolve, reject }; };
beforeEach(async () => { useAppStore.setState({locale:'en-US'}); await initI18n('en-US'); });
afterEach(cleanup);
describe('composer path completion', () => {
  it('reopens a dismissed query after editing away and returning to the same text', async () => {
    const user=userEvent.setup(); const query=vi.fn(async()=>result);
    render(<AiComposerSeat phase="hero" status="idle" onListFileReferences={query}/>);
    const editor=screen.getByRole('textbox');
    await user.type(editor,'@plain'); await screen.findByRole('option',{name:'plain.txt'});
    await user.keyboard('{Escape}'); expect(screen.queryByRole('listbox')).toBeNull();
    await user.clear(editor); await user.type(editor,'@other'); await screen.findByRole('option',{name:'plain.txt'});
    await user.clear(editor); await user.type(editor,'@plain');
    expect(await screen.findByRole('option',{name:'plain.txt'})).toBeVisible();
  });
  it('navigates quoted directories, inserts a file with keyboard, then sends raw text once', async () => {
    const user=userEvent.setup(); const submit=vi.fn(); const query=vi.fn(async (q:string)=>q.includes('/') ? {...result,entries:[{path:'space dir/file name.txt',kind:'file' as const}]} : result);
    render(<AiComposerSeat phase="hero" status="idle" onListFileReferences={query} onSubmit={submit}/>);
    const editor=screen.getByRole('textbox'); await user.type(editor,'hello @');
    await screen.findByRole('option',{name:'space dir/'}); await user.keyboard('{Enter}');
    expect(editor.textContent).toBe('hello @"space dir/'); expect(submit).not.toHaveBeenCalled();
    await screen.findByRole('option',{name:'space dir/file name.txt'}); await user.keyboard('{Tab}');
    expect(editor.textContent).toBe('hello @"space dir/file name.txt" '); await user.keyboard('{Enter}');
    expect(submit).toHaveBeenCalledExactlyOnceWith('hello @"space dir/file name.txt" ');
  });
  it('does not send during loading, empty/error results, or IME, and Escape dismisses', async () => {
    const user=userEvent.setup(); const pending=deferred<FileReferenceList>(); const submit=vi.fn(); const query=vi.fn(()=>pending.promise);
    render(<AiComposerSeat phase="hero" status="idle" onListFileReferences={query} onSubmit={submit}/>);
    const editor=screen.getByRole('textbox'); await user.type(editor,'@x'); await waitFor(()=>expect(query).toHaveBeenCalled());
    await user.keyboard('{Enter}'); expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionStart(editor); fireEvent.keyDown(editor,{key:'Enter',isComposing:true,keyCode:229}); expect(submit).not.toHaveBeenCalled(); fireEvent.compositionEnd(editor);
    await act(async()=>pending.resolve({...result,entries:[]})); await screen.findByText('No matching files or directories');
    await user.keyboard('{Enter}'); expect(submit).not.toHaveBeenCalled(); await user.keyboard('{Escape}'); expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('cancels deletion and scope navigation including ABA; stale success/finally never clears new query', async () => {
    const user=userEvent.setup(); const calls:{signal:AbortSignal,work:ReturnType<typeof deferred<FileReferenceList>>}[]=[];
    const query=vi.fn((_q:string,signal:AbortSignal)=>{const work=deferred<FileReferenceList>();calls.push({signal,work});return work.promise;});
    const {rerender}=render(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="A" onListFileReferences={query}/>);
    await user.type(screen.getByRole('textbox'),'@'); await waitFor(()=>expect(calls).toHaveLength(1));
    rerender(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="B" onListFileReferences={query}/>); await waitFor(()=>expect(calls).toHaveLength(2));
    rerender(<AiComposerSeat phase="hero" status="idle" skillsScopeKey="A" onListFileReferences={query}/>); await waitFor(()=>expect(calls).toHaveLength(3));
    expect(calls[0].signal.aborted && calls[1].signal.aborted).toBe(true);
    await act(async()=>{calls[0].work.resolve(result);calls[1].work.reject(new Error('old'));});
    expect(screen.getByText('Listing paths…')).toBeVisible(); expect(screen.queryByRole('option')).toBeNull();
    await act(async()=>calls[2].work.resolve({...result,entries:[{path:'new.txt',kind:'file'}]}));
    expect(await screen.findByRole('option')).toHaveTextContent('new.txt');
    await user.clear(screen.getByRole('textbox')); expect(calls[2].signal.aborted).toBe(true); expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('uses active caret rather than the end, preserves email and suffix, and selects by mouse', async () => {
    const user=userEvent.setup();const query=vi.fn(async()=>result);
    render(<AiComposerSeat phase="hero" status="idle" defaultDraft="email a@b.com and @plxxx suffix" onListFileReferences={query}/>);
    const editor=screen.getByRole('textbox') as HTMLDivElement; await user.click(editor); await act(async () => selectEditorText(editor, 20,20));
    await user.click(await screen.findByRole('option',{name:'plain.txt'}));
    expect(editor.textContent!).toBe('email a@b.com and @plain.txt suffix');
  });
  it('asks explicitly for a root without calling discovery, and displays localized failures', async () => {
    const user=userEvent.setup();const query=vi.fn(async(_q:string,_signal:AbortSignal,_root?:string)=>({...result,status:'error' as const,code:'Denied',entries:[]}));
    render(<AiComposerSeat phase="hero" status="idle" skillsNeedsRoot projectTargetLabel="Remote target" onListFileReferences={query}/>);
    await user.type(screen.getByRole('textbox'),'@'); expect(query).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await user.type(screen.getByRole('textbox',{name:'Project directory'}),'/project');
    await user.click(screen.getByRole('button',{name:'Bind directory'})); expect(await screen.findByRole('alert')).toHaveTextContent('access was denied');
    expect(query.mock.calls[0]?.[0]).toBe('');
    expect(screen.getByTestId('ai-workspace-composer').textContent).toBe('@');
  });
});
