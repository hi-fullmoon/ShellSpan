import React, { useEffect, useMemo, useState } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import {
  ArrowUpRightIcon,
  CableIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  FolderIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  SearchXIcon,
  ServerIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WrenchIcon,
  ZapIcon,
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import {
  insertHostCommandSnippet,
  openHostPath,
  runHostConnectionAction,
  validateHostQuickAction,
  type HostQuickActionValidationError,
} from '@/lib/host/host-quick-actions';
import { generateId } from '@/lib/utils';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkbenchToolsStore } from '@/stores/workbenchToolsStore';
import type {
  ConnectionProfile,
  HostConnectionAction,
  HostQuickAction,
} from '@/types';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon, ManagementCardText } from './management-card';
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
  WorkbenchPageToolbar,
  WorkbenchSearchInput,
} from './workbench-page';

const MAX_ACTIONS_PER_HOST = 24;

type KindFilter = 'all' | HostQuickAction['kind'];

interface QuickActionDraft {
  id?: string;
  profileId: string;
  kind: HostQuickAction['kind'];
  label: string;
  path: string;
  target: 'terminal' | 'sftp';
  command: string;
  action: HostConnectionAction;
}

interface QuickActionEntry {
  profile: ConnectionProfile;
  action: HostQuickAction;
}

function profileDisplayName(profile: ConnectionProfile): string {
  return profile.name.trim() || profile.host;
}

function profileOptionLabel(profile: ConnectionProfile): string {
  return `${profileDisplayName(profile)} · ${profile.username}@${profile.host}:${profile.port}`;
}

function createDraft(profileId: string, action?: HostQuickAction): QuickActionDraft {
  const base: QuickActionDraft = {
    profileId,
    kind: 'directory',
    label: '',
    path: '',
    target: 'terminal',
    command: '',
    action: 'terminal',
  };
  if (!action) return base;
  return { ...base, ...action };
}

function toAction(draft: QuickActionDraft): HostQuickAction {
  const shared = { id: draft.id ?? generateId(), label: draft.label.trim() };
  if (draft.kind === 'directory') {
    return {
      ...shared,
      kind: 'directory',
      path: draft.path.trim(),
      target: draft.target,
    };
  }
  if (draft.kind === 'command') {
    return { ...shared, kind: 'command', command: draft.command };
  }
  return { ...shared, kind: 'connection', action: draft.action };
}

function actionIcon(action: HostQuickAction): React.ElementType {
  if (action.kind === 'directory') return FolderIcon;
  if (action.kind === 'command') return SquareTerminalIcon;
  if (action.action === 'portForward') return CableIcon;
  if (action.action === 'overview') return InfoIcon;
  return action.action === 'sftp' ? FolderIcon : SquareTerminalIcon;
}

