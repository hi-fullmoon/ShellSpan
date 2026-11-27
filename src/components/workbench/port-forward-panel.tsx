import React, { useEffect, useMemo, useState } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CableIcon,
  ChevronDownIcon,
  EraserIcon,
  InfoIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchXIcon,
  ServerIcon,
  SquareIcon,
  Trash2Icon,
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
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { PanelEmptyState } from '@/components/ui/empty-state';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TooltipProvider } from '@/components/ui/tooltip';
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
import { useWorkbenchToolsStore } from '@/stores/workbenchToolsStore';
import type { ConnectionProfile, PortForwardKind, PortForwardRule } from '@/types';
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
  WorkbenchPageToolbar,
  WorkbenchSearchInput,
} from './workbench-page';

type StatusFilter = 'all' | 'active' | 'failed';

interface RuleDraft {
  id?: string;
  profileId: string;
  name: string;
  kind: PortForwardKind;
  localPort: string;
  remoteHost: string;
  remotePort: string;
  autoStart: boolean;
}

interface PortForwardEntry {
  profile: ConnectionProfile;
  rule: PortForwardRule;
  runtime?: ManagedPortForwardRuntime;
  active: boolean;
}

function profileDisplayName(profile: ConnectionProfile): string {
  return profile.name.trim() || profile.host;
}

function profileOptionLabel(profile: ConnectionProfile): string {
  return `${profileDisplayName(profile)} · ${profile.username}@${profile.host}:${profile.port}`;
}

