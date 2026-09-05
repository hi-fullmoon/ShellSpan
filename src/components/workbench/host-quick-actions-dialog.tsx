import React, { useEffect, useMemo, useState } from 'react';
import {
  CableIcon,
  FolderIcon,
  InfoIcon,
  PencilIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import {
  findConnectedTerminalSession,
  insertHostCommandSnippet,
  openHostPath,
  runHostConnectionAction,
  validateHostQuickAction,
  type HostQuickActionValidationError,
} from '@/lib/host/host-quick-actions';
import { generateId } from '@/lib/utils';
import { useProfileStore } from '@/stores/profileStore';
import type {
  ConnectionProfile,
  HostConnectionAction,
  HostQuickAction,
} from '@/types';

interface HostQuickActionsDialogProps {
  profile?: ConnectionProfile;
  onClose: () => void;
}

interface QuickActionDraft {
  id?: string;
  kind: HostQuickAction['kind'];
  label: string;
  path: string;
  target: 'terminal' | 'sftp';
  command: string;
  action: HostConnectionAction;
}

const EMPTY_DRAFT: QuickActionDraft = {
  kind: 'directory',
  label: '',
  path: '',
  target: 'terminal',
  command: '',
  action: 'terminal',
};

function toDraft(action?: HostQuickAction): QuickActionDraft {
  if (!action) return { ...EMPTY_DRAFT };
  if (action.kind === 'directory') {
    return { ...EMPTY_DRAFT, ...action };
  }
  if (action.kind === 'command') {
    return { ...EMPTY_DRAFT, ...action };
  }
  return { ...EMPTY_DRAFT, ...action };
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

export function HostQuickActionsDialog({
  profile,
  onClose,
}: HostQuickActionsDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const { error: showError, info, success } = useToast();
  const updateProfile = useProfileStore((state) => state.updateProfile);
  const currentProfile = useProfileStore((state) => (
    profile ? state.profiles.find((candidate) => candidate.id === profile.id) : undefined
  ));
  const [draft, setDraft] = useState<QuickActionDraft>();
  const [validationError, setValidationError] = useState<HostQuickActionValidationError>();
  const [saving, setSaving] = useState(false);
  const actions = currentProfile?.quickActions ?? [];
  const hasConnectedTarget = Boolean(
    currentProfile && findConnectedTerminalSession(currentProfile.id),
  );

  useEffect(() => {
    setDraft(undefined);
    setValidationError(undefined);
  }, [profile?.id]);

  const actionDescriptions = useMemo(() => ({
    terminal: t('hostQuickActions.connection.terminal'),
    sftp: t('hostQuickActions.connection.sftp'),
    portForward: t('hostQuickActions.connection.portForward'),
    overview: t('hostQuickActions.connection.overview'),
  }), [t]);

  const persistActions = async (nextActions: HostQuickAction[]): Promise<void> => {
    if (!currentProfile) return;
    setSaving(true);
    try {
      await updateProfile(currentProfile.id, { quickActions: nextActions });
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
    const action = toAction(draft);
    const error = validateHostQuickAction(action);
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(undefined);
    const nextActions = draft.id
      ? actions.map((item) => item.id === draft.id ? action : item)
      : [...actions, action];
    try {
      await persistActions(nextActions);
      setDraft(undefined);
    } catch {
      // The toast above is the user-facing recovery path; keep the draft open.
    }
  };

  const removeAction = async (actionId: string): Promise<void> => {
    try {
      await persistActions(actions.filter((action) => action.id !== actionId));
      if (draft?.id === actionId) setDraft(undefined);
    } catch {
      // Preserve the current list on persistence failure.
    }
  };

  const runAction = async (action: HostQuickAction): Promise<void> => {
    if (!currentProfile) return;
    if (action.kind === 'directory') {
      openHostPath(currentProfile, action.path, action.target);
      onClose();
      return;
    }
    if (action.kind === 'connection') {
      runHostConnectionAction(currentProfile.id, action.action);
      onClose();
      return;
    }
    try {
      const result = await insertHostCommandSnippet(currentProfile.id, action.command);
      if (result === 'inserted') {
        info(t('hostQuickActions.inserted'));
        onClose();
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
    <Dialog open={Boolean(profile)} onOpenChange={(open) => !open && onClose()}>
      <CompactDialogContent className="h-[min(720px,calc(100vh-2rem))] max-w-3xl">
        <CompactDialogHeader
          title={t('hostQuickActions.title')}
          description={currentProfile
            ? t('hostQuickActions.description', { name: currentProfile.name })
            : t('hostQuickActions.descriptionEmpty')}
        />

        <ScrollArea className="min-h-0 flex-1">
          <ScrollAreaContent className="flex min-w-0 flex-col gap-3 px-4 py-3">
          <Alert>
            <WrenchIcon />
            <AlertTitle>{t('hostQuickActions.safetyTitle')}</AlertTitle>
            <AlertDescription>{t('hostQuickActions.safetyDescription')}</AlertDescription>
          </Alert>

          {draft && (
          <Card size="sm" className="shrink-0">
            <CardHeader>
              <CardTitle>
                {draft.id ? t('hostQuickActions.edit') : t('hostQuickActions.create')}
              </CardTitle>
              <CardDescription>{t('hostQuickActions.formDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field data-invalid={validationError === 'invalidLabel' || undefined}>
                  <FieldLabel htmlFor="host-quick-action-label">{t('hostQuickActions.label')}</FieldLabel>
                  <Input
                    id="host-quick-action-label"
                    autoFocus
                    aria-invalid={validationError === 'invalidLabel' || undefined}
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
                  >
                    <ToggleGroupItem value="directory">{t('hostQuickActions.kind.directory')}</ToggleGroupItem>
                    <ToggleGroupItem value="command">{t('hostQuickActions.kind.command')}</ToggleGroupItem>
                    <ToggleGroupItem value="connection">{t('hostQuickActions.kind.connection')}</ToggleGroupItem>
                  </ToggleGroup>
                </Field>

                {draft.kind === 'directory' && (
                  <>
                    <Field data-invalid={validationError === 'invalidPath' || undefined}>
                      <FieldLabel htmlFor="host-quick-action-path">{t('hostQuickActions.path')}</FieldLabel>
                      <Input
                        id="host-quick-action-path"
                        aria-invalid={validationError === 'invalidPath' || undefined}
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
                      >
                        <ToggleGroupItem value="terminal">{t('hostQuickActions.target.terminal')}</ToggleGroupItem>
                        <ToggleGroupItem value="sftp">{t('hostQuickActions.target.sftp')}</ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                  </>
                )}

                {draft.kind === 'command' && (
                  <Field
                    data-invalid={validationError === 'invalidCommand' || validationError === 'possibleSecret' || undefined}
                  >
                    <FieldLabel htmlFor="host-quick-action-command">{t('hostQuickActions.command')}</FieldLabel>
                    <Input
                      id="host-quick-action-command"
                      aria-invalid={validationError === 'invalidCommand' || validationError === 'possibleSecret' || undefined}
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
                    <FieldLabel>{t('hostQuickActions.connectionAction')}</FieldLabel>
                    <Select
                      value={draft.action}
                      onValueChange={(value) => setDraft({
                        ...draft,
                        action: value as HostConnectionAction,
                      })}
                    >
                      <SelectTrigger aria-label={t('hostQuickActions.connectionAction')}>
                        <SelectValue>{actionDescriptions[draft.action]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(Object.keys(actionDescriptions) as HostConnectionAction[]).map((action) => (
                            <SelectItem key={action} value={action}>{actionDescriptions[action]}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </FieldGroup>
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(undefined)} disabled={saving}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => void saveDraft()} disabled={saving}>
                {t('common.save')}
              </Button>
            </CardFooter>
          </Card>
          )}

          <div className="flex flex-col gap-2">
            {actions.length === 0 ? (
              <EmptyState
                className="min-h-40"
                title={t('hostQuickActions.empty')}
                description={t('hostQuickActions.emptyDescription')}
                icon={<WrenchIcon className="size-5" />}
              />
            ) : actions.map((action) => {
              const Icon = actionIcon(action);
              const commandDisabled = action.kind === 'command' && !hasConnectedTarget;
              const detail = action.kind === 'directory'
                ? `${action.target === 'terminal' ? t('hostQuickActions.target.terminal') : t('hostQuickActions.target.sftp')} · ${action.path}`
                : action.kind === 'command'
                  ? action.command
                  : actionDescriptions[action.action];
              return (
                <Card key={action.id} size="sm">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" />
                      <span className="truncate">{action.label}</span>
                    </CardTitle>
                    <CardDescription className="truncate" title={detail}>{detail}</CardDescription>
                    <CardAction className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        aria-label={t('common.edit')}
                        onClick={() => setDraft(toDraft(action))}
                      >
                        <PencilIcon data-icon="inline-start" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        aria-label={t('common.delete')}
                        onClick={() => void removeAction(action.id)}
                        disabled={saving}
                      >
                        <Trash2Icon data-icon="inline-start" />
                      </Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void runAction(action)}
                      disabled={commandDisabled}
                      title={commandDisabled ? t('hostQuickActions.noTerminal') : undefined}
                    >
                      {action.kind === 'command'
                        ? t('hostQuickActions.insert')
                        : t('hostQuickActions.run')}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          </ScrollAreaContent>
        </ScrollArea>

        <CompactDialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({ ...EMPTY_DRAFT });
              setValidationError(undefined);
            }}
            disabled={Boolean(draft) || actions.length >= 24}
          >
            {t('hostQuickActions.create')}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
}
