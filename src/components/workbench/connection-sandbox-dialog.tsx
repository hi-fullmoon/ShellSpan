import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/hooks/useI18n';
import { writeClipboardText } from '@/lib/clipboard';
import { invokeCancelConnectionPreflight, invokeGetProfileSandbox, invokeSaveProfileSandbox, invokeTestProfileSandbox, invokeTrustHost } from '@/lib/ipc/tauri';
import { createOperationId } from '@/lib/operation-id';
import type { ProfileSandbox, SandboxMode, SandboxTestResult } from '@/types';
import { PreflightStepRow } from './connection-preflight-dialog';

type Mode = SandboxMode | 'off';

export function ConnectionSandboxDialog({ profileId }: { profileId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ProfileSandbox>();
  const [mode, setMode] = useState<Mode>('off');
  const [workspace, setWorkspace] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<SandboxTestResult>();
  const [testError, setTestError] = useState(false);
  const activeTest = useRef<string | null>(null);
  const id = useId();
  const selectedPath = workspace.trim();
  const valid = /^\/srv\/shellspan-workspaces\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(selectedPath);
  const ready = Boolean(saved) && !saving && !loading && !testing;
  const modes = (['off', 'readOnly', 'workspaceWrite'] as const).map((value) => ({ value, label: t(`connection.sandbox.mode.${value}`) }));

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setSaved(undefined);
    setReport(undefined);
    setLoadFailed(false);
    setTestError(false);
    void invokeGetProfileSandbox(profileId).then((value) => {
      if (!live) return;
      setSaved(value);
      setMode(value.policy?.mode ?? 'off');
      setWorkspace(value.policy?.workspace ?? '');
    }, () => { if (live) setLoadFailed(true); }).finally(() => { if (live) setLoading(false); });
    return () => {
      live = false;
      const operation = activeTest.current;
      activeTest.current = null;
      if (operation) void invokeCancelConnectionPreflight(operation).catch(() => {});
    };
  }, [open, profileId]);

  const clearReport = () => { setReport(undefined); setTestError(false); };

  async function test() {
    if (!saved || !ready || mode === 'off' || !valid) return;
    const operation = createOperationId('sandbox-preflight');
    activeTest.current = operation;
    setTesting(true);
    clearReport();
    try {
      const result = await invokeTestProfileSandbox(profileId, saved.binding, { mode, workspace: selectedPath }, operation);
      if (activeTest.current === operation) setReport(result);
    } catch {
      if (activeTest.current === operation) setTestError(true);
    } finally {
      if (activeTest.current === operation) {
        activeTest.current = null;
        setTesting(false);
      }
    }
  }

  async function save() {
    if (!saved || !ready || (mode !== 'off' && !valid)) return;
    setSaving(true);
    try {
      await invokeSaveProfileSandbox(profileId, saved.binding, mode === 'off' ? null : { mode, workspace: selectedPath });
      toast.success(t('connection.sandbox.saved'));
      setOpen(false);
    } catch (error) {
      toast.error(t(String(error).includes('SANDBOX_POLICY_CHANGED') ? 'connection.sandbox.changed' : 'connection.sandbox.saveFailed'));
    } finally { setSaving(false); }
  }

  async function trust(host: string, port: number, fingerprint?: string) {
    if (!fingerprint) return;
    try {
      await invokeTrustHost(host, port, fingerprint);
      await test();
    } catch { toast.error(t('connection.sandbox.trustFailed')); }
  }

  const sandboxStarted = report?.steps.find(([step]) => step === 'sandboxStart')?.[1];
  const reportKey = report?.cancelled ? 'cancelled' : report?.passed ? 'passed'
    : report?.packageMissing ? 'missing' : sandboxStarted === 'failed' ? 'startFailed'
      : sandboxStarted === 'passed' ? 'policyFailed' : 'unavailable';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving && !testing) setOpen(next); }}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
        {t('connection.sandbox.manage')}
      </DialogTrigger>
      <CompactDialogContent className="h-[min(560px,calc(100dvh-2rem))] max-w-lg" showCloseButton={false}>
        <CompactDialogHeader title={t('connection.sandbox.title')} description={t('connection.sandbox.description')} />
        <CompactDialogBody className="flex-1" aria-busy={loading || testing}>
          {loading && <p role="status" className="text-sm text-muted-foreground">{t('connection.sandbox.loading')}</p>}
          {loadFailed && <Alert variant="destructive"><AlertDescription>{t('connection.sandbox.loadFailed')}</AlertDescription></Alert>}
          {saved && <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-mode`}>{t('connection.sandbox.mode')}</FieldLabel>
              <Select items={modes} value={mode} disabled={!ready} onValueChange={(value) => { if (value) { setMode(value); clearReport(); } }}>
                <SelectTrigger id={`${id}-mode`}><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{modes.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            {mode !== 'off' && <Field>
              <FieldLabel htmlFor={`${id}-workspace`}>{t('connection.sandbox.workspace')}</FieldLabel>
              <Input id={`${id}-workspace`} aria-describedby={`${id}-workspace-hint`} value={workspace} disabled={!ready}
                autoComplete="off" onChange={(event) => { setWorkspace(event.target.value); clearReport(); }} />
              <FieldDescription id={`${id}-workspace-hint`}>{t('connection.sandbox.workspaceHint')}</FieldDescription>
            </Field>}
          </FieldGroup>}
          {testing && <p role="status" className="text-sm text-muted-foreground">{t('connection.sandbox.testing')}</p>}
          {testError && <Alert variant="destructive"><AlertDescription>{t('connection.sandbox.testFailed')}</AlertDescription></Alert>}
          {report && <>
            <Alert variant={report.passed || report.cancelled ? 'default' : 'destructive'}>
              <AlertTitle>{t(`connection.sandbox.report.${reportKey}`)}</AlertTitle>
              {report.packageMissing && <AlertDescription className="flex flex-col gap-2">
                {report.installCommand ? <>
                  <p>{t('connection.sandbox.installHint')}</p>
                  <code className="break-all">{report.installCommand}</code>
                  <Button variant="outline" size="sm" className="self-start" onClick={() => {
                    void writeClipboardText(report.installCommand!).then(
                      () => toast.success(t('connection.sandbox.copied')),
                      () => toast.error(t('connection.sandbox.copyFailed')),
                    );
                  }}>{t('connection.sandbox.copyInstall')}</Button>
                </> : <p>{t('connection.sandbox.unknownDistro')}</p>}
              </AlertDescription>}
            </Alert>
            <ol className="flex flex-col gap-2">
              {report.ssh.steps.map((step) => <PreflightStepRow key={step.id} step={step} onTrust={(host, port, fingerprint) => void trust(host, port, fingerprint)} />)}
              {report.steps.map(([step, status]) => <li key={step} className="flex flex-wrap items-center gap-2 text-sm">
                {t(`connection.sandbox.step.${step}`)}
                {step === 'executorProtocol' && report.protocolVersion != null && <code>v{report.protocolVersion}</code>}
                <Badge variant={status === 'failed' ? 'destructive' : 'outline'}>{t(`connection.preflight.status.${status}`)}</Badge>
              </li>)}
            </ol>
          </>}
        </CompactDialogBody>
        <CompactDialogFooter>
          {testing ? <Button variant="outline" size="sm" onClick={() => {
            if (activeTest.current) void invokeCancelConnectionPreflight(activeTest.current).catch(() => {});
          }}>{t('common.cancel')}</Button> : <>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>{t('common.close')}</Button>
            <Button variant="outline" size="sm" disabled={!ready || mode === 'off' || !valid} onClick={() => void test()}>{t('connection.sandbox.test')}</Button>
            <Button size="sm" disabled={!ready || (mode !== 'off' && !valid)} onClick={() => void save()}>{t('common.save')}</Button>
          </>}
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
}
