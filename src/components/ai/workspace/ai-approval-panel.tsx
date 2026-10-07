import { useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChevronRightIcon, ShieldAlertIcon } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/empty-state';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { useI18n } from '@/hooks/useI18n';
import type { AiPendingApproval } from '@/lib/ai/session-adapter';
import type { LocaleKey } from '@/locales';
import type { AgentSessionEffect } from '@/types/agent-session';
import { AiErrorNotice } from './ai-error-notice';

export interface AiApprovalPanelProps {
  readonly approval: AiPendingApproval;
  readonly decision: 'approve' | 'reject' | null;
  readonly error: string | null;
  readonly argumentsLoading?: boolean;
  readonly argumentsError?: string | null;
  readonly onApprove: (scope?: 'once' | 'session') => void;
  readonly onReject: () => void;
  readonly onOpenDetails: () => void;
}

function targetLabel(approval: AiPendingApproval): string {
  const target = approval.target;
  if (!target) return approval.callId;
  return target.label ?? target.host ?? target.targetId;
}

function argumentString(approval: AiPendingApproval, key: string): string | null {
  if (!approval.arguments || typeof approval.arguments !== 'object' || Array.isArray(approval.arguments)) return null;
  const value = (approval.arguments as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function trimmedArgumentString(approval: AiPendingApproval, key: string): string | null {
  const value = argumentString(approval, key)?.trim();
  return value ? value : null;
}

function isMachinePrompt(value: string): boolean {
  return value.length > 240
    || value.includes('\n')
    || /Session task|Native effect:|Sensitive paths:|Network destinations:|TTL:/i.test(value);
}

function intentLabel(approval: AiPendingApproval): string | null {
  const explanation = trimmedArgumentString(approval, 'explanation');
  if (explanation) return explanation;
  const prompt = approval.prompt?.trim();
  return prompt && !isMachinePrompt(prompt) ? prompt : null;
}

const APPROVAL_ACTION_KEYS: Readonly<Record<string, LocaleKey>> = {
  list_directory: 'ai.workspace.approval.action.listDirectory',
  read_file: 'ai.workspace.approval.action.readFile',
  write_file: 'ai.workspace.approval.action.writeFile',
  edit_file: 'ai.workspace.approval.action.editFile',
  search_text: 'ai.workspace.approval.action.searchText',
  trash_file: 'ai.workspace.approval.action.trashFile',
};

const APPROVAL_RISK_KEYS = {
  none: {
    label: 'ai.workspace.approval.risk.none',
    description: 'ai.workspace.approval.risk.none.description',
  },
  readOnly: {
    label: 'ai.workspace.approval.risk.readOnly',
    description: 'ai.workspace.approval.risk.readOnly.description',
  },
  sensitiveRead: {
    label: 'ai.workspace.approval.risk.sensitiveRead',
    description: 'ai.workspace.approval.risk.sensitiveRead.description',
  },
  stateChange: {
    label: 'ai.workspace.approval.risk.stateChange',
    description: 'ai.workspace.approval.risk.stateChange.description',
  },
  destructive: {
    label: 'ai.workspace.approval.risk.destructive',
    description: 'ai.workspace.approval.risk.destructive.description',
  },
  externalSideEffect: {
    label: 'ai.workspace.approval.risk.externalSideEffect',
    description: 'ai.workspace.approval.risk.externalSideEffect.description',
  },
  unknown: {
    label: 'ai.workspace.approval.risk.unknown',
    description: 'ai.workspace.approval.risk.unknown.description',
  },
} as const satisfies Record<AgentSessionEffect, { readonly label: LocaleKey; readonly description: LocaleKey }>;

function approvalTitleKey(approval: AiPendingApproval, command: string | null): LocaleKey {
  if (!command) return 'ai.workspace.approval.title';
  return approval.target?.kind === 'remote'
    ? 'ai.workspace.approval.commandTitle.remote'
    : 'ai.workspace.approval.commandTitle.local';
}

function approvalDescriptionKey(approval: AiPendingApproval, command: string | null): LocaleKey {
  if (!command) return 'ai.workspace.approval.description';
  return approval.target?.kind === 'remote'
    ? 'ai.workspace.approval.commandDescription.remote'
    : 'ai.workspace.approval.commandDescription.local';
}

export function AiApprovalPanel({
  approval,
  decision,
  error,
  argumentsLoading = false,
  argumentsError = null,
  onApprove,
  onReject,
  onOpenDetails,
}: AiApprovalPanelProps): React.ReactNode {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [resourceScope, setResourceScope] = useState<'once' | 'session'>('once');
  useEffect(() => { setResourceScope('once'); }, [approval.sessionId, approval.turnId, approval.stepId, approval.requestId, approval.callId, approval.approvalId]);
  const resourceScopeItems = [{value:'once',label:t('ai.workspace.approval.scopeOnce')},{value:'session',label:t('ai.workspace.approval.scopeSession')}];
  const pending = decision !== null;
  const command = argumentString(approval, 'command');
  const inputKind = argumentString(approval, 'inputKind');
  const terminalInputText = approval.toolName === 'write_terminal_input'
    ? argumentString(approval, 'text')
    : null;
  const terminalInput = terminalInputText !== null
    ? JSON.stringify(terminalInputText)
    : approval.toolName === 'write_terminal_input'
      ? argumentString(approval, 'key')
        ?? (inputKind === 'interrupt' ? inputKind : null)
      : null;
  const terminalMatchText = approval.toolName === 'wait_terminal'
    ? argumentString(approval, 'text')
    : null;
  const terminalMatch = terminalMatchText === null ? null : JSON.stringify(terminalMatchText);
  const argumentRecord = approval.arguments && typeof approval.arguments === 'object'
    && !Array.isArray(approval.arguments)
    ? approval.arguments as Record<string, unknown>
    : null;
  const readPaths = Array.isArray(argumentRecord?.readPaths)
    ? argumentRecord.readPaths.filter((value): value is string => typeof value === 'string') : [];
  const writePaths = Array.isArray(argumentRecord?.writePaths)
    ? argumentRecord.writePaths.filter((value): value is string => typeof value === 'string') : [];
  const networkTargets = Array.isArray(argumentRecord?.networkTargets)
    ? argumentRecord.networkTargets.flatMap((value: unknown) => {
      if (!value || typeof value !== 'object' || !('host' in value) || !('port' in value)
        || typeof value.host !== 'string' || typeof value.port !== 'number') return [];
      return [{ endpoint: `${value.host}:${value.port}`, resolver: 'resolver' in value && value.resolver === 'cloudflare' ? 'cloudflare' : 'system' }];
    }) : [];
  const localServices = Array.isArray(argumentRecord?.localServices)
    ? argumentRecord.localServices.flatMap((value: unknown) => value && typeof value === 'object' && 'port' in value && typeof value.port === 'number' ? [`127.0.0.1:${value.port}`] : []) : [];
  const volatileArgumentsRequired = argumentRecord?.contentPersisted === false && (
    approval.toolName === 'write_terminal_input'
      ? inputKind === 'text' || inputKind === 'paste'
      : approval.toolName === 'wait_terminal' && argumentRecord.textProvided === true
  );
  const volatileArgumentsMissing = volatileArgumentsRequired
    && (approval.toolName === 'write_terminal_input'
      ? terminalInputText === null
      : terminalMatchText === null);
  const volatileArgumentsError = argumentsError
    ?? (volatileArgumentsMissing && !argumentsLoading
      ? t('ai.workspace.approval.previewUnavailable')
      : null);
  const exactValue = command ?? terminalInput ?? terminalMatch;
  const action = t(APPROVAL_ACTION_KEYS[approval.toolName] ?? 'ai.workspace.approval.action.tool', {
    tool: approval.toolName,
  });
  const actionPath = argumentString(approval, 'path');
  const searchQuery = approval.toolName === 'search_text' ? argumentString(approval, 'query') : null;
  const exactValueLabel = command
    ? 'ai.workspace.approval.command'
    : terminalMatch
      ? 'ai.workspace.approval.terminalMatch'
      : 'ai.workspace.approval.terminalInput';
  const intent = intentLabel(approval);
  const titleKey = approvalTitleKey(approval, command);
  const descriptionKey = approvalDescriptionKey(approval, command);
  const riskKeys = APPROVAL_RISK_KEYS[approval.risk];
  const recoverableDeletion = approval.toolName === 'trash_file';
  const destructive = approval.risk === 'destructive' && !recoverableDeletion;

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [approval.sessionId, approval.turnId, approval.stepId, approval.requestId, approval.callId, approval.approvalId]);

  return (
    <Card
      className="ai-approval-panel grid min-h-0 max-h-[min(600px,72dvh)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 py-0"
      size="sm"
      role="group"
      aria-labelledby="ai-approval-title"
      aria-describedby="ai-approval-description"
      data-slot="ai-approval-panel"
      data-approval-id={approval.approvalId}
    >
      <CardHeader className="ai-approval-panel-header shrink-0 gap-2 px-4 py-3 has-data-[slot=card-action]:grid-cols-1 @min-[480px]/ai-workspace:has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center text-warning" aria-hidden="true">
            <ShieldAlertIcon />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle className="ai-approval-panel-title">
              <h3 id="ai-approval-title" ref={headingRef} tabIndex={-1} className="outline-none">
                {t(titleKey, { tool: approval.toolName })}
              </h3>
            </CardTitle>
            <CardDescription id="ai-approval-description" className="break-words">
              {t(descriptionKey, { target: targetLabel(approval) })}
            </CardDescription>
          </div>
        </div>
        <CardAction className="col-start-1 row-span-1 row-start-auto justify-self-start pl-9 @min-[480px]/ai-workspace:col-start-2 @min-[480px]/ai-workspace:row-start-1 @min-[480px]/ai-workspace:pl-0">
          <Badge variant={destructive ? 'destructive' : 'outline'}>{t(recoverableDeletion ? 'ai.workspace.approval.trashRecoveryLabel' : riskKeys.label)}</Badge>
        </CardAction>
      </CardHeader>

      <ScrollArea className="min-h-0 min-w-0">
        <ScrollAreaContent style={{ minWidth: 0 }}>
          <CardContent className="flex min-w-0 flex-col gap-3 px-4 pb-2">
            {!exactValue && (
              <div className="flex min-w-0 flex-col gap-1" data-slot="ai-approval-action">
                <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.action')}</p>
                <p className="break-words text-sm">{action}</p>
                {actionPath && (
                  <pre className="ai-approval-command min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] px-3 py-2.5">
                    <code>{actionPath}</code>
                  </pre>
                )}
                {searchQuery && <p className="whitespace-pre-wrap break-words text-sm">{t('ai.workspace.approval.query', { query: searchQuery })}</p>}
              </div>
            )}

            {!command && approval.target && (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.target')}</p>
                <p className="break-words text-sm">{targetLabel(approval)}</p>
              </div>
            )}

            {exactValue && (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">{t(exactValueLabel)}</p>
                <pre className="ai-approval-command min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] px-3 py-2.5">
                  <code>{exactValue}</code>
                </pre>
              </div>
            )}

            {volatileArgumentsMissing && argumentsLoading && !volatileArgumentsError && (
              <Alert variant="subtle" size="sm" role="status">
                <Spinner data-icon="inline-start" />
                <AlertDescription>{t('ai.workspace.approval.previewLoading')}</AlertDescription>
              </Alert>
            )}

            {readPaths.length > 0 && (
              <Alert variant="subtle" size="sm">
                <AlertDescription>
                  <p>{t(resourceScope === 'session' ? 'ai.workspace.approval.sessionReadGrant' : 'ai.workspace.approval.projectReadGrant')}</p>
                  <p>{t('ai.workspace.approval.projectReadGrantNotice')}</p>
                  <ul>{readPaths.map(path => <li className="break-words" key={path}>{path}</li>)}</ul>
                  <Select items={resourceScopeItems} value={resourceScope} disabled={decision !== null} onValueChange={value => { if (value === 'once' || value === 'session') setResourceScope(value); }}>
                    <SelectTrigger size="sm" aria-label={t(writePaths.length || networkTargets.length || localServices.length ? 'ai.workspace.approval.resourceScopeAll' : 'ai.workspace.approval.resourceScope')}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>{resourceScopeItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                  </Select>
                  {resourceScope === 'session' && <p>{t(writePaths.length || networkTargets.length || localServices.length ? 'ai.workspace.approval.scopeResourcesSessionNotice' : 'ai.workspace.approval.scopeSessionNotice')}</p>}
                </AlertDescription>
              </Alert>
            )}

            {writePaths.length > 0 && <Alert variant="subtle" size="sm"><AlertDescription>
              <p>{t(resourceScope === 'session' ? 'ai.workspace.approval.cacheSessionGrant' : 'ai.workspace.approval.cacheGrant')}</p>
              <p>{t('ai.workspace.approval.cacheGrantNotice')}</p>
              <ul>{writePaths.map(path => <li className="break-words" key={path}>{path}</li>)}</ul>
            </AlertDescription></Alert>}

            {networkTargets.length > 0 && (
              <Alert variant="subtle" size="sm">
                <AlertDescription>
                  <p>{t(resourceScope === 'session' ? 'ai.workspace.approval.networkSessionGrant' : 'ai.workspace.approval.networkGrant')}</p>
                  <p>{t('ai.workspace.approval.networkGrantNotice')}</p>
                  <ul>{networkTargets.map(target => <li className="break-words" key={target.endpoint}><span>{target.endpoint}</span><p>{t(target.resolver === 'cloudflare' ? 'ai.workspace.approval.networkDnsCloudflare' : 'ai.workspace.approval.networkDnsSystem')}</p></li>)}</ul>
                </AlertDescription>
              </Alert>
            )}

            {localServices.length > 0 && (
              <Alert variant="subtle" size="sm">
                <AlertDescription>
                  <p>{t(resourceScope === 'session' ? 'ai.workspace.approval.localServiceSessionGrant' : 'ai.workspace.approval.localServiceGrant')}</p>
                  <p>{t('ai.workspace.approval.localServiceGrantNotice')}</p>
                  <ul>{localServices.map(address => <li className="break-words" key={address}>{address}</li>)}</ul>
                </AlertDescription>
              </Alert>
            )}

            {volatileArgumentsError && (
              <AiErrorNotice title={t('ai.workspace.approval.previewUnavailableTitle')}>
                {volatileArgumentsError}
              </AiErrorNotice>
            )}

            {readPaths.length === 0 && (writePaths.length > 0 || networkTargets.length > 0 || localServices.length > 0) && (
              <Alert variant="subtle" size="sm"><AlertDescription>
                <Select items={resourceScopeItems} value={resourceScope} disabled={decision !== null} onValueChange={value => { if (value === 'once' || value === 'session') setResourceScope(value); }}>
                  <SelectTrigger size="sm" aria-label={t('ai.workspace.approval.resourceScopeAll')}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{resourceScopeItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                {resourceScope === 'session' && <p>{t('ai.workspace.approval.scopeResourcesSessionNotice')}</p>}
              </AlertDescription></Alert>
            )}

            {intent && (
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2">
                <p className="text-xs font-medium text-muted-foreground">{t('ai.workspace.approval.intent')}</p>
                <p className="break-words text-sm">{intent}</p>
              </div>
            )}

            <Alert
              className="items-center [&>svg]:translate-y-0"
              variant={destructive ? 'destructive' : 'warning'}
              size="sm"
              role="note"
            >
              <ShieldAlertIcon />
              <AlertDescription className="flex flex-wrap items-center gap-x-1">
                <span className="font-medium">{t('ai.workspace.approval.impact')}</span>
                <span>{t(approval.toolName === 'trash_file' ? 'ai.workspace.approval.trashImpact' : riskKeys.description)}</span>
                {command && <span>{t(approval.sandboxCapability?.files && approval.sandboxCapability.network ? 'ai.workspace.approval.sandboxedImpact' : 'ai.workspace.approval.unsandboxedImpact')}</span>}
              </AlertDescription>
            </Alert>

            <Button variant="ghost" size="xs" className="self-start" onClick={onOpenDetails}>
              {t('ai.workspace.approval.fullParameters')}
              <ChevronRightIcon data-icon="inline-end" />
            </Button>

            {error && (
              <AiErrorNotice title={t('ai.workspace.recovery.title')}>
                {error}
              </AiErrorNotice>
            )}
          </CardContent>
        </ScrollAreaContent>
      </ScrollArea>

      <CardFooter className="ai-approval-panel-footer shrink-0 justify-end gap-2 px-4 pt-2 pb-3">
        <Button size="sm" variant="outline" disabled={pending} onClick={onReject} aria-label={t('ai.workspace.approval.reject')}>
          {decision === 'reject' && <Spinner data-icon="inline-start" />}
          {t('ai.workspace.approval.reject')}
        </Button>
        <Button size="sm" variant="warning" disabled={pending || volatileArgumentsMissing} aria-busy={argumentsLoading || undefined} onClick={() => { if (readPaths.length || writePaths.length || networkTargets.length || localServices.length) onApprove(resourceScope); else onApprove(); }} aria-label={t(approval.toolName === 'trash_file' ? 'ai.workspace.approval.action.trashFile' : 'ai.workspace.approval.approveOnce')}>
          {decision === 'approve' && <Spinner data-icon="inline-start" />}
          {t(approval.toolName === 'trash_file' ? 'ai.workspace.approval.action.trashFile' : 'ai.workspace.approval.approveOnce')}
        </Button>
      </CardFooter>
      <span className="sr-only" aria-live="polite">
        {pending ? t('ai.workspace.approval.pending') : error}
      </span>
    </Card>
  );
}
