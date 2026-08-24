import React, { useMemo, useState } from 'react';
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CableIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/hooks/useI18n';
import { getErrorMessage } from '@/lib/error';
import { formatBytes, generateId } from '@/lib/utils';
import {
  isPortForwardActive,
  type ManagedPortForwardRuntime,
  usePortForwardStore,
} from '@/stores/portForwardStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile, PortForwardKind, PortForwardRule } from '@/types';

interface PortForwardDialogProps {
  profile?: ConnectionProfile;
  onClose: () => void;
}

interface RuleDraft {
  id?: string;
  name: string;
  kind: PortForwardKind;
  localPort: string;
  remoteHost: string;
  remotePort: string;
  autoStart: boolean;
}

function createDraft(rule?: PortForwardRule): RuleDraft {
  return rule
    ? {
        id: rule.id,
        name: rule.name,
        kind: rule.kind,
        localPort: String(rule.localPort),
        remoteHost: rule.remoteHost,
        remotePort: String(rule.remotePort),
        autoStart: rule.autoStart,
      }
    : {
        name: '',
        kind: 'local',
        localPort: '',
        remoteHost: '127.0.0.1',
        remotePort: '',
        autoStart: false,
      };
}

function latestRuntime(
  runtimes: ManagedPortForwardRuntime[],
  ruleId: string,
): ManagedPortForwardRuntime | undefined {
  const matching = runtimes.filter((runtime) => runtime.configId === ruleId);
  return matching.find(isPortForwardActive) ?? matching[0];
}

function statusVariant(
  status: ManagedPortForwardRuntime['status'] | undefined,
): React.ComponentProps<typeof Badge>['variant'] {
  if (status === 'running') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'starting' || status === 'stopping') return 'secondary';
  return 'outline';
}

