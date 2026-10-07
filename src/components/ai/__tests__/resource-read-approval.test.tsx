import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AiApprovalPanel } from '../workspace/ai-approval-panel';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';

beforeEach(async () => { useAppStore.setState({ locale: 'en-US' }); await initI18n('en-US'); });
afterEach(cleanup);

it('merges cache writes with operation approval, resets scope for a new call and keeps pending controls disabled', async () => {
  const approval: AiPendingApproval = {
    sessionId:'cache',turnId:'turn',stepId:'step',requestId:'request',callId:'call',approvalId:'cache-approval',
    risk:'stateChange',effect:'stateChange',prompt:null,reason:null,expiresAtUnixMs:null,toolName:'run_terminal_command',target:null,
    arguments:{command:'pnpm build',writePaths:['/tmp/owned-project-cache']},evidenceRefs:[],
  };
  let scope: 'once' | 'session' | undefined;
  const onApprove = (value?: 'once' | 'session') => { scope = value; };
  const { rerender } = render(<AiApprovalPanel approval={approval} decision={null} error={null} onApprove={onApprove} onReject={() => {}} onOpenDetails={() => {}} />);
  const user = userEvent.setup();
  expect(screen.getByText('/tmp/owned-project-cache')).toBeVisible();
  expect(screen.getByText('Cache directory read/write authorization for this execution')).toBeVisible();
  const picker = screen.getByRole('combobox', {name:'Resource authorization scope'});
  expect(picker).toHaveTextContent('This call');
  await user.click(picker);
  await user.click(await screen.findByRole('option', {name:'Current session'}));
  expect(screen.getByText('Cache directory read/write authorization for this session')).toBeVisible();
  await user.click(screen.getByRole('button', {name:'Allow once'}));
  expect(scope).toBe('session');
  rerender(<AiApprovalPanel approval={{...approval,callId:'second-call'}} decision={null} error={null} onApprove={onApprove} onReject={() => {}} onOpenDetails={() => {}} />);
  expect(screen.getByRole('combobox')).toHaveTextContent('This call');
  expect(screen.getByRole('heading')).toHaveFocus();
  rerender(<AiApprovalPanel approval={approval} decision="approve" error={null} onApprove={onApprove} onReject={() => {}} onOpenDetails={() => {}} />);
  expect(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.getByRole('button', {name:'Allow once'})).toBeDisabled();
  expect(screen.getByRole('button', {name:'Cancel'})).toBeDisabled();
});

it('shows the exact file and per-call scope in the same operation approval', async () => {
  let approved = 0;
  let approvedScope: 'once' | 'session' | undefined;
  render(<AiApprovalPanel approval={{
    sessionId:'resource-read', turnId:'turn', stepId:'step', requestId:'request', callId:'call', approvalId:'approval',
    risk:'sensitiveRead', effect:'sensitiveRead', prompt:null, reason:null, expiresAtUnixMs:null,
    toolName:'run_terminal_command', target:{kind:'local', targetId:'local', sessionId:'terminal', cwd:'/project'},
    arguments:{command:'cat .env.production', readPaths:['/project/.env.production']}, evidenceRefs:[],
    sandboxCapability:{status:'partial', files:true, network:true, processLifecycle:false, gaps:[]},
  }} decision={null} error={null} onApprove={scope => { approved += 1; approvedScope = scope; }} onReject={() => {}} onOpenDetails={() => {}} />);
  expect(screen.getByText('File read authorization: this foreground call only')).toBeVisible();
  expect(screen.getByText('/project/.env.production')).toBeVisible();
  expect(screen.getByText(/Files may contain credentials/)).toBeVisible();
  expect(screen.getByText(/This command enforces project path/)).toBeVisible();
  expect(screen.queryByText(/without.*sandbox/i)).toBeNull();
  const user = userEvent.setup();
  expect(screen.getByRole('combobox', {name:'File authorization scope'})).toHaveTextContent('This call');
  await user.click(screen.getByRole('combobox', {name:'File authorization scope'}));
  await user.click(await screen.findByRole('option', {name:'Current session'}));
  expect(screen.getByText('File read authorization: current session')).toBeVisible();
  expect(screen.getByText(/Up to one hour/)).toBeVisible();
  const buttons = screen.getAllByRole('button');
  const approve = buttons.find(button => button.textContent?.includes('Allow'));
  expect(approve).toBeDefined();
  await userEvent.click(approve!);
  expect(approved).toBe(1);
  expect(approvedScope).toBe('session');
});

it('shows exact network targets, opaque HTTPS scope and per-call authorization', async () => {
  let approved = false;
  render(<AiApprovalPanel approval={{
    sessionId:'network', turnId:'turn', stepId:'step', requestId:'request', callId:'call', approvalId:'approval-network',
    risk:'externalSideEffect', effect:'externalSideEffect', prompt:null, reason:null, expiresAtUnixMs:null,
    toolName:'run_terminal_command', target:{kind:'local', targetId:'local', sessionId:'terminal', cwd:'/project'},
    arguments:{command:'pnpm view react version', networkTargets:[{host:'registry.npmjs.org',port:443}]}, evidenceRefs:[],
    sandboxCapability:{status:'partial', files:true, network:true, processLifecycle:false, gaps:[]},
  }} decision={null} error={null} onApprove={() => { approved = true; }} onReject={() => {}} onOpenDetails={() => {}} />);
  expect(screen.getByText('registry.npmjs.org:443')).toBeVisible();
  expect(screen.getByText('Network target authorization for this execution')).toBeVisible();
  expect(screen.getByText(/HTTPS contents are not decrypted/)).toBeVisible();
  expect(screen.queryByRole('combobox', {name:'File authorization scope'})).toBeNull();
  expect(screen.getByRole('combobox', {name:'Resource authorization scope'})).toHaveTextContent('This call');
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', {name:'Resource authorization scope'}));
  await user.click(await screen.findByRole('option', {name:'Current session'}));
  expect(screen.getByText('Network target authorization for this session')).toBeVisible();
  expect(screen.getByText(/same files, cache directories, network targets and DNS choice/)).toBeVisible();
  const button = screen.getAllByRole('button').find(button => button.textContent?.includes('Allow'));
  await userEvent.click(button!);
  expect(approved).toBe(true);
});