export const HostQuickActionsPanel: React.FC = () => {
  const { t } = useI18n();
  const { error: showError, info, success } = useToast();
  const profiles = useProfileStore((state) => state.profiles);
  const profilesInitialized = useProfileStore((state) => state.initialized);
  const updateProfile = useProfileStore((state) => state.updateProfile);
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const selectedProfileId = useWorkbenchToolsStore((state) => state.quickActionsProfileId);
  const selectProfile = useWorkbenchToolsStore((state) => state.selectQuickActionsProfile);

  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<QuickActionDraft>();
  const [deleting, setDeleting] = useState<{
    profile: ConnectionProfile;
    action: HostQuickAction;
  }>();
  const [validationError, setValidationError] = useState<HostQuickActionValidationError | 'profile' | 'limit'>();
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

  const connectedWritableProfileIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of terminalSessions) {
      if (session.profileId && session.status === 'connected' && !session.readOnly) {
        ids.add(session.profileId);
      }
    }
    return ids;
  }, [terminalSessions]);

  const actionDescriptions = useMemo(() => ({
    terminal: t('hostQuickActions.connection.terminal'),
    sftp: t('hostQuickActions.connection.sftp'),
    portForward: t('hostQuickActions.connection.portForward'),
    overview: t('hostQuickActions.connection.overview'),
  }), [t]);

  const connectionActionItems = useMemo(
    () => (Object.keys(actionDescriptions) as HostConnectionAction[]).map((action) => ({
      value: action,
      label: actionDescriptions[action],
    })),
    [actionDescriptions],
  );

  const filterHostItems = useMemo(
    () => [
      { value: 'all', label: t('hostQuickActions.allHosts') },
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

  const scopedEntries = useMemo<QuickActionEntry[]>(() => {
    const visibleProfiles = effectiveProfileFilter === 'all'
      ? profiles
      : profiles.filter((profile) => profile.id === effectiveProfileFilter);

    return visibleProfiles.flatMap((profile) => (
      (profile.quickActions ?? []).map((action) => ({ profile, action }))
    ));
  }, [effectiveProfileFilter, profiles]);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredEntries = useMemo(() => {
    return scopedEntries.filter(({ profile, action }) => {
      if (kindFilter !== 'all' && action.kind !== kindFilter) return false;
      if (!normalizedQuery) return true;
      const detail = action.kind === 'directory'
        ? action.path
        : action.kind === 'command'
          ? action.command
          : actionDescriptions[action.action];
      const haystack = [
        action.label,
        action.kind,
        detail,
        profile.name,
        profile.host,
        profile.username,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [actionDescriptions, kindFilter, normalizedQuery, scopedEntries]);

  const selectedProfile = effectiveProfileFilter === 'all'
    ? undefined
    : profiles.find((profile) => profile.id === effectiveProfileFilter);

  const canCreate = useMemo(() => {
    if (profiles.length === 0) return false;
    if (selectedProfile) {
      return (selectedProfile.quickActions ?? []).length < MAX_ACTIONS_PER_HOST;
    }
    return profiles.some((profile) => (profile.quickActions ?? []).length < MAX_ACTIONS_PER_HOST);
  }, [profiles, selectedProfile]);

  const openCreate = (): void => {
    const defaultProfile = selectedProfile
      ?? profiles.find((profile) => (profile.quickActions ?? []).length < MAX_ACTIONS_PER_HOST)
      ?? profiles[0];
    if (!defaultProfile) return;
    setDraft(createDraft(defaultProfile.id));
    setValidationError(undefined);
    setDrawerOpen(true);
  };

  const closeDrawer = (): void => {
    if (saving) return;
    setDrawerOpen(false);
    setValidationError(undefined);
  };

  const persistActions = async (
    profileId: string,
    nextActions: HostQuickAction[],
  ): Promise<void> => {
    setSaving(true);
    try {
      await updateProfile(profileId, { quickActions: nextActions });
      success(t('hostQuickActions.saved'));
    } catch {
      showError(t('hostQuickActions.saveFailed'));
      throw new Error('failed to save host quick actions');
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    const targetProfile = profiles.find((profile) => profile.id === draft.profileId);
    if (!targetProfile) {
      setValidationError('profile');
      return;
    }
    const existingActions = targetProfile.quickActions ?? [];
    if (!draft.id && existingActions.length >= MAX_ACTIONS_PER_HOST) {
      setValidationError('limit');
      return;
    }
    const action = toAction(draft);
    const error = validateHostQuickAction(action);
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(undefined);
    const nextActions = draft.id
      ? existingActions.map((item) => (item.id === draft.id ? action : item))
      : [...existingActions, action];
    try {
      await persistActions(targetProfile.id, nextActions);
      setDrawerOpen(false);
    } catch {
      // Keep the draft open so the user can retry after toast feedback.
    }
  };

  const removeAction = async (profile: ConnectionProfile, actionId: string): Promise<void> => {
    const existingActions = profile.quickActions ?? [];
    try {
      await persistActions(
        profile.id,
        existingActions.filter((action) => action.id !== actionId),
      );
      if (draft?.id === actionId && draft.profileId === profile.id) {
        setDrawerOpen(false);
      }
      setDeleting(undefined);
    } catch {
      // Preserve the current list on persistence failure.
    }
  };

  const runAction = async (profile: ConnectionProfile, action: HostQuickAction): Promise<void> => {
    if (action.kind === 'directory') {
      openHostPath(profile, action.path, action.target);
      return;
    }
    if (action.kind === 'connection') {
      runHostConnectionAction(profile.id, action.action);
      return;
    }
    try {
      const result = await insertHostCommandSnippet(profile.id, action.command);
      if (result === 'inserted') {
        info(t('hostQuickActions.inserted'));
      } else if (result === 'no-target') {
        showError(t('hostQuickActions.noTerminal'));
      } else {
        showError(t('hostQuickActions.validation.invalidCommand'));
      }
    } catch {
      showError(t('hostQuickActions.insertFailed'));
    }
  };

  return (
    <TooltipProvider>
      <WorkbenchPage>
        <WorkbenchPageHeader
          icon={ZapIcon}
          title={t('workbench.quickActions.title')}
          titleMeta={(
            <Popover>
              <PopoverTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 text-muted-foreground"
                    aria-label={t('hostQuickActions.safetyTitle')}
                  />
                )}
              >
                <InfoIcon />
              </PopoverTrigger>
              <PopoverContent align="start" className="max-w-[calc(100vw-2rem)]">
                <PopoverTitle>{t('hostQuickActions.safetyTitle')}</PopoverTitle>
                <p className="text-xs text-muted-foreground">
                  {t('hostQuickActions.safetyDescription')}
                </p>
              </PopoverContent>
            </Popover>
          )}
          description={selectedProfile
            ? `${profileDisplayName(selectedProfile)} · ${t('hostQuickActions.summary', { count: scopedEntries.length })}`
            : t('hostQuickActions.summary', { count: scopedEntries.length })}
          actions={(
            <>
              <WorkbenchSearchInput
                data-slot="input-group-control"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('hostQuickActions.searchPlaceholder')}
                aria-label={t('hostQuickActions.searchPlaceholder')}
              />
              <Button
                variant="default"
                size="sm"
                onClick={openCreate}
                disabled={!canCreate}
              >
                <PlusIcon data-icon="inline-start" />
                {t('hostQuickActions.create')}
              </Button>
            </>
          )}
        />

        {profiles.length > 0 && (
          <WorkbenchPageToolbar className="flex-row flex-wrap items-center gap-1.5">
            {(['all', 'directory', 'command', 'connection'] as const).map((filter) => (
              <Button
                key={filter}
                variant={kindFilter === filter ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setKindFilter(filter)}
              >
                {filter === 'all'
                  ? t('hostQuickActions.filter.all')
                  : t(`hostQuickActions.kind.${filter}`)}
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
                aria-label={t('hostQuickActions.hostFilter')}
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
                title={t('hostQuickActions.noProfilesTitle')}
                description={t('hostQuickActions.noProfilesDescription')}
              />
            ) : scopedEntries.length === 0 ? (
              <PanelEmptyState
                icon={<WrenchIcon className="size-5" />}
                title={t('hostQuickActions.empty')}
                description={t('hostQuickActions.emptyDescription')}
              />
            ) : filteredEntries.length === 0 ? (
              <PanelEmptyState
                icon={<SearchXIcon className="size-5" />}
                title={t('hostQuickActions.filteredEmpty')}
                description={t('common.noSearchResults')}
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-2">
                {filteredEntries.map(({ profile, action }) => {
                  const Icon = actionIcon(action);
                  const commandDisabled = action.kind === 'command'
                    && !connectedWritableProfileIds.has(profile.id);
                  const detail = action.kind === 'directory'
                    ? `${action.target === 'terminal' ? t('hostQuickActions.target.terminal') : t('hostQuickActions.target.sftp')} · ${action.path}`
                    : action.kind === 'command'
                      ? action.command
                      : actionDescriptions[action.action];

                  return (
                    <ManagementCard key={`${profile.id}:${action.id}`} className="gap-2">
                      <div className="flex items-center gap-2">
                        <ManagementCardIcon>
                          <Icon aria-hidden />
                        </ManagementCardIcon>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <ManagementCardText
                              text={action.label}
                              className="flex-1 text-sm font-medium text-app-text"
                            />
                            <Badge variant="secondary" size="sm" className="shrink-0">
                              {t(`hostQuickActions.kind.${action.kind}`)}
                            </Badge>
                          </div>
                          <ManagementCardText
                            text={detail}
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

                      <div className="mt-auto flex items-center justify-end gap-1 pt-0.5">
                        <IconActionButton
                          aria-label={action.kind === 'command' ? t('hostQuickActions.insert') : t('hostQuickActions.run')}
                          tooltip={commandDisabled
                            ? t('hostQuickActions.noTerminal')
                            : (action.kind === 'command' ? t('hostQuickActions.insert') : t('hostQuickActions.run'))}
                          onClick={() => void runAction(profile, action)}
                          disabled={commandDisabled}
                        >
                          {action.kind === 'command'
                            ? <CornerDownRightIcon data-icon="inline-start" />
                            : <ArrowUpRightIcon data-icon="inline-start" />}
                        </IconActionButton>
                        <IconActionButton
                          aria-label={t('common.edit')}
                          tooltip={t('common.edit')}
                          onClick={() => {
                            setDraft(createDraft(profile.id, action));
                            setValidationError(undefined);
                            setDrawerOpen(true);
                          }}
                        >
                          <PencilIcon data-icon="inline-start" />
                        </IconActionButton>
                        <IconActionButton
                          aria-label={t('common.delete')}
                          tooltip={t('common.delete')}
                          onClick={() => setDeleting({ profile, action })}
                          disabled={saving}
                        >
                          <Trash2Icon data-icon="inline-start" className="text-destructive" />
                        </IconActionButton>
                      </div>
                    </ManagementCard>
                  );
                })}
              </div>
            )}
          </WorkbenchPageContent>
        </ScrollArea>
      </WorkbenchPage>

      <Drawer open={drawerOpen} onOpenChange={(open) => { if (!open) closeDrawer(); }}>
        <DrawerContent className="min-h-0 w-100 gap-0 p-0">
          <DrawerHeader className="shrink-0 border-b border-app-border px-4 py-4 pr-12">
            <DrawerTitle>
              {draft?.id ? t('hostQuickActions.edit') : t('hostQuickActions.create')}
            </DrawerTitle>
            <p className="text-xs text-muted-foreground">{t('hostQuickActions.safetyDescription')}</p>
          </DrawerHeader>

          {draft && (
            <>
              <ScrollArea className="min-h-0 flex-1">
                <FieldGroup className="gap-4 px-4 py-4">
                  <Field data-invalid={validationError === 'profile' || validationError === 'limit' || undefined}>
                    <FieldLabel htmlFor="host-quick-action-host">{t('hostQuickActions.host')}</FieldLabel>
                    <Select
                      items={formHostItems}
                      value={draft.profileId}
                      disabled={Boolean(draft.id)}
                      onValueChange={(value) => {
                        if (value) {
                          setDraft({ ...draft, profileId: value });
                          if (validationError === 'profile' || validationError === 'limit') {
                            setValidationError(undefined);
                          }
                        }
                      }}
                    >
                      <SelectTrigger
                        id="host-quick-action-host"
                        className="w-full"
                        aria-label={t('hostQuickActions.host')}
                      >
                        <SelectValue placeholder={t('hostQuickActions.hostPlaceholder')} />
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
                    <FieldError>
                      {validationError === 'profile'
                        ? t('hostQuickActions.validation.profile')
                        : validationError === 'limit'
                          ? t('hostQuickActions.limitReached')
                          : undefined}
                    </FieldError>
                  </Field>

                  <Field data-invalid={validationError === 'invalidLabel' || undefined}>
                    <FieldLabel htmlFor="host-quick-action-label">{t('hostQuickActions.label')}</FieldLabel>
                    <Input
                      id="host-quick-action-label"
                      autoFocus
                      aria-invalid={validationError === 'invalidLabel' || undefined}
                      placeholder={t(`hostQuickActions.labelPlaceholder.${draft.kind}`)}
                      value={draft.label}
                      onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                    />
                    <FieldError>
                      {validationError === 'invalidLabel'
                        ? t('hostQuickActions.validation.invalidLabel')
                        : undefined}
                    </FieldError>
                  </Field>

                  <Field>
                    <FieldLabel>{t('hostQuickActions.kind')}</FieldLabel>
                    <ToggleGroup
                      value={[draft.kind]}
                      onValueChange={(value) => {
                        const kind = value[0] as HostQuickAction['kind'] | undefined;
                        if (!kind) return;
                        setDraft({ ...draft, kind });
                        setValidationError(undefined);
                      }}
                      variant="outline"
                      spacing={0}
                      className="w-full"
                    >
                      <ToggleGroupItem value="directory" className="flex-1">{t('hostQuickActions.kind.directory')}</ToggleGroupItem>
                      <ToggleGroupItem value="command" className="flex-1">{t('hostQuickActions.kind.command')}</ToggleGroupItem>
                      <ToggleGroupItem value="connection" className="flex-1">{t('hostQuickActions.kind.connection')}</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>

                  {draft.kind === 'directory' && (
                    <>
                      <Field data-invalid={validationError === 'invalidPath' || undefined}>
                        <FieldLabel htmlFor="host-quick-action-path">{t('hostQuickActions.path')}</FieldLabel>
                        <Input
                          id="host-quick-action-path"
                          aria-invalid={validationError === 'invalidPath' || undefined}
                          placeholder="/var/log/nginx"
                          value={draft.path}
                          onChange={(event) => setDraft({ ...draft, path: event.target.value })}
                        />
                        <FieldError>
                          {validationError === 'invalidPath'
                            ? t('hostQuickActions.validation.invalidPath')
                            : undefined}
                        </FieldError>
                      </Field>
                      <Field>
                        <FieldLabel>{t('hostQuickActions.directoryTarget')}</FieldLabel>
                        <ToggleGroup
                          value={[draft.target]}
                          onValueChange={(value) => {
                            const target = value[0] as 'terminal' | 'sftp' | undefined;
                            if (target) setDraft({ ...draft, target });
                          }}
                          variant="outline"
                          spacing={0}
                          className="w-full"
                        >
                          <ToggleGroupItem value="terminal" className="flex-1">{t('hostQuickActions.target.terminal')}</ToggleGroupItem>
                          <ToggleGroupItem value="sftp" className="flex-1">{t('hostQuickActions.target.sftp')}</ToggleGroupItem>
                        </ToggleGroup>
                      </Field>
                    </>
                  )}

                  {draft.kind === 'command' && (
                    <Field
                      data-invalid={
                        validationError === 'invalidCommand'
                        || validationError === 'possibleSecret'
                        || undefined
                      }
                    >
                      <FieldLabel htmlFor="host-quick-action-command">{t('hostQuickActions.command')}</FieldLabel>
                      <Input
                        id="host-quick-action-command"
                        aria-invalid={
                          validationError === 'invalidCommand'
                          || validationError === 'possibleSecret'
                          || undefined
                        }
                        placeholder="systemctl status nginx"
                        value={draft.command}
                        onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                      />
                      <FieldDescription>{t('hostQuickActions.commandDescription')}</FieldDescription>
                      <FieldError>
                        {validationError === 'possibleSecret'
                          ? t('hostQuickActions.validation.possibleSecret')
                          : validationError === 'invalidCommand'
                            ? t('hostQuickActions.validation.invalidCommand')
                            : undefined}
                      </FieldError>
                    </Field>
                  )}

                  {draft.kind === 'connection' && (
                    <Field>
                      <FieldLabel htmlFor="host-quick-action-connection">
                        {t('hostQuickActions.connectionAction')}
                      </FieldLabel>
                      <Select
                        items={connectionActionItems}
                        value={draft.action}
                        onValueChange={(value) => {
                          if (value) {
                            setDraft({ ...draft, action: value as HostConnectionAction });
                          }
                        }}
                      >
                        <SelectTrigger
                          id="host-quick-action-connection"
                          className="w-full"
                          aria-label={t('hostQuickActions.connectionAction')}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {connectionActionItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </FieldGroup>
              </ScrollArea>

              <DrawerFooter className="shrink-0 flex-row justify-end gap-2 px-4 pb-4 pt-2">
                <Button variant="outline" size="sm" onClick={closeDrawer} disabled={saving}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={() => void saveDraft()} disabled={saving}>
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
        title={t('hostQuickActions.deleteTitle')}
        description={
          deleting
            ? t('hostQuickActions.deleteConfirm', { name: deleting.action.label })
            : ''
        }
        onConfirm={() => {
          if (deleting) void removeAction(deleting.profile, deleting.action.id);
        }}
      />
    </TooltipProvider>
  );
};
