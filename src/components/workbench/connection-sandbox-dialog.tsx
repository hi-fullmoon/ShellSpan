import { useEffect, useId, useRef, useState } from 'react';
import { RocketIcon, TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConnectSession } from '@/hooks/useConnectSession';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { CopyButton } from '@/components/ui/copy-button';
import {
  invokeCancelConnectionPreflight,
  invokeDeployProfileSandbox,
  invokeGetProfileSandbox,
  invokeSaveProfileSandbox,
  invokeTestProfileSandbox,
  invokeTrustHost,
} from '@/lib/ipc/tauri';
import { createOperationId } from '@/lib/operation-id';
import type { ProfileSandbox, SandboxDeployResult, SandboxMode, SandboxTestResult } from '@/types';
import { PreflightStepRow } from './connection-preflight-dialog';

type Mode = SandboxMode | 'off';

export function ConnectionSandboxDialog({ profileId }: { profileId: string }) {
  const { t } = useI18n();
  const { connect } = useConnectSession();
  const profile = useProfileStore((state) => state.profiles.find((item) => item.id === profileId));
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<ProfileSandbox>();
  const [mode, setMode] = useState<Mode>('off');
  const [workspace, setWorkspace] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployConfirmOpen, setDeployConfirmOpen] = useState(false);
  const [deployResult, setDeployResult] = useState<SandboxDeployResult>();
  const [trusting, setTrusting] = useState(false);
  const [report, setReport] = useState<SandboxTestResult>();
  const [testError, setTestError] = useState(false);
  const activeTest = useRef<string | null>(null);
  const activeDeploy = useRef<string | null>(null);
  const activeTrust = useRef<symbol | null>(null);
  const id = useId();
  const selectedPath = workspace.trim();
  const isClientReadOnly = mode === 'clientReadOnly';
  const validClientPath = selectedPath.startsWith('/')
    && selectedPath.length <= 512
    && !selectedPath.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(selectedPath)
    && (selectedPath === '/' || (!selectedPath.endsWith('/') && !selectedPath.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')));
  const valid = isClientReadOnly
    ? validClientPath
    : /^\/srv\/shellspan-workspaces\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(selectedPath);
  const showWorkspaceError = mode !== 'off' && selectedPath.length > 0 && !valid;
  const busy = saving || loading || testing || deploying || trusting;
  const ready = Boolean(saved) && !busy;
  const modes = (['off', 'clientReadOnly', 'readOnly', 'workspaceWrite'] as const).map((value) => ({ value, label: t(`connection.sandbox.mode.${value}`) }));

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setSaved(undefined);
    setReport(undefined);
    setDeployResult(undefined);
    setDeployConfirmOpen(false);
    setLoadFailed(false);
    setTestError(false);
    setTesting(false);
    setDeploying(false);
    setTrusting(false);
    void invokeGetProfileSandbox(profileId).then((value) => {
      if (!live) return;
      setSaved(value);
      setMode(value.policy?.mode ?? 'off');
      setWorkspace(value.policy?.workspace ?? '');
    }, () => { if (live) setLoadFailed(true); }).finally(() => { if (live) setLoading(false); });
    return () => {
      live = false;
      activeTrust.current = null;
      const testOp = activeTest.current;
      activeTest.current = null;
      if (testOp) void invokeCancelConnectionPreflight(testOp).catch(() => {});
      const deployOp = activeDeploy.current;
      activeDeploy.current = null;
      if (deployOp) void invokeCancelConnectionPreflight(deployOp).catch(() => {});
    };
  }, [open, profileId]);

  const clearReport = () => {
    setReport(undefined);
    setDeployResult(undefined);
    setTestError(false);
  };

  async function test() {
    if (!saved || !ready || activeTest.current || mode === 'off' || !valid) return;
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

  async function deploy() {
    if (!saved || !ready || activeDeploy.current || mode === 'off' || isClientReadOnly || !valid) return;
    const operation = createOperationId('sandbox-deploy');
    activeDeploy.current = operation;
    setDeploying(true);
    setDeployResult(undefined);
    try {
      const result = await invokeDeployProfileSandbox(
        profileId,
        saved.binding,
        { mode, workspace: selectedPath },
        operation,
      );
      if (activeDeploy.current !== operation) return;
      setDeployResult(result);
      if (result.report) {
        setReport(result.report);
      }
      if (result.cancelled) {
        toast.info(t('connection.sandbox.deployCancelled'));
      } else if (result.succeeded) {
        toast.success(t('connection.sandbox.deploySuccess'));
      } else if (result.rootRequired) {
        toast.error(t('connection.sandbox.deployRootRequired'));
      } else if (result.exitCode === 0) {
        toast.info(t('connection.sandbox.deployFinishedCheckSteps'));
      } else {
        toast.error(t('connection.sandbox.deployFailed'));
      }
    } catch (error) {
      if (activeDeploy.current === operation) {
        toast.error(t(String(error).includes('SANDBOX_POLICY_CHANGED') ? 'connection.sandbox.changed' : 'connection.sandbox.deployFailed'));
      }
    } finally {
      if (activeDeploy.current === operation) {
        activeDeploy.current = null;
        setDeploying(false);
      }
    }
  }

  async function save() {
    if (!saved || !ready || activeTrust.current || (mode !== 'off' && !valid)) return;
    setSaving(true);
    try {
      await invokeSaveProfileSandbox(profileId, saved.binding, mode === 'off' ? null : { mode, workspace: selectedPath });
      useProfileStore.getState().setProfileSandboxMode(profileId, mode === 'off' ? undefined : mode);
      toast.success(t('connection.sandbox.saved'));
      setOpen(false);
    } catch (error) {
      toast.error(t(String(error).includes('SANDBOX_POLICY_CHANGED') ? 'connection.sandbox.changed' : 'connection.sandbox.saveFailed'));
    } finally { setSaving(false); }
  }

  async function trust(host: string, port: number, fingerprint?: string) {
    if (!fingerprint || !ready || activeTrust.current) return;
    const operation = Symbol();
    activeTrust.current = operation;
    setTrusting(true);
    try {
      await invokeTrustHost(host, port, fingerprint);
      if (activeTrust.current === operation) await test();
    } catch {
      if (activeTrust.current === operation) toast.error(t('connection.sandbox.trustFailed'));
    } finally {
      if (activeTrust.current === operation) {
        activeTrust.current = null;
        setTrusting(false);
      }
    }
  }

  const sandboxStarted = report?.steps.find(([step]) => step === 'sandboxStart')?.[1];
  const reportKey = report?.cancelled ? 'cancelled' : report?.passed ? 'passed'
    : report?.packageMissing ? 'missing' : sandboxStarted === 'failed' ? 'startFailed'
      : sandboxStarted === 'passed' ? 'policyFailed' : 'unavailable';

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!saving && !testing && !deploying) setOpen(next); }}>
        <DialogTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
          {t('connection.sandbox.manage')}
        </DialogTrigger>
        <CompactDialogContent className="h-[min(560px,calc(100dvh-2rem))] max-w-lg" showCloseButton={false}>
          <CompactDialogHeader
            title={t('connection.sandbox.title')}
            description={t(isClientReadOnly ? 'connection.sandbox.descriptionClientReadOnly' : 'connection.sandbox.description')}
          />
          <CompactDialogBody className="flex-1" aria-busy={loading || testing || deploying || trusting}>
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
                <Input
                  id={`${id}-workspace`}
                  aria-describedby={showWorkspaceError ? `${id}-workspace-hint ${id}-workspace-error` : `${id}-workspace-hint`}
                  aria-invalid={showWorkspaceError || undefined}
                  value={workspace}
                  disabled={!ready}
                  autoComplete="off"
                  onChange={(event) => { setWorkspace(event.target.value); clearReport(); }}
                />
                <FieldDescription id={`${id}-workspace-hint`}>
                  {t(isClientReadOnly ? 'connection.sandbox.workspaceHintClientReadOnly' : 'connection.sandbox.workspaceHint')}
                </FieldDescription>
                {showWorkspaceError && (
                  <p id={`${id}-workspace-error`} role="alert" className="text-xs text-destructive">
                    {t(isClientReadOnly ? 'connection.sandbox.workspaceInvalidClientReadOnly' : 'connection.sandbox.workspaceInvalid')}
                  </p>
                )}
              </Field>}
            </FieldGroup>}
            {testing && <p role="status" className="text-sm text-muted-foreground">{t('connection.sandbox.testing')}</p>}
            {deploying && <p role="status" className="text-sm text-muted-foreground">{t('connection.sandbox.deploying')}</p>}
            {testError && <Alert variant="destructive"><AlertDescription>{t('connection.sandbox.testFailed')}</AlertDescription></Alert>}
            {deployResult && (
              <Alert variant={deployResult.succeeded ? 'default' : 'destructive'} data-testid="connection-sandbox-deploy-result">
                <AlertDescription className="flex flex-col gap-2">
                  <p>
                    {t(
                      deployResult.cancelled
                        ? 'connection.sandbox.deployCancelled'
                        : deployResult.succeeded
                          ? 'connection.sandbox.deploySuccess'
                          : deployResult.rootRequired
                            ? 'connection.sandbox.deployRootRequired'
                            : deployResult.exitCode === 0
                              ? 'connection.sandbox.deployFinishedCheckSteps'
                              : 'connection.sandbox.deployFailed',
                    )}
                  </p>
                  {deployResult.output.trim().length > 0 && (
                    <details className="rounded border bg-muted/40 p-2">
                      <summary className="cursor-pointer text-xs font-medium text-foreground">
                        {t('connection.sandbox.deployOutputSummary')}
                      </summary>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-foreground">
                        {deployResult.output}
                      </pre>
                    </details>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {report && <>
              <Alert variant={report.passed || report.cancelled ? 'default' : 'destructive'}>
                <AlertTitle>{t(`connection.sandbox.report.${reportKey}`)}</AlertTitle>
                {report.packageMissing && <AlertDescription className="flex flex-col gap-2">
                  {report.installCommand ? <>
                    <p>{t('connection.sandbox.installHint')}</p>
                    <code className="break-all">{report.installCommand}</code>
                    <CopyButton key={report.installCommand} text={report.installCommand} variant="outline" size="sm" className="self-start"
                      label={t('connection.sandbox.copyInstall')} errorLabel={t('connection.sandbox.copyFailed')} />
                  </> : <p>{t('connection.sandbox.unknownDistro')}</p>}
                </AlertDescription>}
                {report.deployScript && (
                  <AlertDescription className="mt-2 flex flex-col gap-2">
                    <p>{t('connection.sandbox.deployScriptHint')}</p>
                    <details className="rounded border bg-muted/40 p-2">
                      <summary className="cursor-pointer text-xs font-medium text-foreground">
                        {t('connection.sandbox.deployScriptSummary')}
                      </summary>
                      <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-foreground">
                        {report.deployScript}
                      </pre>
                    </details>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        className="gap-1"
                        disabled={!ready || isClientReadOnly || !valid}
                        data-testid="connection-sandbox-deploy-now"
                        onClick={() => setDeployConfirmOpen(true)}
                      >
                        <RocketIcon aria-hidden="true" className="size-3.5" />
                        <span>{t('connection.sandbox.deployNow')}</span>
                      </Button>
                      <CopyButton
                        key={report.deployScript}
                        text={report.deployScript}
                        variant="outline"
                        size="sm"
                        label={t('connection.sandbox.copyDeployScript')}
                        errorLabel={t('connection.sandbox.copyFailed')}
                      />
                      {profile && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          onClick={() => {
                            setOpen(false);
                            void connect(profile);
                          }}
                        >
                          <TerminalIcon aria-hidden="true" className="size-3.5" />
                          <span>{t('connection.sandbox.openTerminal')}</span>
                        </Button>
                      )}
                    </div>
                  </AlertDescription>
                )}
              </Alert>
              <ol className="flex flex-col gap-2">
                {report.ssh.steps.map((step) => <PreflightStepRow key={step.id} step={step} trustDisabled={!ready} onTrust={(host, port, fingerprint) => void trust(host, port, fingerprint)} />)}
                {report.steps.map(([step, status]) => <li key={step} className="flex flex-wrap items-center gap-2 text-sm">
                  {t(`connection.sandbox.step.${step}`)}
                  {step === 'executorProtocol' && report.protocolVersion != null && <code>v{report.protocolVersion}</code>}
                  <Badge variant={status === 'failed' ? 'destructive' : 'outline'}>{t(`connection.preflight.status.${status}`)}</Badge>
                </li>)}
              </ol>
            </>}
          </CompactDialogBody>
          <CompactDialogFooter>
            {testing || deploying ? <Button variant="outline" size="sm" onClick={() => {
              const op = activeTest.current ?? activeDeploy.current;
              if (op) void invokeCancelConnectionPreflight(op).catch(() => {});
            }}>{t('common.cancel')}</Button> : <>
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>{t('common.close')}</Button>
              <Button variant="outline" size="sm" disabled={!ready || mode === 'off' || !valid} onClick={() => void test()}>{t('connection.sandbox.test')}</Button>
              <Button size="sm" disabled={!ready || (mode !== 'off' && !valid)} onClick={() => void save()}>{t('common.save')}</Button>
            </>}
          </CompactDialogFooter>
        </CompactDialogContent>
      </Dialog>
      <ConfirmationDialog
        open={deployConfirmOpen}
        onOpenChange={setDeployConfirmOpen}
        title={t('connection.sandbox.deployConfirmTitle')}
        description={t('connection.sandbox.deployConfirmDescription')}
        confirmLabel={t('connection.sandbox.deployConfirmAction')}
        confirmVariant="warning"
        onConfirm={() => {
          setDeployConfirmOpen(false);
          void deploy();
        }}
      />
    </>
  );
}
