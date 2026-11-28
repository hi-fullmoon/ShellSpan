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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon, ManagementCardText } from './management-card';
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
  const profilesInitialized = useProfileStore((state) => state.initialized);
  const allRuntimes = usePortForwardStore((state) => state.runtimes);
  const selectedProfileId = useWorkbenchToolsStore((state) => state.portForwardProfileId);
  const selectProfile = useWorkbenchToolsStore((state) => state.selectPortForwardProfile);
  const pendingDraft = useWorkbenchToolsStore((state) => state.pendingPortForwardDraft);
  const consumeDraft = useWorkbenchToolsStore((state) => state.consumePortForwardDraft);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>();
  const [showValidation, setShowValidation] = useState(false);
  const [deleting, setDeleting] = useState<{
    profile: ConnectionProfile;
    rule: PortForwardRule;
    active: boolean;
  }>();
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
    setShowValidation(false);
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

  const fieldErrors = useMemo(() => {
    const errors: Partial<Record<'profileId' | 'name' | 'localPort' | 'remoteHost' | 'remotePort', string>> = {};
    if (!draft) return errors;
    if (!draft.profileId || !profiles.some((profile) => profile.id === draft.profileId)) {
      errors.profileId = t('portForward.validation.profile');
    }
    if (!draft.name.trim()) {
      errors.name = t('portForward.validation.name');
    }
    const localPort = Number(draft.localPort);
    if (!draft.localPort.trim() || !Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
      errors.localPort = t('portForward.validation.port');
    }
    if (draft.kind !== 'dynamic') {
      if (!draft.remoteHost.trim()) {
        errors.remoteHost = t('portForward.validation.host');
      } else if (draft.kind === 'remote' && !['127.0.0.1', 'localhost', '::1'].includes(draft.remoteHost.trim())) {
        errors.remoteHost = t('portForward.validation.remoteLoopback');
      }
      const remotePort = Number(draft.remotePort);
      if (!draft.remotePort.trim() || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
        errors.remotePort = t('portForward.validation.port');
      }
    }
    return errors;
  }, [draft, profiles, t]);

  const hasValidationErrors = Object.keys(fieldErrors).length > 0;

  const openCreate = (): void => {
    const defaultProfileId = effectiveProfileFilter !== 'all'
      ? effectiveProfileFilter
      : (profiles[0]?.id ?? '');
    if (!defaultProfileId) return;
    setDraft(createDraft(defaultProfileId));
    setShowValidation(false);
    setDrawerOpen(true);
  };

  const closeDrawer = (): void => {
    if (saving) return;
    setShowValidation(false);
    setDrawerOpen(false);
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    if (hasValidationErrors) {
      setShowValidation(true);
      const firstKey = Object.keys(fieldErrors)[0] as keyof typeof fieldErrors | undefined;
      if (firstKey) {
        const controlIds: Record<keyof typeof fieldErrors, string> = {
          profileId: 'port-forward-host',
          name: 'port-forward-name',
          localPort: 'port-forward-local-port',
          remoteHost: 'port-forward-remote-host',
          remotePort: 'port-forward-remote-port',
        };
        window.requestAnimationFrame(() => {
          document.getElementById(controlIds[firstKey])?.focus();
        });
      }
      return;
    }
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
      setShowValidation(false);
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
      if (draft?.id === rule.id && draft.profileId === profile.id) {
        setDrawerOpen(false);
      }
      setDeleting(undefined);
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
            {!profilesInitialized && profiles.length === 0 ? (
              <PanelLoadingState />
            ) : profiles.length === 0 ? (
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
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-2">
                {filteredEntries.map(({ profile, rule, runtime, active }) => (
                  <ManagementCard key={`${profile.id}:${rule.id}`} className="gap-2">
                    <div className="flex items-center gap-2">
                      <ManagementCardIcon>
                        <CableIcon aria-hidden />
                      </ManagementCardIcon>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <ManagementCardText
                            text={rule.name}
                            className="flex-1 text-sm font-medium text-app-text"
                          />
                          <Badge variant={statusVariant(runtime?.status)} size="sm" className="shrink-0">
                            {t(`portForward.status.${runtime?.status ?? 'idle'}`)}
                          </Badge>
                        </div>
                        <ManagementCardText
                          text={ruleRouteSummary(rule)}
                          className="font-mono text-xs text-muted-foreground"
                        />
                      </div>
                    </div>

                    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <ServerIcon className="size-3.5 shrink-0" aria-hidden />
                      <ManagementCardText
                        text={`${profileDisplayName(profile)} · ${profile.host}:${profile.port}`}
                        className="flex-1 text-xs text-muted-foreground"
                      />
                    </div>

                    {runtime && (runtime.startedAt || runtime.bytesSent > 0 || runtime.bytesReceived > 0) ? (
                      <div className="flex items-center justify-between gap-2 rounded-md border border-app-border/60 bg-muted/50 px-2 py-0.5 text-[11px] leading-4 text-muted-foreground">
                        <div className="flex items-center gap-2.5 font-mono tabular-nums">
                          <span className="flex items-center gap-1">
                            <ArrowUpIcon className="size-3 shrink-0" aria-hidden />
                            {formatBytes(runtime.bytesSent)}
                          </span>
                          <span className="flex items-center gap-1">
                            <ArrowDownIcon className="size-3 shrink-0" aria-hidden />
                            {formatBytes(runtime.bytesReceived)}
                          </span>
                        </div>
                        {runtime.startedAt ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="truncate font-mono tabular-nums" tabIndex={0} />
                              }
                            >
                              {new Date(runtime.startedAt).toLocaleTimeString()}
                            </TooltipTrigger>
                            <TooltipContent>
                              {t('portForward.started')}: {new Date(runtime.startedAt).toLocaleString()} · {t('portForward.runMode')}: {t(`portForward.mode.${runtime.mode}`)}
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                    ) : null}

                    {runtime?.lastError ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <div
                              role="alert"
                              tabIndex={0}
                              className="flex min-w-0 items-center gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-[11px] leading-4 text-destructive"
                            />
                          }
                        >
                          <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
                          <span className="shrink-0 font-medium">
                            {runtime.errorCategory === 'portInUse'
                              ? t('portForward.error.portInUseTitle')
                              : t('portForward.error.title')}
                          </span>
                          <span aria-hidden className="shrink-0 opacity-60">·</span>
                          <span className="min-w-0 flex-1 truncate text-destructive/85">
                            {runtime.lastError}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">
                          <div className="font-medium">
                            {runtime.errorCategory === 'portInUse'
                              ? t('portForward.error.portInUseTitle')
                              : t('portForward.error.title')}
                          </div>
                          <div>{runtime.lastError}</div>
                        </TooltipContent>
                      </Tooltip>
                    ) : null}

                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-0.5">
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <Badge variant="outline" size="sm">{t(`portForward.kind.${rule.kind}`)}</Badge>
                        <Badge variant={rule.autoStart ? 'secondary' : 'outline'} size="sm">
                          {rule.autoStart ? t('portForward.mode.auto') : t('portForward.mode.manual')}
                        </Badge>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {active && runtime ? (
                          <IconActionButton
                            disabled={runtime.status === 'stopping'}
                            onClick={() => void usePortForwardStore.getState().stop(runtime.operationId)}
                            aria-label={t('portForward.stop')}
                            tooltip={t('portForward.stop')}
                          >
                            <SquareIcon data-icon="inline-start" className="text-destructive" />
                          </IconActionButton>
                        ) : runtime?.status === 'failed' ? (
                          <IconActionButton
                            onClick={() => void usePortForwardStore.getState().retry(runtime.operationId)}
                            aria-label={t('portForward.retry')}
                            tooltip={t('portForward.retry')}
                          >
                            <RotateCcwIcon data-icon="inline-start" className="text-app-primary" />
                          </IconActionButton>
                        ) : (
                          <IconActionButton
                            onClick={() => void usePortForwardStore.getState().startRule(profile, rule, 'manual')}
                            aria-label={t('portForward.start')}
                            tooltip={t('portForward.start')}
                          >
                            <PlayIcon data-icon="inline-start" />
                          </IconActionButton>
                        )}
                        <IconActionButton
                          onClick={() => {
                            setDraft(createDraft(profile.id, rule));
                            setShowValidation(false);
                            setDrawerOpen(true);
                          }}
                          disabled={active}
                          aria-label={t('common.edit')}
                          tooltip={t('common.edit')}
                        >
                          <PencilIcon data-icon="inline-start" />
                        </IconActionButton>
                        <IconActionButton
                          onClick={() => setDeleting({ profile, rule, active })}
                          aria-label={t('common.delete')}
                          tooltip={t('common.delete')}
                        >
                          <Trash2Icon data-icon="inline-start" className="text-destructive" />
                        </IconActionButton>
                      </div>
                    </div>
                  </ManagementCard>
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
                  <Field data-invalid={(showValidation && Boolean(fieldErrors.profileId)) || undefined}>
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
                    <FieldError>{showValidation ? fieldErrors.profileId : undefined}</FieldError>
                  </Field>

                  <Field data-invalid={(showValidation && Boolean(fieldErrors.name)) || undefined}>
                    <FieldLabel htmlFor="port-forward-name">{t('portForward.form.name')}</FieldLabel>
                    <Input
                      id="port-forward-name"
                      autoFocus
                      aria-invalid={(showValidation && Boolean(fieldErrors.name)) || undefined}
                      placeholder={
                        draft.kind === 'dynamic'
                          ? t('portForward.form.namePlaceholderDynamic')
                          : t('portForward.form.namePlaceholder')
                      }
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                    <FieldError>{showValidation ? fieldErrors.name : undefined}</FieldError>
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

                  <Field data-invalid={(showValidation && Boolean(fieldErrors.localPort)) || undefined}>
                    <FieldLabel htmlFor="port-forward-local-port">
                      {draft.kind === 'remote' ? t('portForward.form.localTargetPort') : t('portForward.form.listenPort')}
                    </FieldLabel>
                    <Input
                      id="port-forward-local-port"
                      inputMode="numeric"
                      aria-invalid={(showValidation && Boolean(fieldErrors.localPort)) || undefined}
                      placeholder={draft.kind === 'dynamic' ? '1080' : draft.kind === 'remote' ? '3000' : '8080'}
                      value={draft.localPort}
                      onChange={(event) => setDraft({ ...draft, localPort: event.target.value })}
                    />
                    <FieldError>{showValidation ? fieldErrors.localPort : undefined}</FieldError>
                  </Field>

                  {draft.kind !== 'dynamic' && (
                    <div className="grid grid-cols-3 gap-2">
                      <Field
                        className="col-span-2"
                        data-invalid={(showValidation && Boolean(fieldErrors.remoteHost)) || undefined}
                      >
                        <FieldLabel htmlFor="port-forward-remote-host">
                          {draft.kind === 'local'
                            ? t('portForward.form.remoteTargetHost')
                            : t('portForward.form.remoteListenHost')}
                        </FieldLabel>
                        <Input
                          id="port-forward-remote-host"
                          disabled={draft.kind === 'remote'}
                          aria-invalid={(showValidation && Boolean(fieldErrors.remoteHost)) || undefined}
                          placeholder="127.0.0.1"
                          value={draft.remoteHost}
                          onChange={(event) => setDraft({ ...draft, remoteHost: event.target.value })}
                        />
                        <FieldError>{showValidation ? fieldErrors.remoteHost : undefined}</FieldError>
                      </Field>
                      <Field data-invalid={(showValidation && Boolean(fieldErrors.remotePort)) || undefined}>
                        <FieldLabel htmlFor="port-forward-remote-port">
                          {draft.kind === 'local'
                            ? t('portForward.form.remoteTargetPort')
                            : t('portForward.form.remoteListenPort')}
                        </FieldLabel>
                        <Input
                          id="port-forward-remote-port"
                          inputMode="numeric"
                          aria-invalid={(showValidation && Boolean(fieldErrors.remotePort)) || undefined}
                          placeholder={draft.kind === 'remote' ? '8080' : '5432'}
                          value={draft.remotePort}
                          onChange={(event) => setDraft({ ...draft, remotePort: event.target.value })}
                        />
                        <FieldError>{showValidation ? fieldErrors.remotePort : undefined}</FieldError>
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

              <DrawerFooter className="shrink-0 flex-row justify-end gap-2 px-4 pb-4 pt-2">
                <Button variant="outline" size="sm" onClick={closeDrawer} disabled={saving}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => void saveDraft()}
                >
                  {t('common.save')}
                </Button>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>

      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={t('portForward.deleteTitle')}
        description={
          deleting
            ? t(
                deleting.active ? 'portForward.deleteConfirmActive' : 'portForward.deleteConfirm',
                { name: deleting.rule.name },
              )
            : ''
        }
        onConfirm={() => {
          if (deleting) void removeRule(deleting.profile, deleting.rule);
        }}
      />
    </TooltipProvider>
  );
};
