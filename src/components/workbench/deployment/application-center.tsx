import React from 'react';
import { CloudUploadIcon, PlusIcon, FolderOpenIcon } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Field, FieldLabel, FieldDescription, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { createApplicationEntry, associateWorkflowDefaults, workflowMappingIssues, type DeploymentApplicationEntry, type DeploymentEnvironmentConfig,
  type DeploymentProjectInspection, type DeploymentReadinessReport, type DeploymentFilePreview } from '@/lib/deployment/applications';
import { invokeListDeploymentApplications, invokeInspectDeploymentProject, invokePickLocalFolder,
  invokeSaveDeploymentApplication, invokeCheckDeploymentReadiness, invokeGetDeploymentReadiness,
  invokePreviewDeploymentFiles, invokeApplyDeploymentFiles } from '@/lib/ipc/tauri';
import type { LocaleKey } from '@/locales';
import { readableDeploymentProfile } from './deployment-editor-ui';
import { ApplicationRelease } from './application-release';
import { WorkbenchPage, WorkbenchPageHeader, WorkbenchPageContent } from '../workbench-page';

const key = (name: string): LocaleKey => `deployment.application.${name}` as LocaleKey;

export function ReadinessItems({ report }: { report: DeploymentReadinessReport }): React.JSX.Element {
  const { t, locale } = useI18n();
  return <div className="flex flex-col gap-3" aria-live="polite">
    {report.items.map((item, index) => <Alert key={`${item.key}-${index}`} variant={item.status === 'blocked' ? 'warning' : 'default'}>
      <AlertTitle className="flex flex-wrap items-center gap-1">{t(key(`check.${item.key}`))}<Badge variant="outline">{t(key(item.status))}</Badge></AlertTitle>
      <AlertDescription>
        <p className="break-all">{item.location}</p>
        {item.status !== 'passed' && <p>{t(key(`fix.${item.key}`))}</p>}
        {item.checkedAt !== null && <p>{new Date(item.checkedAt).toLocaleString(locale)}</p>}
        {item.evidence && <details><summary>{t(key('details'))}</summary><p className="break-all">{item.evidence}</p></details>}
      </AlertDescription>
    </Alert>)}
  </div>;
}

function TextField({ name, value, onChange, type = 'text' }: { name: string; value: string | number; onChange: (value: string) => void; type?: string }): React.JSX.Element {
  const { t } = useI18n();
  const id = React.useId();
  return <Field><FieldLabel htmlFor={id}>{t(key(name))}</FieldLabel><Input id={id} type={type} autoCapitalize="none" autoCorrect="off" value={value} onChange={(event) => onChange(event.target.value)} /></Field>;
}

