import { useEffect, useId, useRef, useState } from 'react';
import { PlusIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/empty-state';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/hooks/useI18n';
import { invokeGetProfileSudoPolicy, invokeSaveProfileSudoPolicy } from '@/lib/ipc/tauri';
import type { ProfileSudoPolicy, SudoOperation } from '@/types';

type OperationDraft = SudoOperation & { key: string };
const MAX_OPERATIONS = 32;

export function ConnectionSudoPolicyDialog({ profileId }: { profileId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<ProfileSudoPolicy | null>(null);
  const [draft, setDraft] = useState<OperationDraft[]>([]);
  const [runnerEnabled, setRunnerEnabled] = useState(false);
  const [runner, setRunner] = useState({ port: '', username: '', hostKeySha256: '' });
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const nextKey = useRef(0);
  const focusAfterRender = useRef<string | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPolicy(null);
    setLoadingFailed(false);
    void invokeGetProfileSudoPolicy(profileId).then((value) => {
      if (!active) return;
      setPolicy(value);
      setRunnerEnabled(value.runner !== null);
      setRunner({
        port: value.runner ? String(value.runner.port) : '',
        username: value.runner?.username ?? '',
        hostKeySha256: value.runner?.hostKeySha256 ?? '',
      });
      setDraft(value.operations.map((operation) => ({ ...operation, key: `saved-${operation.id}` })));
    }, () => {
      if (active) setLoadingFailed(true);
    });
    return () => { active = false; };
  }, [open, profileId, loadVersion]);

  useEffect(() => {
    if (!open || saving || !focusAfterRender.current) return;
    document.getElementById(focusAfterRender.current)?.focus();
    focusAfterRender.current = null;
  }, [open, saving, draft]);

  const update = (key: string, field: keyof SudoOperation, value: string) => {
    setDraft((items) => items.map((item) => item.key === key ? { ...item, [field]: value } : item));
  };

  const save = async () => {
    if (!policy || saving) return;
    setSaving(true);
    try {
      await invokeSaveProfileSudoPolicy(profileId, {
        profileBinding: policy.profileBinding,
        revision: policy.revision,
        runner: runnerEnabled ? {
          port: Number(runner.port),
          username: runner.username.trim(),
          hostKeySha256: runner.hostKeySha256.trim(),
        } : null,
        operations: draft.map(({ id, label, command }) => ({ id, label, command })),
      });
      toast.success(t('connection.sudo.saved'));
      setOpen(false);
    } catch (error) {
      const message = String(error);
      const invalid = /^AGENT_SUDO_INVALID_OPERATION:(\d+):(id|label|command)$/.exec(message);
      if (invalid) {
        const row = draft[Number(invalid[1]) - 1];
        const field = invalid[2];
        toast.error(t(
          field === 'id' ? 'connection.sudo.invalidId'
            : field === 'label' ? 'connection.sudo.invalidLabel' : 'connection.sudo.invalidCommand',
          { index: invalid[1] },
        ));
        if (row) focusAfterRender.current = `${id}-${row.key}-${field}`;
      } else {
        toast.error(t(message === 'AGENT_SUDO_POLICY_CHANGED' ? 'connection.sudo.changed'
          : message === 'AGENT_SUDO_INVALID_RUNNER' ? 'connection.sudo.runnerInvalid'
          : message === 'AGENT_SUDO_RUNNER_REQUIRES_DISCONNECT' ? 'connection.sudo.runnerDisconnect'
          : 'connection.sudo.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const host = policy?.host.includes(':') ? `[${policy.host}]` : policy?.host;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
        {t('connection.sudo.manage')}
      </DialogTrigger>
      <CompactDialogContent className="h-[min(580px,calc(100dvh-2rem))] max-w-lg" showCloseButton={false}>
        <CompactDialogHeader
          title={t('connection.sudo.manage')}
          description={policy
            ? t('connection.sudo.target', { account: `${policy.username}@${host}:${policy.port}` })
            : t('connection.sudo.description')}
        />
        <CompactDialogBody className="flex-1">
          {loadingFailed ? (
            <Alert variant="destructiveSubtle">
              <AlertDescription className="flex flex-col gap-2">
                {t('connection.sudo.loadFailed')}
                <Button size="sm" variant="outline" className="self-start" onClick={() => setLoadVersion((value) => value + 1)}>
                  {t('common.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : !policy ? (
            <div role="status" className="flex items-center gap-1 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              {t('common.loading')}
            </div>
          ) : (
            <form id={id} className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <p className="text-sm text-muted-foreground">{t('connection.sudo.description')}</p>
              <Field className="flex-row items-center justify-between gap-2">
                <FieldLabel htmlFor={`${id}-runner`}>{t('connection.sudo.runnerEnabled')}</FieldLabel>
                <Switch id={`${id}-runner`} checked={runnerEnabled} disabled={saving} onCheckedChange={setRunnerEnabled} />
              </Field>
              {runnerEnabled && (
                <FieldGroup className="gap-2">
                  <p className="text-xs text-muted-foreground">{t('connection.sudo.runnerHint')}</p>
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
                    <Field>
                      <FieldLabel htmlFor={`${id}-runner-port`}>{t('connection.sudo.runnerPort')}</FieldLabel>
                      <Input id={`${id}-runner-port`} type="number" min={1} max={65535} required disabled={saving}
                        value={runner.port} onChange={(event) => setRunner({ ...runner, port: event.target.value })} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-runner-user`}>{t('connection.sudo.runnerUser')}</FieldLabel>
                      <Input id={`${id}-runner-user`} autoComplete="off" required disabled={saving} maxLength={32}
                        value={runner.username} onChange={(event) => setRunner({ ...runner, username: event.target.value })} />
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel htmlFor={`${id}-runner-key`}>{t('connection.sudo.runnerKey')}</FieldLabel>
                    <Input id={`${id}-runner-key`} autoComplete="off" required disabled={saving} maxLength={50}
                      value={runner.hostKeySha256} onChange={(event) => setRunner({ ...runner, hostKeySha256: event.target.value })} />
                  </Field>
                </FieldGroup>
              )}
              {draft.length === 0 && <p className="text-sm text-muted-foreground">{t('connection.sudo.empty')}</p>}
              {draft.map((operation, index) => (
                <Card key={operation.key} size="sm" radius="compact" variant="outline">
                  <CardHeader>
                    <CardTitle>{t('connection.sudo.operation', { index: index + 1 })}</CardTitle>
                    <CardAction>
                      <Button size="xs" type="button" variant="outline" disabled={saving}
                        aria-label={t('connection.sudo.removeOperation', { index: index + 1 })}
                        onClick={() => setDraft((items) => items.filter((item) => item.key !== operation.key))}>
                        {t('connection.sudo.remove')}
                      </Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup className="gap-2">
                      {(['id', 'label', 'command'] as const).map((field) => {
                        const controlId = `${id}-${operation.key}-${field}`;
                        return (
                          <Field key={field}>
                            <FieldLabel htmlFor={controlId}>{t(`connection.sudo.field.${field}`)}</FieldLabel>
                            <Input id={controlId} value={operation[field]} onChange={(event) => update(operation.key, field, event.target.value)}
                              required disabled={saving} autoComplete="off" spellCheck={false}
                              maxLength={field === 'id' ? 64 : field === 'label' ? 120 : 2048}
                              pattern={field === 'id' ? '[a-z][a-z0-9_\\-]*' : undefined} />
                          </Field>
                        );
                      })}
                    </FieldGroup>
                  </CardContent>
                </Card>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start"
                disabled={saving || draft.length >= MAX_OPERATIONS}
                onClick={() => {
                  const key = `new-${nextKey.current++}`;
                  focusAfterRender.current = `${id}-${key}-id`;
                  setDraft((items) => [...items, { key, id: '', label: '', command: '' }]);
                }}>
                <PlusIcon data-icon="inline-start" />
                {t('connection.sudo.add')}
              </Button>
            </form>
          )}
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button type="submit" form={id} size="sm" disabled={!policy || saving}>
            {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {t('common.save')}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
}
