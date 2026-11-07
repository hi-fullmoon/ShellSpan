import {beforeEach,expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {initI18n,t} from '@/locales';
import zh from '@/locales/zh-CN';
import en from '@/locales/en-US';
import {NativeDisplayManualInstructions} from './native-display-manual-instructions';
import {nativeDisplaySamples} from './native-display-manual-plan';
beforeEach(async()=>{await initI18n('zh-CN');});
const props=()=>({ready:true,started:false,busy:false,step:0,message:t('terminal.acceptance.ready'),onStart:vi.fn(),onVerify:vi.fn(),onDefer:vi.fn()});
it('shows readable Chinese instructions and the exact sample before starting, with primary action in CardAction',async()=>{
 const actions=props();const {rerender}=render(<NativeDisplayManualInstructions {...actions} ready={false}/>);
 const start=screen.getByRole('button',{name:'开始手工验收'});
 expect(start).toBeDisabled();expect(start.closest('[data-slot="card-action"]')).not.toBeNull();
 expect(screen.getByRole('heading',{name:'原生终端手工验收'})).toBeVisible();
 expect(screen.getByText('第 1 步，共 6 步')).toBeVisible();
 expect(screen.getByLabelText(t('terminal.acceptance.sample')).textContent).toBe(nativeDisplaySamples.ascii);
 expect(screen.getByTestId('manual-instructions')).toHaveClass('min-h-0','max-h-[45vh]','shrink-0');
 expect(screen.getByRole('status').closest('[data-slot="card-content"]')).toHaveClass('min-h-0','overflow-auto');
 rerender(<NativeDisplayManualInstructions {...actions}/>);
 await userEvent.tab();expect(start).toHaveFocus();await userEvent.keyboard('{Enter}');
 expect(actions.onStart).toHaveBeenCalledTimes(1);expect(actions.onVerify).not.toHaveBeenCalled();
});
it('makes verification and deferring distinct, and requires a second action to close the window',async()=>{
 const actions=props();render(<NativeDisplayManualInstructions {...actions} started step={4}/>);
 expect(screen.getByText(t('terminal.acceptance.step5'))).toBeVisible();
 expect(screen.getByLabelText(t('terminal.acceptance.sample')).textContent).toBe(nativeDisplaySamples.hard);
 await userEvent.click(screen.getByRole('button',{name:'验证这一步'}));expect(actions.onVerify).toHaveBeenCalledTimes(1);
 await userEvent.click(screen.getByRole('button',{name:'暂缓验收…'}));expect(actions.onDefer).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'继续操作'}));expect(actions.onDefer).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'暂缓验收…'}));
 await userEvent.click(screen.getByRole('button',{name:'确认暂缓并关闭'}));expect(actions.onDefer).toHaveBeenCalledTimes(1);
});
it('keeps instruction keys aligned in both languages, including the final scrolling step',async()=>{
 expect(Object.keys(zh).filter(k=>k.startsWith('terminal.acceptance.'))).toEqual(Object.keys(en).filter(k=>k.startsWith('terminal.acceptance.')));
 await initI18n('en-US');render(<NativeDisplayManualInstructions {...props()} started step={5}/>);
 expect(screen.getByText('Step 6 of 6')).toBeVisible();
 expect(screen.getByText(t('terminal.acceptance.step6'))).toBeVisible();
 expect(screen.getByLabelText(t('terminal.acceptance.sample')).textContent).toBe(nativeDisplaySamples.history);
 expect(screen.getByRole('button',{name:'Verify this step'})).toBeEnabled();
});
it('names the actual macOS copy shortcut without changing the Windows instruction',()=>{
 render(<NativeDisplayManualInstructions ready started busy={false} step={4} macCopy message="" onStart={()=>{}} onVerify={()=>{}} onDefer={()=>{}}/>);
 expect(screen.getByText(t('terminal.acceptance.step5Mac'))).toBeVisible();
 expect(screen.getByText(t('terminal.acceptance.step5Mac')).textContent).toContain('⌘C');
 expect(screen.queryByText(t('terminal.acceptance.step5'))).toBeNull();
});