function createDraft(profileId: string, rule?: PortForwardRule): RuleDraft {
  return rule
    ? {
        id: rule.id,
        profileId,
        name: rule.name,
        kind: rule.kind,
        localPort: String(rule.localPort),
        remoteHost: rule.remoteHost,
        remotePort: String(rule.remotePort),
        autoStart: rule.autoStart,
      }
    : {
        profileId,
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
  profileId: string,
  ruleId: string,
): ManagedPortForwardRuntime | undefined {
  const matching = runtimes.filter(
    (runtime) => runtime.profileId === profileId && runtime.configId === ruleId,
  );
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

function ruleRouteSummary(rule: PortForwardRule): string {
  if (rule.kind === 'dynamic') return `SOCKS5 · 127.0.0.1:${rule.localPort}`;
  if (rule.kind === 'local') return `127.0.0.1:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`;
  return `${rule.remoteHost}:${rule.remotePort} → 127.0.0.1:${rule.localPort}`;
}

export const PortForwardPanel: React.FC = () => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const allRuntimes = usePortForwardStore((state) => state.runtimes);
  const selectedProfileId = useWorkbenchToolsStore((state) => state.portForwardProfileId);
  const selectProfile = useWorkbenchToolsStore((state) => state.selectPortForwardProfile);
  const pendingDraft = useWorkbenchToolsStore((state) => state.pendingPortForwardDraft);
  const consumeDraft = useWorkbenchToolsStore((state) => state.consumePortForwardDraft);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>();
  const [saving, setSaving] = useState(false);

  const effectiveProfileFilter = useMemo(() => {
    if (selectedProfileId === 'all') return 'all';
    return profiles.some((profile) => profile.id === selectedProfileId)
      ? selectedProfileId
      : 'all';
  }, [profiles, selectedProfileId]);

  useEffect(() => {
    if (selectedProfileId !== 'all' && effectiveProfileFilter === 'all') {
      selectProfile('all');
    }
  }, [effectiveProfileFilter, selectProfile, selectedProfileId]);

  useEffect(() => {
    if (!pendingDraft) return;
    const target = profiles.find((profile) => profile.id === pendingDraft.profileId);
    if (!target) {
      consumeDraft(pendingDraft.token);
      return;
    }
    setDraft({
      profileId: target.id,
      name: pendingDraft.draft.name,
      kind: pendingDraft.draft.kind,
      localPort: String(pendingDraft.draft.localPort),
      remoteHost: pendingDraft.draft.kind === 'dynamic'
        ? ''
        : (pendingDraft.draft.remoteHost ?? '127.0.0.1'),
      remotePort: pendingDraft.draft.kind === 'dynamic'
        ? ''
        : String(pendingDraft.draft.remotePort ?? ''),
      autoStart: Boolean(pendingDraft.draft.autoStart),
    });
    setDrawerOpen(true);
    consumeDraft(pendingDraft.token);
  }, [consumeDraft, pendingDraft, profiles]);

  const filterHostItems = useMemo(
    () => [
      { value: 'all', label: t('portForward.allHosts') },
      ...profiles.map((profile) => ({
        value: profile.id,
        label: profileDisplayName(profile),
      })),
    ],
    [profiles, t],
  );

  const formHostItems = useMemo(
    () => profiles.map((profile) => ({
      value: profile.id,
      label: profileOptionLabel(profile),
    })),
    [profiles],
  );

  const scopedEntries = useMemo<PortForwardEntry[]>(() => {
    const visibleProfiles = effectiveProfileFilter === 'all'
      ? profiles
      : profiles.filter((profile) => profile.id === effectiveProfileFilter);

    return visibleProfiles.flatMap((profile) => (
      (profile.portForwards ?? []).map((rule) => {
        const runtime = latestRuntime(allRuntimes, profile.id, rule.id);
        return {
          profile,
          rule,
          runtime,
          active: runtime ? isPortForwardActive(runtime) : false,
        };
      })
    ));
  }, [allRuntimes, effectiveProfileFilter, profiles]);

  const scopedRuntimes = useMemo(
    () => (
      effectiveProfileFilter === 'all'
        ? allRuntimes
        : allRuntimes.filter((runtime) => runtime.profileId === effectiveProfileFilter)
    ),
    [allRuntimes, effectiveProfileFilter],
  );

  const activeCount = useMemo(
    () => scopedRuntimes.filter(isPortForwardActive).length,
    [scopedRuntimes],
  );

  const hasFinishedHistory = useMemo(
    () => scopedRuntimes.some((runtime) => !isPortForwardActive(runtime)),
    [scopedRuntimes],
  );

  const normalizedQuery = query.trim().toLowerCase();

  const filteredEntries = useMemo(() => {
    return scopedEntries.filter((entry) => {
      if (statusFilter === 'active' && !entry.active) return false;
      if (statusFilter === 'failed' && entry.runtime?.status !== 'failed') return false;
      if (!normalizedQuery) return true;
      const haystack = [
        entry.rule.name,
        entry.rule.kind,
        String(entry.rule.localPort),
        entry.rule.remoteHost,
        String(entry.rule.remotePort),
        entry.profile.name,
        entry.profile.host,
        entry.profile.username,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, scopedEntries, statusFilter]);

  const validationError = useMemo(() => {
    if (!draft) return undefined;
    if (!draft.profileId || !profiles.some((profile) => profile.id === draft.profileId)) {
      return t('portForward.validation.profile');
    }
    const localPort = Number(draft.localPort);
    const remotePort = Number(draft.remotePort);
    if (!draft.name.trim()) return t('portForward.validation.name');
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
      return t('portForward.validation.port');
    }
    if (draft.kind === 'dynamic') return undefined;
    if (!draft.remoteHost.trim()) return t('portForward.validation.host');
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      return t('portForward.validation.port');
    }
    if (draft.kind === 'remote' && !['127.0.0.1', 'localhost', '::1'].includes(draft.remoteHost.trim())) {
      return t('portForward.validation.remoteLoopback');
    }
    return undefined;
  }, [draft, profiles, t]);

  const openCreate = (): void => {
    const defaultProfileId = effectiveProfileFilter !== 'all'
      ? effectiveProfileFilter
      : (profiles[0]?.id ?? '');
    if (!defaultProfileId) return;
    setDraft(createDraft(defaultProfileId));
    setDrawerOpen(true);
  };

  const closeDrawer = (): void => {
    if (saving) return;
    setDrawerOpen(false);
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft || validationError) return;
    const targetProfile = profiles.find((profile) => profile.id === draft.profileId);
    if (!targetProfile) return;

    const existingRules = targetProfile.portForwards ?? [];
    const nextRule: PortForwardRule = {
      id: draft.id ?? generateId(),
      name: draft.name.trim(),
      kind: draft.kind,
      localPort: Number(draft.localPort),
      remoteHost: draft.kind === 'dynamic' ? '' : draft.remoteHost.trim(),
      remotePort: draft.kind === 'dynamic' ? 0 : Number(draft.remotePort),
      autoStart: draft.autoStart,
    };
    const nextRules = draft.id
      ? existingRules.map((rule) => (rule.id === draft.id ? nextRule : rule))
      : [...existingRules, nextRule];

    setSaving(true);
    try {
      await useProfileStore.getState().updateProfile(targetProfile.id, { portForwards: nextRules });
      setDrawerOpen(false);
    } catch (error) {
      useToastStore.getState().addToast(getErrorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (profile: ConnectionProfile, rule: PortForwardRule): Promise<void> => {
    const runtime = latestRuntime(allRuntimes, profile.id, rule.id);
    if (runtime && isPortForwardActive(runtime)) {
      await usePortForwardStore
        .getState()
        .stop(runtime.operationId)
        .catch(() => {});
    }
    const existingRules = profile.portForwards ?? [];
    try {
      await useProfileStore.getState().updateProfile(profile.id, {
        portForwards: existingRules.filter((item) => item.id !== rule.id),
      });
    } catch (error) {
      useToastStore.getState().addToast(getErrorMessage(error), 'error');
    }
  };

  const selectedProfile = effectiveProfileFilter === 'all'
    ? undefined
    : profiles.find((profile) => profile.id === effectiveProfileFilter);

  return (
    <TooltipProvider>
      <WorkbenchPage>
        <WorkbenchPageHeader
          icon={CableIcon}
          title={t('portForward.title')}
          titleMeta={(
            <Popover>
              <PopoverTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 text-muted-foreground"
                    aria-label={t('portForward.help')}
                  />
                )}
              >
                <InfoIcon />
              </PopoverTrigger>
              <PopoverContent align="start" className="max-w-[calc(100vw-2rem)]">
                <PopoverTitle>{t('portForward.help')}</PopoverTitle>
                <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                  <p>{t('portForward.privacyNote')}</p>
                  <p>{t('portForward.form.description')}</p>
                </div>
              </PopoverContent>
            </Popover>
          )}
          description={selectedProfile
            ? `${profileDisplayName(selectedProfile)} · ${t('portForward.summary', { configured: scopedEntries.length, active: activeCount })}`
            : t('portForward.summary', { configured: scopedEntries.length, active: activeCount })}
          actions={(
            <>
              <WorkbenchSearchInput
                data-slot="input-group-control"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('portForward.searchPlaceholder')}
                aria-label={t('portForward.searchPlaceholder')}
              />
              {hasFinishedHistory && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => usePortForwardStore.getState().clearFinished(
                    effectiveProfileFilter === 'all' ? undefined : effectiveProfileFilter,
                  )}
                >
                  <EraserIcon data-icon="inline-start" />
                  {t('portForward.clearHistory')}
                </Button>
              )}
              <Button
                variant="default"
                size="sm"
                onClick={openCreate}
                disabled={profiles.length === 0}
              >
                <PlusIcon data-icon="inline-start" />
                {t('portForward.create')}
              </Button>
            </>
          )}
        />

        {profiles.length > 0 && (
          <WorkbenchPageToolbar className="flex-row flex-wrap items-center gap-1.5">
            {(['all', 'active', 'failed'] as const).map((filter) => (
              <Button
                key={filter}
                variant={statusFilter === filter ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setStatusFilter(filter)}
              >
                {t(`portForward.filter.${filter}`)}
              </Button>
            ))}
            <Separator orientation="vertical" aria-hidden="true" className="mx-0.5 h-3 data-vertical:self-center" />
            <Select
              items={filterHostItems}
              value={effectiveProfileFilter}
              onValueChange={(value) => selectProfile(value ?? 'all')}
            >
              <SelectPrimitive.Trigger
                render={<Button variant={effectiveProfileFilter === 'all' ? 'ghost' : 'secondary'} size="xs" />}
                className="min-w-0 max-w-48 shrink focus-visible:bg-accent data-popup-open:bg-accent"
                aria-label={t('portForward.hostFilter')}
              >
                <SelectValue />
                <SelectPrimitive.Icon>
                  <ChevronDownIcon aria-hidden data-icon="inline-end" />
                </SelectPrimitive.Icon>
              </SelectPrimitive.Trigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectGroup>
                  {filterHostItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </WorkbenchPageToolbar>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <WorkbenchPageContent>
            {profiles.length === 0 ? (
              <PanelEmptyState
                icon={<ServerIcon className="size-5" />}
                title={t('portForward.noProfilesTitle')}
                description={t('portForward.noProfilesDescription')}
              />
            ) : scopedEntries.length === 0 ? (
              <PanelEmptyState
                icon={<CableIcon className="size-5" />}
                title={t('portForward.emptyTitle')}
                description={t('portForward.emptyDescription')}
              />
            ) : filteredEntries.length === 0 ? (
              <PanelEmptyState
                icon={<SearchXIcon className="size-5" />}
                title={t('portForward.filteredEmpty')}
                description={t('common.noSearchResults')}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 @min-[46rem]:grid-cols-2">
                {filteredEntries.map(({ profile, rule, runtime, active }) => (
                  <Card key={`${profile.id}:${rule.id}`} size="sm" radius="compact" className="flex flex-col">
                    <CardHeader>
                      <CardTitle className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate">{rule.name}</span>
                        <Badge variant="outline">{t(`portForward.kind.${rule.kind}`)}</Badge>
                        <Badge variant={rule.autoStart ? 'secondary' : 'outline'}>
                          {rule.autoStart ? t('portForward.mode.auto') : t('portForward.mode.manual')}
                        </Badge>
                      </CardTitle>
                      <CardDescription className="truncate font-mono">
                        {ruleRouteSummary(rule)}
                      </CardDescription>
                      <CardAction>
                        <Badge variant={statusVariant(runtime?.status)}>
                          {t(`portForward.status.${runtime?.status ?? 'idle'}`)}
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col gap-3">
                      <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/45 px-2.5 py-1.5 text-xs">
                        <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
                          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate">{profileDisplayName(profile)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-muted-foreground">
                          {profile.host}:{profile.port}
                        </span>
                      </div>

                      {runtime ? (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>
                            {t('portForward.started')}: {runtime.startedAt ? new Date(runtime.startedAt).toLocaleString() : '—'}
                          </span>
                          <span>
                            {t('portForward.runMode')}: {t(`portForward.mode.${runtime.mode}`)}
                          </span>
                          <span className="flex items-center gap-1 font-mono tabular-nums">
                            <ArrowUpIcon className="size-3.5 shrink-0" aria-hidden />
                            {formatBytes(runtime.bytesSent)}
                          </span>
                          <span className="flex items-center gap-1 font-mono tabular-nums">
                            <ArrowDownIcon className="size-3.5 shrink-0" aria-hidden />
                            {formatBytes(runtime.bytesReceived)}
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
                    <CardFooter className="mt-auto flex-wrap justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            setDraft(createDraft(profile.id, rule));
                            setDrawerOpen(true);
                          }}
                          disabled={active}
                        >
                          <PencilIcon data-icon="inline-start" />
                          {t('common.edit')}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void removeRule(profile, rule)}
                        >
                          <Trash2Icon data-icon="inline-start" />
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
                          <SquareIcon data-icon="inline-start" />
                          {t('portForward.stop')}
                        </Button>
                      ) : runtime?.status === 'failed' ? (
                        <Button
                          size="xs"
                          onClick={() => void usePortForwardStore.getState().retry(runtime.operationId)}
                        >
                          <RotateCcwIcon data-icon="inline-start" />
                          {t('portForward.retry')}
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          onClick={() => void usePortForwardStore.getState().startRule(profile, rule, 'manual')}
                        >
                          <PlayIcon data-icon="inline-start" />
                          {t('portForward.start')}
                        </Button>
                      )}
                    </CardFooter>
                  </Card>
                ))}
              </div>
            )}
          </WorkbenchPageContent>
        </ScrollArea>
      </WorkbenchPage>

      <Drawer open={drawerOpen} onOpenChange={(open) => { if (!open) closeDrawer(); }}>
        <DrawerContent className="min-h-0 w-100 gap-0 p-0">
          <DrawerHeader className="shrink-0 border-b border-app-border px-4 py-4 pr-12">
            <DrawerTitle>{draft?.id ? t('portForward.edit') : t('portForward.create')}</DrawerTitle>
            <p className="text-xs text-muted-foreground">{t('portForward.form.description')}</p>
          </DrawerHeader>

          {draft && (
            <>
              <ScrollArea className="min-h-0 flex-1">
                <FieldGroup className="gap-4 px-4 py-4">
                  <Field>
                    <FieldLabel htmlFor="port-forward-host">{t('portForward.form.host')}</FieldLabel>
                    <Select
                      items={formHostItems}
                      value={draft.profileId}
                      disabled={Boolean(draft.id)}
                      onValueChange={(value) => {
                        if (value) setDraft({ ...draft, profileId: value });
                      }}
                    >
                      <SelectTrigger
                        id="port-forward-host"
                        className="w-full"
                        aria-label={t('portForward.form.host')}
                      >
                        <SelectValue placeholder={t('portForward.form.hostPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {formHostItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="port-forward-name">{t('portForward.form.name')}</FieldLabel>
                    <Input
                      id="port-forward-name"
                      autoFocus
                      placeholder={
                        draft.kind === 'dynamic'
                          ? t('portForward.form.namePlaceholderDynamic')
                          : t('portForward.form.namePlaceholder')
                      }
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
                      className="w-full"
                    >
                      <ToggleGroupItem value="local" className="flex-1">{t('portForward.kind.local')}</ToggleGroupItem>
                      <ToggleGroupItem value="remote" className="flex-1">{t('portForward.kind.remote')}</ToggleGroupItem>
                      <ToggleGroupItem value="dynamic" className="flex-1">{t('portForward.kind.dynamic')}</ToggleGroupItem>
                    </ToggleGroup>
                    <FieldDescription>{t(`portForward.kind.${draft.kind}Detail`)}</FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="port-forward-local-port">
                      {draft.kind === 'remote' ? t('portForward.form.localTargetPort') : t('portForward.form.listenPort')}
                    </FieldLabel>
                    <Input
                      id="port-forward-local-port"
                      inputMode="numeric"
                      placeholder={draft.kind === 'dynamic' ? '1080' : draft.kind === 'remote' ? '3000' : '8080'}
                      value={draft.localPort}
                      onChange={(event) => setDraft({ ...draft, localPort: event.target.value })}
                    />
                  </Field>

                  {draft.kind !== 'dynamic' && (
                    <div className="grid grid-cols-3 gap-2">
                      <Field className="col-span-2">
                        <FieldLabel htmlFor="port-forward-remote-host">
                          {draft.kind === 'local'
                            ? t('portForward.form.remoteTargetHost')
                            : t('portForward.form.remoteListenHost')}
                        </FieldLabel>
                        <Input
                          id="port-forward-remote-host"
                          disabled={draft.kind === 'remote'}
                          placeholder="127.0.0.1"
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
                          placeholder={draft.kind === 'remote' ? '8080' : '5432'}
                          value={draft.remotePort}
                          onChange={(event) => setDraft({ ...draft, remotePort: event.target.value })}
                        />
                      </Field>
                    </div>
                  )}

                  <Field className="flex-row items-center justify-between gap-3 rounded-lg border border-app-border px-3.5 py-3">
                    <div className="min-w-0">
                      <FieldLabel htmlFor="port-forward-auto-start">{t('portForward.form.autoStart')}</FieldLabel>
                      <FieldDescription>{t('portForward.form.autoStartDetail')}</FieldDescription>
                    </div>
                    <Switch
                      id="port-forward-auto-start"
                      checked={draft.autoStart}
                      onCheckedChange={(checked) => setDraft({ ...draft, autoStart: checked })}
                    />
                  </Field>
                </FieldGroup>
              </ScrollArea>

              <DrawerFooter className="shrink-0 flex-col gap-2 px-4 pb-4 pt-2 sm:flex-col">
                {validationError && <FieldError>{validationError}</FieldError>}
                <div className="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={closeDrawer} disabled={saving}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={Boolean(validationError) || saving}
                    onClick={() => void saveDraft()}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </TooltipProvider>
  );
};