export function ApplicationOnboarding({ initial, workflowId, onSaved, onClose, triggerRef }: {
  initial: DeploymentApplicationEntry | null; workflowId: string | null;
  onSaved: (entry: DeploymentApplicationEntry) => void; onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const workflows = useDeploymentWorkflowStore((state) => state.workflows);
  const addToast = useToastStore((state) => state.addToast);
  const [entry, setEntry] = React.useState(initial);
  const [name, setName] = React.useState(initial?.application.name ?? workflows.find((workflow) => workflow.id === workflowId)?.name ?? '');
  const [path, setPath] = React.useState(initial?.source.localPath ?? '');
  const [inspection, setInspection] = React.useState<DeploymentProjectInspection | null>(null);
  const [report, setReport] = React.useState<DeploymentReadinessReport | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [remote, setRemote] = React.useState(false);
  const [filePreview, setFilePreview] = React.useState<DeploymentFilePreview | null>(null);
  const [expectedWorkflowRevision] = React.useState(() => workflows.find((workflow) => workflow.id === (initial?.environment.workflowId ?? workflowId))?.revision ?? 0);
  const associatedWorkflow = workflows.find((workflow) => workflow.id === (initial?.environment.workflowId ?? workflowId));
  const mappingIssues = associatedWorkflow ? workflowMappingIssues(associatedWorkflow, initial) : [];
  React.useEffect(() => {
    if (!initial) return;
    let active = true;
    void invokeGetDeploymentReadiness(initial.environment.id).then((value) => { if (active) setReport(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [initial]);
  const profileOptions = profiles.map((profile) => ({ value: profile.id, label: readableDeploymentProfile(profile) }));
  const platformOptions = [{ value: 'linux/amd64', label: 'Linux · x86-64' }, { value: 'linux/arm64', label: 'Linux · ARM64' }];
  const templateOptions = [{ value: 'dockerCompose', label: t('deployment.editor.template.dockerCompose') }, { value: 'staticSite', label: t('deployment.editor.template.staticSite') }];
  const config = entry?.environment.config;
  const patch = (values: Partial<DeploymentEnvironmentConfig>): void => {
    setEntry((current) => current ? { ...current, environment: { ...current.environment, config: { ...current.environment.config, ...values } } } : null);
    setReport(null);
    setFilePreview(null);
  };
  const run = async (action: () => Promise<void>, transient = false): Promise<void> => {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { if (transient) addToast(String(cause), 'error'); else setError(String(cause)); } finally { setBusy(false); }
  };
  const inspect = async (selectedPath: string): Promise<void> => {
    const result = await invokeInspectDeploymentProject(selectedPath);
    setInspection(result); setPath(result.source.binding.localPath);
    setEntry((current) => {
      if (current) return { ...current, source: { ...result.source.binding, id: current.source.id, revision: current.source.revision,
        includedUntracked: current.source.includedUntracked, excludedPaths: current.source.excludedPaths } };
      const created = createApplicationEntry(result.source.binding, name, t(key('production')));
      created.environment.config.templateKind = result.suggestedTemplate;
      const compose = result.detectedFiles.find((file) => /^(docker-)?compose\.ya?ml$/.test(file));
      if (compose) created.environment.config.composeFile = compose;
      if (result.composeServices.length === 1) created.environment.config.service = result.composeServices[0]!;
      return associatedWorkflow ? associateWorkflowDefaults(created, associatedWorkflow) : created;
    });
    setReport(null);
  };
  const save = async (): Promise<void> => {
    if (!entry) return;
    const boundWorkflowId = initial?.environment.workflowId ?? workflowId;
    const saved = await invokeSaveDeploymentApplication({
      entry: { ...entry, application: { ...entry.application, name: name.trim() } },
      expectedApplicationRevision: initial?.application.revision ?? 0,
      expectedEnvironmentRevision: initial?.environment.revision ?? 0,
      expectedSourceRevision: initial?.source.revision ?? 0,
      expectedWorkflowRevision,
      workflowId: boundWorkflowId,
    });
    if (report) {
      try { await invokeCheckDeploymentReadiness(saved, remote); }
      catch { addToast(t(key('checkAgain')), 'info'); }
    }
    addToast(t(key('saved')), 'success'); onSaved(saved);
  };
  const input = (field: keyof DeploymentEnvironmentConfig, type = 'text'): React.JSX.Element =>
    <TextField key={field} name={field} value={String(config?.[field] ?? '')} type={type}
      onChange={(value) => patch({ [field]: type === 'number' ? Number(value) : value })} />;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent finalFocus={triggerRef} className="flex h-[min(44rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden p-0">
      <DialogHeader className="shrink-0 px-4 pt-4 pr-12">
        <DialogTitle>{t(key('configure'))}</DialogTitle>
        <DialogDescription>{t(key('intro'))}</DialogDescription>
      </DialogHeader>
      <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-4 p-4">
        {mappingIssues.length > 0 && <Alert variant="warning"><AlertTitle>{t(key('mappingReadOnly'))}</AlertTitle><AlertDescription><p>{t(key('mappingHelp'))}</p><ul>{mappingIssues.map((location) => <li className="break-all" key={location}>{location}</li>)}</ul></AlertDescription></Alert>}
        {error && <Alert variant="warning"><AlertTitle>{t(key('error'))}</AlertTitle><AlertDescription><p>{t(key('errorFix'))}</p><details><summary>{t(key('details'))}</summary><p className="break-all">{error}</p></details></AlertDescription></Alert>}
        <fieldset disabled={busy || mappingIssues.length > 0} className="contents">
        <FieldGroup>
          <TextField name="name" value={name} onChange={(value) => { setName(value); setReport(null); }} />
          <TextField name="path" value={path} onChange={setPath} />
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void run(async () => { const [selected] = await invokePickLocalFolder(t(key('path'))); if (selected) await inspect(selected); })}><FolderOpenIcon data-icon="inline-start" />{t(key('choose'))}</Button>
            <Button variant="outline" disabled={busy || !path} onClick={() => void run(() => inspect(path))}>{t(key('inspect'))}</Button></div>
          {inspection && <><FieldDescription>{t(key('detected'))}: {inspection.detectedFiles.join(', ') || t(key('noneDetected'))}</FieldDescription>
            <FieldDescription>{t(key('suggested'))}: {t(inspection.suggestedTemplate === 'staticSite' ? 'deployment.editor.template.staticSite' : 'deployment.editor.template.dockerCompose')}</FieldDescription>
            <FieldDescription>{t(key('revision'))}: {inspection.source.headRevision}</FieldDescription>
            <FieldDescription>{t(key('branch'))}: {inspection.source.branch} · {t(key('changedFiles'))}: {inspection.source.changedFiles?.length ?? 0}</FieldDescription>
            <FieldDescription>{t(key('repository'))}: {inspection.source.binding.repositoryIdentity}</FieldDescription>
            <FieldDescription>{t(key('untrackedHelp'))}</FieldDescription>
            {inspection.source.untrackedFiles.map((file) => <Field className="flex-row items-center" key={file}><Checkbox id={`include-${file}`} checked={entry?.source.includedUntracked.includes(file) ?? false} onCheckedChange={(checked) => {
              setEntry((current) => current ? { ...current, source: { ...current.source, includedUntracked: checked ? [...current.source.includedUntracked, file] : current.source.includedUntracked.filter((value) => value !== file) } } : null); setReport(null);
            }} /><FieldLabel htmlFor={`include-${file}`} className="break-all">{file}</FieldLabel></Field>)}
          </>}
          {entry && <Field><FieldLabel htmlFor="source-exclusions">{t(key('excludedPaths'))}</FieldLabel><Textarea id="source-exclusions" value={(entry.source.excludedPaths ?? []).join('\n')} onChange={(event) => { const excludedPaths = event.target.value.split('\n').filter(Boolean); setEntry({ ...entry, source: { ...entry.source, excludedPaths } }); setReport(null); }} /><FieldDescription>{t(key('excludedHelp'))}</FieldDescription></Field>}
          <Alert><AlertTitle>{t(key('limits'))}</AlertTitle><AlertDescription>{t(key('limitsDescription'))}</AlertDescription></Alert>
        </FieldGroup>
        {config && entry && <FieldGroup>
          <Field><FieldLabel htmlFor="application-template">{t(key('templateKind'))}</FieldLabel><Select disabled={Boolean(associatedWorkflow)} items={templateOptions} value={config.templateKind} onValueChange={(value) => patch({ templateKind: value === 'staticSite' ? 'staticSite' : 'dockerCompose' })}><SelectTrigger id="application-template"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{templateOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
          <TextField name="environment" value={entry.environment.name} onChange={(value) => { setEntry({ ...entry, environment: { ...entry.environment, name: value } }); setReport(null); }} />
          <Field><FieldLabel htmlFor="application-profile">{t(key('connectionProfileId'))}</FieldLabel><Select items={profileOptions} value={config.connectionProfileId} onValueChange={(value) => patch({ connectionProfileId: value ?? '' })}><SelectTrigger id="application-profile"><SelectValue placeholder={t(key('chooseProfile'))} /></SelectTrigger><SelectContent><SelectGroup>{profileOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
          {input('remoteRoot')}
          <Field><FieldLabel htmlFor="application-platform">{t(key('platform'))}</FieldLabel><Select items={platformOptions} value={config.platform} onValueChange={(value) => patch({ platform: value ?? '' })}><SelectTrigger id="application-platform"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{platformOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
          {config.templateKind === 'dockerCompose' && <>{(['projectName', 'service', 'composeFile', 'dockerfile', 'buildContext', 'bindAddress'] as const).map((field) => input(field))}{input('containerPort', 'number')}{input('hostPort', 'number')}</>}
          {input('accessUrl')}{input('basePath')}
          {config.templateKind === 'staticSite' && <FieldDescription>{t(key('staticAdvanced'))}</FieldDescription>}
          <FieldDescription>{t(key('pathIndependence'))}</FieldDescription>
          <FieldDescription>{t(key('credentialsHelp'))}</FieldDescription>
          {config.templateKind === 'dockerCompose' && <Button variant="outline" disabled={busy} onClick={() => void run(async () => setFilePreview(await invokePreviewDeploymentFiles({ ...entry, application: { ...entry.application, name: name.trim() } }))) }>{t(key('generatePreview'))}</Button>}
          {filePreview && <>
            <Alert><AlertTitle>{t(key('previewTitle'))}</AlertTitle><AlertDescription>{t(key('previewHelp'))}</AlertDescription></Alert>
            {filePreview.files.map((file) => <Field key={file.path}><FieldLabel>{file.path} · {t(key(file.exists ? 'fileExists' : 'fileAdded'))}</FieldLabel><pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all text-xs">{file.content}</pre></Field>)}
            <Button variant="outline" disabled={busy || filePreview.files.some((file) => file.exists)} onClick={() => void run(async () => {
              await invokeApplyDeploymentFiles({ ...entry, application: { ...entry.application, name: name.trim() } }, filePreview.digest);
              setFilePreview(null); await inspect(path); addToast(t(key('filesApplied')), 'success');
            })}>{t(key('applyFiles'))}</Button>
          </>}
        </FieldGroup>}
        {config && <FieldGroup>
          <Field className="flex-row items-center"><Checkbox id="existing-service" checked={config.existingService} onCheckedChange={(checked) => patch({ existingService: checked === true })} /><FieldLabel htmlFor="existing-service">{t(key('existingService'))}</FieldLabel></Field>
          {config.existingService && <>{input('managementMethod')}{input('recoveryInstructions')}<Alert variant="warning"><AlertTitle>{t(key('takeoverRequired'))}</AlertTitle><AlertDescription>{t(key('takeoverHelp'))}</AlertDescription></Alert></>}
          {config.dataDirectories.map((directory, index) => <FieldGroup key={index}>
            {(['hostPath', 'containerPath', 'containerUser', 'backupPolicy'] as const).map((field) => <TextField key={field} name={field} value={directory[field]} onChange={(value) => patch({ dataDirectories: config.dataDirectories.map((item, i) => i === index ? { ...item, [field]: value } : item) })} />)}
            <Field className="flex-row items-center"><Checkbox id={`read-only-${index}`} checked={directory.readOnly} onCheckedChange={(checked) => patch({ dataDirectories: config.dataDirectories.map((item, i) => i === index ? { ...item, readOnly: checked === true } : item) })} /><FieldLabel htmlFor={`read-only-${index}`}>{t(key('readOnly'))}</FieldLabel></Field>
            <Button variant="outline" onClick={() => patch({ dataDirectories: config.dataDirectories.filter((_, i) => i !== index) })}>{t(key('removeDirectory'))}</Button>
          </FieldGroup>)}
          <Button variant="outline" onClick={() => patch({ dataDirectories: [...config.dataDirectories, { hostPath: `${config.remoteRoot}/shared/data`, containerPath: '/app/data', containerUser: '', readOnly: false, backupPolicy: '' }] })}>{t(key('addDirectory'))}</Button>
          <FieldDescription>{t(key('dataHelp'))}</FieldDescription>
          <Field><FieldLabel htmlFor="config-files">{t(key('nonSensitiveFiles'))}</FieldLabel><Textarea id="config-files" value={config.nonSensitiveFiles.join('\n')} onChange={(event) => patch({ nonSensitiveFiles: event.target.value.split('\n').filter(Boolean) })} /><FieldDescription>{t(key('configHelp'))}</FieldDescription></Field>
        </FieldGroup>}
        {entry && <>
          <Alert><AlertTitle>{t(key('incomplete'))}</AlertTitle><AlertDescription>{t(key('saveHelp'))}</AlertDescription></Alert>
          <Field className="flex-row items-center"><Checkbox id="check-remote" checked={remote} onCheckedChange={(checked) => setRemote(checked === true)} /><FieldLabel htmlFor="check-remote">{t(key('remoteReadOnly'))}</FieldLabel></Field>
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => setReport(await invokeCheckDeploymentReadiness({ ...entry, application: { ...entry.application, name: name.trim() } }, remote)))}>{t(key('check'))}</Button>
          {report && <ReadinessItems report={report} />}
        </>}
        </fieldset>
      </div></ScrollArea>
      <DialogFooter className="shrink-0 px-4 pb-4">
        <Button variant="outline" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button disabled={busy || !entry || !name.trim() || path !== entry.source.localPath || mappingIssues.length > 0} onClick={() => void run(save, true)}>{t(key('save'))}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function WorkflowDeploymentConfiguration({ workflowId, triggerRef, onSaved, onClose }: {
  workflowId: string; triggerRef: React.RefObject<HTMLButtonElement | null>;
  onSaved: () => void; onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [loaded, setLoaded] = React.useState(false);
  const [entry, setEntry] = React.useState<DeploymentApplicationEntry | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void invokeListDeploymentApplications().then((entries) => {
      if (active) { setEntry(entries.find((item) => item.environment.workflowId === workflowId) ?? null); setLoaded(true); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [workflowId]);
  if (loaded) return <ApplicationOnboarding initial={entry} workflowId={workflowId} triggerRef={triggerRef} onSaved={onSaved} onClose={onClose} />;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent finalFocus={triggerRef}>
    <DialogHeader><DialogTitle>{t(key('configure'))}</DialogTitle><DialogDescription>{t(key(failed ? 'loadError' : 'loading'))}</DialogDescription></DialogHeader>
    <DialogFooter><Button variant="outline" onClick={onClose}>{t('common.close')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function DeploymentApplicationCenter({ onAdvanced }: { onAdvanced: (workflowId?: string) => void }): React.JSX.Element {
  const { t } = useI18n();
  const [entries, setEntries] = React.useState<DeploymentApplicationEntry[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [onboarding, setOnboarding] = React.useState<{ initial: DeploymentApplicationEntry | null; workflowId: string | null } | null>(null);
  const [listOpen, setListOpen] = React.useState(false);
  const [report, setReport] = React.useState<DeploymentReadinessReport | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const preparing = useDeploymentWorkflowRunStore((state) => state.preparing);
  const openOnboarding = (button: HTMLButtonElement, value: NonNullable<typeof onboarding>): void => {
    if (preparing) return;
    triggerRef.current = button;
    setOnboarding(value);
  };
  const workflowState = useDeploymentWorkflowStore();
  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true); setLoadError(false);
    try { const values = await invokeListDeploymentApplications(); setEntries(values); setSelected((current) => current ?? values[0]?.environment.id ?? null); }
    catch { setLoadError(true); } finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => { if (!workflowState.initialized && !workflowState.loading) void workflowState.initialize().catch(() => undefined); }, [workflowState]);
  const active = entries.find((entry) => entry.environment.id === selected);
  const activeWorkflow = workflowState.workflows.find((workflow) => workflow.id === active?.environment.workflowId);
  React.useEffect(() => {
    let current = true;
    setReport(null);
    if (active) void invokeGetDeploymentReadiness(active.environment.id).then((value) => { if (current) setReport(value); }).catch(() => undefined);
    return () => { current = false; };
  }, [active]);
  const unassociated = workflowState.workflows.filter((workflow) => !entries.some((entry) => entry.environment.workflowId === workflow.id));
  const list = <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-2 p-3">
    {entries.map((entry) => <Button disabled={preparing} key={entry.environment.id} variant={selected === entry.environment.id ? 'secondary' : 'ghost'} className="justify-start" onClick={() => { setSelected(entry.environment.id); setListOpen(false); }}><span className="truncate">{entry.application.name} · {entry.environment.name}</span></Button>)}
    {unassociated.length > 0 && <><p>{t(key('unassociated'))}</p>{unassociated.map((workflow) => <div key={workflow.id} className="flex min-w-0 flex-col gap-1"><Button disabled={preparing} variant="ghost" className="justify-start" onClick={() => onAdvanced(workflow.id)}><span className="truncate">{workflow.name}</span></Button><Button disabled={preparing} variant="outline" size="sm" onClick={(event) => { setListOpen(false); openOnboarding(event.currentTarget, { initial: null, workflowId: workflow.id }); }}>{t(key('associate'))}</Button></div>)}</>}
  </div></ScrollArea>;
  return <WorkbenchPage>
    <WorkbenchPageHeader icon={CloudUploadIcon} title={t(key('title'))} description={t(key('description'))} />
    <WorkbenchPageContent className="min-h-0 flex-1 gap-0 overflow-hidden p-0!">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        <Button size="sm" onClick={(event) => openOnboarding(event.currentTarget, { initial: null, workflowId: null })}><PlusIcon data-icon="inline-start" />{t(key('connect'))}</Button>
        <Button size="sm" variant="outline" className="@min-[52rem]:hidden" onClick={() => setListOpen(true)}>{t(key('applications'))}</Button>
        <Button size="sm" variant="outline" disabled={preparing} onClick={() => onAdvanced()}>{t(key('advanced'))}</Button>
      </div>
      {loading ? <PanelLoadingState label={t(key('loading'))} /> : loadError ? <PanelEmptyState title={t(key('loadError'))} action={<Button onClick={() => void refresh()}>{t(key('retry'))}</Button>} /> :
        <div className="flex min-h-0 flex-1">
          <aside className="hidden min-h-0 w-64 shrink-0 flex-col border-r @min-[52rem]:flex">{list}</aside>
          {active ? <ScrollArea className="min-h-0 min-w-0 flex-1"><div className="flex flex-col gap-4 p-4">
            <h2>{active.application.name} · {active.environment.name}</h2>
            <Alert><AlertTitle>{t(key(report && Date.now() - report.checkedAt < 900_000 && report.items.every((item) => item.status === 'passed' || item.status === 'notice') ? 'ready' : 'incomplete'))}</AlertTitle><AlertDescription>{t(key('saveHelp'))}</AlertDescription></Alert>
            <p className="break-all">{active.source.localPath}</p><p className="break-all">{active.environment.config.remoteRoot}</p>
            <div className="flex flex-wrap gap-2"><Button onClick={(event) => openOnboarding(event.currentTarget, { initial: active, workflowId: active.environment.workflowId })}>{t(key('configure'))}</Button>
              <Button variant="outline" onClick={(event) => openOnboarding(event.currentTarget, { initial: { ...active, environment: { ...active.environment, id: crypto.randomUUID(), name: '', revision: 0, workflowId: null } }, workflowId: null })}>{t(key('addEnvironment'))}</Button>
              {active.environment.workflowId && <Button variant="outline" disabled={preparing} onClick={() => onAdvanced(active.environment.workflowId!)}>{t(key('advanced'))}</Button>}</div>
            {activeWorkflow && <ApplicationRelease key={active.environment.id} entry={active} workflow={activeWorkflow} report={report} onReport={setReport} admissionsEnabled={workflowState.capabilities?.admissionsEnabled ?? false} />}
            {report && <ReadinessItems report={report} />}
          </div></ScrollArea> : <PanelEmptyState icon={<CloudUploadIcon />} title={t(key('empty'))} description={t(key('emptyHelp'))} action={<Button onClick={(event) => openOnboarding(event.currentTarget, { initial: null, workflowId: null })}>{t(key('connect'))}</Button>} />}
        </div>}
    </WorkbenchPageContent>
    <Drawer open={listOpen} onOpenChange={setListOpen}><DrawerContent className="flex min-h-0 flex-col overflow-hidden p-0"><DrawerHeader className="shrink-0 p-3"><DrawerTitle>{t(key('applications'))}</DrawerTitle></DrawerHeader>{list}</DrawerContent></Drawer>
    {onboarding && <ApplicationOnboarding {...onboarding} triggerRef={triggerRef} onClose={() => setOnboarding(null)} onSaved={(entry) => { setOnboarding(null); setSelected(entry.environment.id); void refresh(); void workflowState.refresh().catch(() => undefined); }} />}
  </WorkbenchPage>;
}