export function PortForwardDialog({
  profile: requestedProfile,
  onClose,
}: PortForwardDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const profile = useProfileStore((state) => requestedProfile
    ? state.profiles.find((item) => item.id === requestedProfile.id) ?? requestedProfile
    : undefined);
  const allRuntimes = usePortForwardStore((state) => state.runtimes);
  const runtimes = useMemo(() => profile
    ? allRuntimes.filter((runtime) => runtime.profileId === profile.id)
    : [], [allRuntimes, profile]);
  const [draft, setDraft] = useState<RuleDraft>();
  const [saving, setSaving] = useState(false);
  const rules = profile?.portForwards ?? [];
  const activeCount = runtimes.filter(isPortForwardActive).length;

  const validationError = useMemo(() => {
    if (!draft) return undefined;
    const localPort = Number(draft.localPort);
    const remotePort = Number(draft.remotePort);
    if (!draft.name.trim()) return t('portForward.validation.name');
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
      return t('portForward.validation.port');
    }
    if (!draft.remoteHost.trim()) return t('portForward.validation.host');
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      return t('portForward.validation.port');
    }
    if (
      draft.kind === 'remote'
      && !['127.0.0.1', 'localhost', '::1'].includes(draft.remoteHost.trim())
    ) return t('portForward.validation.remoteLoopback');
    return undefined;
  }, [draft, t]);

  const saveDraft = async (): Promise<void> => {
    if (!profile || !draft || validationError) return;
    const nextRule: PortForwardRule = {
      id: draft.id ?? generateId(),
      name: draft.name.trim(),
      kind: draft.kind,
      localPort: Number(draft.localPort),
      remoteHost: draft.remoteHost.trim(),
      remotePort: Number(draft.remotePort),
      autoStart: draft.autoStart,
    };
    const nextRules = draft.id
      ? rules.map((rule) => rule.id === draft.id ? nextRule : rule)
      : [...rules, nextRule];
    setSaving(true);
    try {
      await useProfileStore.getState().updateProfile(profile.id, { portForwards: nextRules });
      setDraft(undefined);
    } catch (error) {
      useToastStore.getState().addToast(getErrorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (rule: PortForwardRule): Promise<void> => {
    if (!profile) return;
    const runtime = latestRuntime(runtimes, rule.id);
    if (runtime && isPortForwardActive(runtime)) {
      await usePortForwardStore.getState().stop(runtime.operationId).catch(() => {});
    }
    try {
      await useProfileStore.getState().updateProfile(profile.id, {
        portForwards: rules.filter((item) => item.id !== rule.id),
      });
    } catch (error) {
      useToastStore.getState().addToast(getErrorMessage(error), 'error');
    }
  };

  return (
    <Dialog open={Boolean(profile)} onOpenChange={(open) => !open && onClose()}>
      <CompactDialogContent className="max-w-3xl">
        <CompactDialogHeader
          title={t('portForward.title')}
          description={profile
            ? t('portForward.description', { name: profile.name })
            : t('portForward.descriptionEmpty')}
        />

        <CompactDialogBody className="flex flex-1 flex-col gap-3">
          {draft ? (
            <Card size="sm" className="shrink-0">
              <CardHeader>
                <CardTitle>{draft.id ? t('portForward.edit') : t('portForward.create')}</CardTitle>
                <CardDescription>{t('portForward.form.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="port-forward-name">{t('portForward.form.name')}</FieldLabel>
                    <Input
                      id="port-forward-name"
                      autoFocus
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t('portForward.form.kind')}</FieldLabel>
                    <ToggleGroup
                      value={[draft.kind]}
                      onValueChange={(value) => {
                        const kind = value[0] as PortForwardKind | undefined;
                        if (!kind) return;
                        setDraft({
                          ...draft,
                          kind,
                          remoteHost: kind === 'remote' ? '127.0.0.1' : draft.remoteHost,
                        });
                      }}
                      variant="outline"
                      spacing={0}
                    >
                      <ToggleGroupItem value="local">{t('portForward.kind.local')}</ToggleGroupItem>
                      <ToggleGroupItem value="remote">{t('portForward.kind.remote')}</ToggleGroupItem>
                    </ToggleGroup>
                    <FieldDescription>
                      {draft.kind === 'local'
                        ? t('portForward.kind.localDetail')
                        : t('portForward.kind.remoteDetail')}
                    </FieldDescription>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor="port-forward-local-port">
                        {draft.kind === 'local'
                          ? t('portForward.form.listenPort')
                          : t('portForward.form.localTargetPort')}
                      </FieldLabel>
                      <Input
                        id="port-forward-local-port"
                        inputMode="numeric"
                        value={draft.localPort}
                        onChange={(event) => setDraft({ ...draft, localPort: event.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="port-forward-remote-host">
                        {draft.kind === 'local'
                          ? t('portForward.form.remoteTargetHost')
                          : t('portForward.form.remoteListenHost')}
                      </FieldLabel>
                      <Input
                        id="port-forward-remote-host"
                        disabled={draft.kind === 'remote'}
                        value={draft.remoteHost}
                        onChange={(event) => setDraft({ ...draft, remoteHost: event.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="port-forward-remote-port">
                        {draft.kind === 'local'
                          ? t('portForward.form.remoteTargetPort')
                          : t('portForward.form.remoteListenPort')}
                      </FieldLabel>
                      <Input
                        id="port-forward-remote-port"
                        inputMode="numeric"
                        value={draft.remotePort}
                        onChange={(event) => setDraft({ ...draft, remotePort: event.target.value })}
                      />
                    </Field>
                  </div>
                  <Field className="flex-row items-center justify-between rounded-lg border p-3">
                    <div>
                      <FieldLabel htmlFor="port-forward-auto-start">
                        {t('portForward.form.autoStart')}
                      </FieldLabel>
                      <FieldDescription>{t('portForward.form.autoStartDetail')}</FieldDescription>
                    </div>
                    <Switch
                      id="port-forward-auto-start"
                      checked={draft.autoStart}
                      onCheckedChange={(checked) => setDraft({ ...draft, autoStart: checked })}
                    />
                  </Field>
                  <FieldError>{validationError}</FieldError>
                </FieldGroup>
              </CardContent>
              <CardFooter className="justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  disabled={Boolean(validationError) || saving}
                  onClick={() => void saveDraft()}
                >
                  {t('common.save')}
                </Button>
              </CardFooter>
            </Card>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {t('portForward.summary', { configured: rules.length, active: activeCount })}
              </div>
              <Button size="sm" onClick={() => setDraft(createDraft())}>
                {t('portForward.create')}
              </Button>
            </div>
          )}

          {!draft && rules.length === 0 ? (
            <EmptyState
              className="min-h-40"
              icon={<CableIcon />}
              title={t('portForward.emptyTitle')}
              description={t('portForward.emptyDescription')}
            />
          ) : null}

          {!draft ? rules.map((rule) => {
            const runtime = latestRuntime(runtimes, rule.id);
            const active = runtime ? isPortForwardActive(runtime) : false;
            return (
              <Card key={rule.id} size="sm" className="shrink-0">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {rule.name}
                    <Badge variant="outline">
                      {t(`portForward.kind.${rule.kind}`)}
                    </Badge>
                    <Badge variant={rule.autoStart ? 'secondary' : 'outline'}>
                      {rule.autoStart ? t('portForward.mode.auto') : t('portForward.mode.manual')}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {rule.kind === 'local'
                      ? `127.0.0.1:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`
                      : `${rule.remoteHost}:${rule.remotePort} → 127.0.0.1:${rule.localPort}`}
                  </CardDescription>
                  <CardAction>
                    <Badge variant={statusVariant(runtime?.status)}>
                      {t(`portForward.status.${runtime?.status ?? 'idle'}`)}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {runtime ? (
                    <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                      <span>{t('portForward.started')}: {runtime.startedAt
                        ? new Date(runtime.startedAt).toLocaleString()
                        : '—'}</span>
                      <span>{t('portForward.runMode')}: {t(`portForward.mode.${runtime.mode}`)}</span>
                      <span className="flex items-center gap-1">
                        <ArrowUpIcon /> {formatBytes(runtime.bytesSent)}
                      </span>
                      <span className="flex items-center gap-1">
                        <ArrowDownIcon /> {formatBytes(runtime.bytesReceived)}
                      </span>
                    </div>
                  ) : null}
                  {runtime?.lastError ? (
                    <Alert variant="destructive">
                      <AlertCircleIcon />
                      <AlertTitle>
                        {runtime.errorCategory === 'portInUse'
                          ? t('portForward.error.portInUseTitle')
                          : t('portForward.error.title')}
                      </AlertTitle>
                      <AlertDescription>{runtime.lastError}</AlertDescription>
                    </Alert>
                  ) : null}
                </CardContent>
                <CardFooter className="flex-wrap justify-between gap-2">
                  <div className="flex gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setDraft(createDraft(rule))}
                      disabled={active}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void removeRule(rule)}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                  {active && runtime ? (
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={runtime.status === 'stopping'}
                      onClick={() => void usePortForwardStore.getState().stop(runtime.operationId)}
                    >
                      {t('portForward.stop')}
                    </Button>
                  ) : runtime?.status === 'failed' ? (
                    <Button size="xs" onClick={() => void usePortForwardStore.getState().retry(runtime.operationId)}>
                      {t('portForward.retry')}
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      onClick={() => profile
                        && void usePortForwardStore.getState().startRule(profile, rule, 'manual')}
                    >
                      {t('portForward.start')}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          }) : null}
        </CompactDialogBody>

        <CompactDialogFooter>
          {runtimes.some((runtime) => !isPortForwardActive(runtime)) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => profile && usePortForwardStore.getState().clearFinished(profile.id)}
            >
              {t('portForward.clearHistory')}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onClose}>{t('common.close')}</Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
}
