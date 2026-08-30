import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  EyeIcon,
  EyeOffIcon,
  FolderOpenIcon,
  KeyRound,
  Network,
  PlugZapIcon,
  SaveIcon,
  Server,
  ShieldCheckIcon,
  TagsIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useKeychainStore } from '@/stores/keychainStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/drawer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FieldGroup } from '@/components/ui/field';
import { FormRow } from './shared';
import {
  invokeCancelConnectionPreflight,
  invokePickPrivateKeyFile,
  invokePreflightConnection,
  invokeReadTextFile,
  invokeTrustHost,
} from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import { createOperationId } from '@/lib/operation-id';
import type {
  AuthMethod,
  ConnectionPreflightRequest,
  ConnectionPreflightResult,
  ConnectionProfile,
  JumpHostConfig,
} from '@/types';
import { ConnectionPreflightDialog } from './connection-preflight-dialog';

const logger = createLogger('connectionForm');

interface JumpHostFormState extends JumpHostConfig {
  privateKeyPath: string;
}

export interface ConnectionFormDrawerProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>) => void | Promise<void>;
  onConnect: (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>) => void | Promise<void>;
  initial?: ConnectionProfile;
  /** Partial pre-fill values (e.g. host + port from a known-host entry). */
  initialValues?: Pick<FormState, 'host' | 'port'>;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keychainKeyId: string;
  privateKeyPath: string;
  passphrase: string;
  group: string;
  tags: string;
  favorite: boolean;
  notes: string;
  useJumpHost: boolean;
  jumpHost: JumpHostFormState;
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  keychainKeyId: '',
  privateKeyPath: '',
  passphrase: '',
  group: '',
  tags: '',
  favorite: false,
  notes: '',
  useJumpHost: false,
  jumpHost: {
    host: '',
    port: 22,
    username: '',
    authMethod: 'password',
    password: '',
    keychainKeyId: '',
    privateKeyPath: '',
    passphrase: '',
  },
};

function profileToForm(profile: ConnectionProfile): FormState {
  return {
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profile.authMethod,
    password: profile.password ?? '',
    keychainKeyId: profile.keychainKeyId ?? '',
    privateKeyPath: '',
    passphrase: profile.passphrase ?? '',
    group: profile.group ?? '',
    tags: (profile.tags ?? []).join(', '),
    favorite: Boolean(profile.favorite),
    notes: profile.notes ?? '',
    useJumpHost: !!profile.jumpHost,
    jumpHost: profile.jumpHost ? { ...profile.jumpHost, privateKeyPath: '' } : EMPTY_FORM.jumpHost,
  };
}

function keyLabelFromPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return 'Imported key';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || 'Imported key';
}

export const ConnectionFormDrawer: React.FC<ConnectionFormDrawerProps> = ({ open, onClose, onSubmit, onConnect, initial, initialValues }) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const { keys, initialized, hydrate, addKey } = useKeychainStore();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [preflightChecking, setPreflightChecking] = useState(false);
  const [preflightResult, setPreflightResult] = useState<ConnectionPreflightResult>();
  const [preflightError, setPreflightError] = useState<string>();
  const submissionInFlightRef = useRef(false);
  const preflightOperationIdRef = useRef<string | undefined>(undefined);
  const preflightRunRef = useRef(0);

  useEffect(() => {
    if (open) {
      if (initial) {
        setForm(profileToForm(initial));
      } else if (initialValues) {
        setForm({ ...EMPTY_FORM, ...initialValues });
      } else {
        setForm(EMPTY_FORM);
      }
      setErrors({});
      setPreflightOpen(false);
      setPreflightChecking(false);
      setPreflightResult(undefined);
      setPreflightError(undefined);
      preflightOperationIdRef.current = undefined;
      preflightRunRef.current += 1;
    }
  }, [initial, initialValues, open]);

  useEffect(() => {
    if (open && !initialized) {
      void hydrate();
    }
  }, [open, initialized, hydrate]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const updateJumpHost = <K extends keyof JumpHostFormState>(key: K, value: JumpHostFormState[K]): void => {
    setForm((prev) => ({
      ...prev,
      jumpHost: { ...prev.jumpHost, [key]: value },
    }));
  };

  const pickPrivateKey = async (target: 'main' | 'jump' = 'main'): Promise<void> => {
    const path = await invokePickPrivateKeyFile();
    if (!path) return;
    if (target === 'main') {
      setForm((prev) => ({
        ...prev,
        privateKeyPath: path,
      }));
    } else {
      setForm((prev) => ({
        ...prev,
        jumpHost: {
          ...prev.jumpHost,
          privateKeyPath: path,
        },
      }));
    }
  };

  const keyFileKeys = useMemo(() => keys.filter((k) => k.kind === 'keyFile'), [keys]);

  const validate = (): boolean => {
    const nextErrors: Record<string, string> = {};
    if (!form.name.trim()) {
      nextErrors.name = t('connection.form.validation.nameRequired');
    }
    if (!form.host.trim()) {
      nextErrors.host = t('connection.form.validation.hostRequired');
    }
    if (!form.port.trim() || Number.isNaN(Number(form.port))) {
      nextErrors.port = t('connection.form.validation.portRequired');
    }
    if (!form.username.trim()) {
      nextErrors.username = t('connection.form.validation.usernameRequired');
    }

    if (form.authMethod === 'password') {
      if (!form.password.trim()) {
        nextErrors.password = t('connection.form.validation.passwordRequired');
      }
    } else if (form.authMethod === 'key') {
      const hasSelectedKey = form.keychainKeyId.trim() && keyFileKeys.some((k) => k.id === form.keychainKeyId.trim());
      if (!hasSelectedKey && !form.privateKeyPath.trim()) {
        nextErrors.keychainKeyId = form.keychainKeyId.trim()
          ? t('connection.form.validation.keyNotFound')
          : t('connection.form.validation.keyRequired');
      }
    }

    if (form.useJumpHost) {
      if (!form.jumpHost.host.trim()) {
        nextErrors.jumpHostHost = t('connection.form.validation.jumpHostHostRequired');
      }
      if (!form.jumpHost.username.trim()) {
        nextErrors.jumpHostUsername = t('connection.form.validation.jumpHostUsernameRequired');
      }
      if (form.jumpHost.authMethod === 'password' && !form.jumpHost.password?.trim()) {
        nextErrors.jumpHostPassword = t('connection.form.validation.passwordRequired');
      }
      if (form.jumpHost.authMethod === 'key') {
        const hasJumpKey = form.jumpHost.keychainKeyId?.trim() && keyFileKeys.some((k) => k.id === form.jumpHost.keychainKeyId!.trim());
        if (!hasJumpKey && !form.jumpHost.privateKeyPath?.trim()) {
          nextErrors.jumpHostKeychainKeyId = form.jumpHost.keychainKeyId?.trim()
            ? t('connection.form.validation.keyNotFound')
            : t('connection.form.validation.keyRequired');
        }
      }
    }

    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0];
    if (firstError) {
      const controlIds: Record<string, string> = {
        name: 'connection-name',
        host: 'connection-host',
        port: 'connection-port',
        username: 'connection-username',
        password: 'connection-password',
        keychainKeyId: 'connection-keychain-key',
        jumpHostHost: 'jump-host',
        jumpHostUsername: 'jump-username',
        jumpHostPassword: 'jump-password',
        jumpHostKeychainKeyId: 'jump-keychain-key',
      };
      window.requestAnimationFrame(() => {
        document.getElementById(controlIds[firstError] ?? '')?.focus();
      });
    }
    return Object.keys(nextErrors).length === 0;
  };

  const resolveKeyFromPath = async (path: string, target: 'main' | 'jump'): Promise<string> => {
    const content = await invokeReadTextFile(path);
    const key = await addKey({
      label: keyLabelFromPath(path),
      kind: 'keyFile',
      privateKey: content,
    });
    // Link the imported key in the form so a retried submit reuses it
    // instead of importing a duplicate into the keychain.
    if (target === 'main') {
      setForm((prev) => ({ ...prev, privateKeyPath: '', keychainKeyId: key.id }));
    } else {
      setForm((prev) => ({
        ...prev,
        jumpHost: { ...prev.jumpHost, privateKeyPath: '', keychainKeyId: key.id },
      }));
    }
    return key.id;
  };

  const buildValues = async (): Promise<Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>> => {
    let keychainKeyId: string | undefined;
    if (form.authMethod === 'key') {
      if (form.privateKeyPath.trim()) {
        keychainKeyId = await resolveKeyFromPath(form.privateKeyPath.trim(), 'main');
      } else if (form.keychainKeyId.trim()) {
        const trimmedId = form.keychainKeyId.trim();
        if (keys.some((k) => k.kind === 'keyFile' && k.id === trimmedId)) {
          keychainKeyId = trimmedId;
        }
      }
    }

    let jumpHost: JumpHostConfig | undefined;
    if (form.useJumpHost) {
      let jumpKeychainKeyId: string | undefined;
      if (form.jumpHost.authMethod === 'key') {
        if (form.jumpHost.privateKeyPath?.trim()) {
          jumpKeychainKeyId = await resolveKeyFromPath(form.jumpHost.privateKeyPath.trim(), 'jump');
        } else if (form.jumpHost.keychainKeyId?.trim()) {
          const trimmedJumpId = form.jumpHost.keychainKeyId.trim();
          if (keys.some((k) => k.kind === 'keyFile' && k.id === trimmedJumpId)) {
            jumpKeychainKeyId = trimmedJumpId;
          }
        }
      }
      const { privateKeyPath: _jumpPrivateKeyPath, ...jumpHostRest } = form.jumpHost;
      jumpHost = {
        ...jumpHostRest,
        password: form.jumpHost.authMethod === 'password' ? form.jumpHost.password?.trim() || undefined : undefined,
        keychainKeyId: form.jumpHost.authMethod === 'key' ? jumpKeychainKeyId : undefined,
        passphrase: form.jumpHost.authMethod === 'key' ? form.jumpHost.passphrase?.trim() || undefined : undefined,
      };
    }

    return {
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      authMethod: form.authMethod,
      password: form.authMethod === 'password' ? form.password.trim() || undefined : undefined,
      keychainKeyId,
      passphrase: form.authMethod === 'key' ? form.passphrase.trim() || undefined : undefined,
      jumpHost,
      group: form.group.trim() || undefined,
      tags: [...new Set(form.tags.split(',').map((tag) => tag.trim()).filter(Boolean))],
      favorite: form.favorite,
      notes: form.notes.trim() || undefined,
    };
  };

  const buildPreflightRequest = async (operationId: string): Promise<ConnectionPreflightRequest> => {
    const privateKeyData = form.authMethod === 'key' && form.privateKeyPath.trim()
      ? await invokeReadTextFile(form.privateKeyPath.trim())
      : undefined;
    let jumpHost: JumpHostConfig | undefined;
    if (form.useJumpHost) {
      const jumpPrivateKeyData = form.jumpHost.authMethod === 'key' && form.jumpHost.privateKeyPath.trim()
        ? await invokeReadTextFile(form.jumpHost.privateKeyPath.trim())
        : undefined;
      jumpHost = {
        host: form.jumpHost.host.trim(),
        port: form.jumpHost.port,
        username: form.jumpHost.username.trim(),
        authMethod: form.jumpHost.authMethod,
        password: form.jumpHost.authMethod === 'password' ? form.jumpHost.password?.trim() || undefined : undefined,
        keychainKeyId: form.jumpHost.authMethod === 'key' && !jumpPrivateKeyData
          ? form.jumpHost.keychainKeyId?.trim() || undefined
          : undefined,
        privateKeyData: jumpPrivateKeyData,
        passphrase: form.jumpHost.authMethod === 'key' ? form.jumpHost.passphrase?.trim() || undefined : undefined,
      };
    }

    return {
      operationId,
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      authMethod: form.authMethod,
      password: form.authMethod === 'password' ? form.password.trim() || undefined : undefined,
      keychainKeyId: form.authMethod === 'key' && !privateKeyData
        ? form.keychainKeyId.trim() || undefined
        : undefined,
      privateKeyData,
      passphrase: form.authMethod === 'key' ? form.passphrase.trim() || undefined : undefined,
      jumpHost,
    };
  };

  const runPreflight = async (): Promise<void> => {
    if (preflightChecking || !validate()) return;
    const run = preflightRunRef.current + 1;
    preflightRunRef.current = run;
    const operationId = createOperationId('connection-preflight');
    preflightOperationIdRef.current = operationId;
    setPreflightOpen(true);
    setPreflightChecking(true);
    setPreflightResult(undefined);
    setPreflightError(undefined);
    try {
      const request = await buildPreflightRequest(operationId);
      const result = await invokePreflightConnection(request);
      if (preflightRunRef.current === run) setPreflightResult(result);
    } catch (error) {
      logger.error(`connection preflight failed operation_id=${operationId}`, error);
      if (preflightRunRef.current === run) {
        setPreflightError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (preflightRunRef.current === run) {
        setPreflightChecking(false);
        preflightOperationIdRef.current = undefined;
      }
    }
  };

  const cancelPreflight = (): void => {
    const operationId = preflightOperationIdRef.current;
    if (operationId) {
      void invokeCancelConnectionPreflight(operationId).catch((error) => {
        logger.error(`failed to cancel connection preflight operation_id=${operationId}`, error);
      });
    }
  };

  const closePreflight = (): void => {
    cancelPreflight();
    preflightRunRef.current += 1;
    preflightOperationIdRef.current = undefined;
    setPreflightChecking(false);
    setPreflightOpen(false);
  };

  const trustPreflightHost = async (
    host: string,
    port: number,
    fingerprint?: string,
  ): Promise<void> => {
    try {
      await invokeTrustHost(host, port, fingerprint ?? '');
      void runPreflight();
    } catch (error) {
      logger.error(`failed to trust preflight host host=${host} port=${port}`, error);
      setPreflightError(error instanceof Error ? error.message : String(error));
    }
  };

  const submit = async (action: ConnectionFormDrawerProps['onSubmit']): Promise<void> => {
    if (submissionInFlightRef.current || !validate()) return;

    submissionInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const values = await buildValues();
      await action(values);
      onClose();
    } catch (error) {
      logger.error('failed to submit connection form', error);
      showError(t('connection.form.submitFailed'));
    } finally {
      submissionInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSaveOnly = (): void => {
    void submit(onSubmit);
  };

  const handleConnect = (): void => {
    void submit(onConnect);
  };

  const handleHostBlur = (): void => {
    if (!initial && !form.name.trim() && form.host.trim()) {
      updateField('name', form.host.trim());
    }
  };

  const handleAuthMethodChange = (value: AuthMethod, target: 'main' | 'jump' = 'main'): void => {
    if (target === 'main') {
      setForm((prev) => ({
        ...prev,
        authMethod: value,
      }));
    } else {
      setForm((prev) => ({
        ...prev,
        jumpHost: {
          ...prev.jumpHost,
          authMethod: value,
        },
      }));
    }
  };

  return (
    <>
    <Drawer
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent className="w-100 gap-0 p-0">
        <DrawerHeader className="border-b border-app-border px-4 py-4">
          <DrawerTitle>{initial ? t('connection.form.title.edit') : t('connection.form.title.new')}</DrawerTitle>
          <p className="text-xs text-muted-foreground">{t('connection.form.subtitle')}</p>
        </DrawerHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 px-4 py-4">
            <FormSection icon={Server} title={t('connection.form.section.general')}>
              <FormRow controlId="connection-name" label={t('common.name')} error={errors.name}>
                <Input id="connection-name" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'connection-name-error' : undefined} value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="My Server" autoComplete="off" autoCapitalize="none" />
              </FormRow>
              <div className="grid grid-cols-3 gap-2">
                <FormRow controlId="connection-host" className="col-span-2" label={t('common.host')} error={errors.host}>
                  <Input id="connection-host" aria-invalid={Boolean(errors.host)} aria-describedby={errors.host ? 'connection-host-error' : undefined} value={form.host} onChange={(e) => updateField('host', e.target.value)} onBlur={handleHostBlur} placeholder="192.168.1.1" autoComplete="off" autoCapitalize="none" />
                </FormRow>
                <FormRow controlId="connection-port" label={t('common.port')} error={errors.port}>
                  <Input id="connection-port" aria-invalid={Boolean(errors.port)} aria-describedby={errors.port ? 'connection-port-error' : undefined} value={form.port} onChange={(e) => updateField('port', e.target.value)} type="number" placeholder="22" autoComplete="off" autoCapitalize="none" />
                </FormRow>
              </div>
              <FormRow controlId="connection-username" label={t('common.username')} error={errors.username}>
                <Input id="connection-username" aria-invalid={Boolean(errors.username)} aria-describedby={errors.username ? 'connection-username-error' : undefined} value={form.username} onChange={(e) => updateField('username', e.target.value)} placeholder="root" autoComplete="off" autoCapitalize="none" />
              </FormRow>
            </FormSection>

            <FormSection icon={KeyRound} title={t('connection.form.section.auth')}>
              <AuthMethodToggle value={form.authMethod} onChange={(value) => handleAuthMethodChange(value, 'main')} />
              {form.authMethod === 'password' && (
                <FormRow controlId="connection-password" label={t('common.password')} error={errors.password}>
                  <PasswordInput id="connection-password" ariaInvalid={Boolean(errors.password)} describedBy={errors.password ? 'connection-password-error' : undefined} value={form.password} onChange={(value) => updateField('password', value)} placeholder={t('common.password')} />
                </FormRow>
              )}
              {form.authMethod === 'key' && (
                <>
                  <KeyAuthInput
                    idPrefix="connection"
                    keychainKeyId={form.keychainKeyId}
                    privateKeyPath={form.privateKeyPath}
                    keys={keyFileKeys}
                    errors={{
                      keychainKeyId: errors.keychainKeyId,
                      privateKeyPath: errors.privateKeyPath,
                    }}
                    onKeychainKeyIdChange={(value) => setForm((prev) => ({ ...prev, keychainKeyId: value }))}
                    onPrivateKeyPathChange={(value) => setForm((prev) => ({ ...prev, privateKeyPath: value }))}
                    onBrowse={() => pickPrivateKey('main')}
                  />
                  <FormRow controlId="connection-passphrase" label={t('common.passphrase')}>
                    <PasswordInput id="connection-passphrase" value={form.passphrase} onChange={(value) => updateField('passphrase', value)} placeholder={t('common.passphrase')} />
                  </FormRow>
                </>
              )}
            </FormSection>

            <FormSection icon={TagsIcon} title={t('connection.form.section.organization')}>
              <div className="grid grid-cols-2 gap-2">
                <FormRow controlId="connection-group" label={t('connection.form.group')}>
                  <Input
                    id="connection-group"
                    value={form.group}
                    onChange={(event) => updateField('group', event.target.value)}
                    placeholder={t('connection.form.groupPlaceholder')}
                    autoComplete="off"
                  />
                </FormRow>
                <FormRow controlId="connection-tags" label={t('connection.form.tags')}>
                  <Input
                    id="connection-tags"
                    value={form.tags}
                    onChange={(event) => updateField('tags', event.target.value)}
                    placeholder={t('connection.form.tagsPlaceholder')}
                    autoComplete="off"
                  />
                </FormRow>
              </div>
              <FormRow controlId="connection-notes" label={t('connection.form.notes')}>
                <Textarea
                  id="connection-notes"
                  value={form.notes}
                  onChange={(event) => updateField('notes', event.target.value)}
                  placeholder={t('connection.form.notesPlaceholder')}
                  className="min-h-20 resize-y"
                />
              </FormRow>
              <div className="flex items-center justify-between rounded-lg border border-app-border px-3.5 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-app-text">{t('connection.form.favorite')}</span>
                  <span className="text-xs text-muted-foreground">{t('connection.form.favoriteHint')}</span>
                </div>
                <Switch
                  id="connection-favorite"
                  checked={form.favorite}
                  onCheckedChange={(checked) => updateField('favorite', checked)}
                  aria-label={t('connection.form.favorite')}
                />
              </div>
            </FormSection>

            <FormSection icon={Network} title={t('connection.form.jumpHost')}>
              <div className={cn('flex flex-col rounded-lg border border-app-border transition-colors', form.useJumpHost && 'bg-muted/50')}>
                <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-app-text">{t('connection.form.useJumpHost')}</span>
                    <span className="text-xs text-muted-foreground">{t('connection.form.jumpHostHint')}</span>
                  </div>
                  <Switch id="use-jump-host" aria-label={t('connection.form.useJumpHost')} checked={form.useJumpHost} onCheckedChange={(checked) => updateField('useJumpHost', checked)} />
                </div>
                {form.useJumpHost && (
                  <div className="flex flex-col gap-2.5 border-t border-app-border px-3.5 py-3">
                    <div className="grid grid-cols-3 gap-3">
                      <FormRow controlId="jump-host" className="col-span-2" label={t('common.host')} error={errors.jumpHostHost}>
                        <Input id="jump-host" aria-invalid={Boolean(errors.jumpHostHost)} aria-describedby={errors.jumpHostHost ? 'jump-host-error' : undefined} value={form.jumpHost.host} onChange={(e) => updateJumpHost('host', e.target.value)} placeholder="192.168.1.1" autoComplete="off" autoCapitalize="none" />
                      </FormRow>
                      <FormRow controlId="jump-port" label={t('common.port')}>
                        <Input id="jump-port" value={form.jumpHost.port} onChange={(e) => updateJumpHost('port', Number(e.target.value))} type="number" placeholder="22" autoComplete="off" autoCapitalize="none" />
                      </FormRow>
                    </div>
                    <FormRow controlId="jump-username" label={t('common.username')} error={errors.jumpHostUsername}>
                      <Input id="jump-username" aria-invalid={Boolean(errors.jumpHostUsername)} aria-describedby={errors.jumpHostUsername ? 'jump-username-error' : undefined} value={form.jumpHost.username} onChange={(e) => updateJumpHost('username', e.target.value)} placeholder="root" autoComplete="off" autoCapitalize="none" />
                    </FormRow>
                    <AuthMethodToggle value={form.jumpHost.authMethod} onChange={(value) => handleAuthMethodChange(value, 'jump')} />
                    {form.jumpHost.authMethod === 'password' && (
                      <FormRow controlId="jump-password" label={t('common.password')} error={errors.jumpHostPassword}>
                        <PasswordInput id="jump-password" ariaInvalid={Boolean(errors.jumpHostPassword)} describedBy={errors.jumpHostPassword ? 'jump-password-error' : undefined} value={form.jumpHost.password ?? ''} onChange={(value) => updateJumpHost('password', value)} placeholder={t('common.password')} />
                      </FormRow>
                    )}
                    {form.jumpHost.authMethod === 'key' && (
                      <>
                        <KeyAuthInput
                          idPrefix="jump"
                          keychainKeyId={form.jumpHost.keychainKeyId ?? ''}
                          privateKeyPath={form.jumpHost.privateKeyPath ?? ''}
                          keys={keyFileKeys}
                          errors={{
                            keychainKeyId: errors.jumpHostKeychainKeyId,
                            privateKeyPath: errors.jumpHostPrivateKeyPath,
                          }}
                          onKeychainKeyIdChange={(value) => updateJumpHost('keychainKeyId', value)}
                          onPrivateKeyPathChange={(value) => updateJumpHost('privateKeyPath', value)}
                          onBrowse={() => pickPrivateKey('jump')}
                        />
                        <FormRow controlId="jump-passphrase" label={t('common.passphrase')}>
                          <PasswordInput
                            id="jump-passphrase"
                            value={form.jumpHost.passphrase ?? ''}
                            onChange={(value) => updateJumpHost('passphrase', value)}
                            placeholder={t('common.passphrase')}
                          />
                        </FormRow>
                      </>
                    )}
                  </div>
                )}
              </div>
            </FormSection>
          </div>
        </ScrollArea>

        <DrawerFooter className="grid grid-cols-3 gap-2 px-4 py-4">
          <Button variant="outline" size="sm" onClick={() => void runPreflight()} disabled={isSubmitting || preflightChecking}>
            <ShieldCheckIcon data-icon="inline-start" />
            {t('connection.preflight.action')}
          </Button>
          {initial ? (
            <>
              <Button variant="outline" size="sm" onClick={handleConnect} disabled={isSubmitting}>
                <PlugZapIcon data-icon="inline-start" />
                {t('connection.form.saveAndConnect')}
              </Button>
              <Button size="sm" onClick={handleSaveOnly} disabled={isSubmitting}>
                <SaveIcon data-icon="inline-start" />
                {t('common.save')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleSaveOnly} disabled={isSubmitting}>
                <SaveIcon data-icon="inline-start" />
                {t('common.save')}
              </Button>
              <Button size="sm" onClick={handleConnect} disabled={isSubmitting}>
                <PlugZapIcon data-icon="inline-start" />
                {t('connection.form.saveAndConnect')}
              </Button>
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
      <ConnectionPreflightDialog
        open={preflightOpen}
        checking={preflightChecking}
        result={preflightResult}
        error={preflightError}
        onClose={closePreflight}
        onCancel={cancelPreflight}
        onRetry={() => void runPreflight()}
        onTrust={(host, port, fingerprint) =>
          void trustPreflightHost(host, port, fingerprint)
        }
      />
    </>
  );
};

interface PasswordInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaInvalid?: boolean;
  describedBy?: string;
}

const PasswordInput: React.FC<PasswordInputProps> = ({
  id,
  value,
  onChange,
  placeholder,
  ariaInvalid,
  describedBy,
}) => {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex w-full">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        autoCapitalize="none"
        aria-invalid={ariaInvalid}
        aria-describedby={describedBy}
        className="rounded-r-none"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0 rounded-l-none border-l-0"
        aria-label={visible ? t('common.hidePassword') : t('common.showPassword')}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
};

interface FormSectionProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}

const FormSection: React.FC<FormSectionProps> = ({ icon: Icon, title, children }) => {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
      </div>
      <FieldGroup className="gap-2.5">{children}</FieldGroup>
    </section>
  );
};

interface AuthMethodToggleProps {
  value: AuthMethod;
  onChange: (value: AuthMethod) => void;
}

const AuthMethodToggle: React.FC<AuthMethodToggleProps> = ({ value, onChange }) => {
  const { t } = useI18n();
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        const selected = next[0] as AuthMethod | undefined;
        if (selected) onChange(selected);
      }}
      className="w-full"
      variant="segmented"
      aria-label={t('common.authMethod')}
    >
      <ToggleGroupItem value="password" className="flex-1">
        {t('connection.form.auth.password')}
      </ToggleGroupItem>
      <ToggleGroupItem value="key" className="flex-1">
        {t('connection.form.auth.key')}
      </ToggleGroupItem>
    </ToggleGroup>
  );
};

interface KeyAuthInputProps {
  idPrefix: 'connection' | 'jump';
  keychainKeyId: string;
  privateKeyPath: string;
  keys: { id: string; label: string }[];
  errors: {
    keychainKeyId?: string;
    privateKeyPath?: string;
  };
  onKeychainKeyIdChange: (value: string) => void;
  onPrivateKeyPathChange: (value: string) => void;
  onBrowse: () => void;
}

const KeyAuthInput: React.FC<KeyAuthInputProps> = ({
  idPrefix,
  keychainKeyId,
  privateKeyPath,
  keys,
  errors,
  onKeychainKeyIdChange,
  onPrivateKeyPathChange,
  onBrowse,
}) => {
  const { t } = useI18n();
  const isKeyMissing = keychainKeyId !== '' && !keys.some((k) => k.id === keychainKeyId);
  const displayError = isKeyMissing ? t('connection.form.validation.keyNotFound') : errors.keychainKeyId;
  const keyControlId = `${idPrefix}-keychain-key`;
  const pathControlId = `${idPrefix}-private-key`;

  return (
    <div className="flex flex-col gap-2.5">
      <FormRow controlId={keyControlId} label={t('common.keychainKey')} error={displayError}>
        {keys.length === 0 && !isKeyMissing ? (
          <div className="flex items-center justify-between rounded-lg border border-dashed border-app-border px-3 py-2 text-sm text-muted-foreground">
            <span>{t('connection.form.noKeychainKeys')}</span>
          </div>
        ) : (
          <Select value={(!isKeyMissing && keychainKeyId) || undefined} onValueChange={(next) => onKeychainKeyIdChange(next ?? '')}>
            <SelectTrigger id={keyControlId} aria-invalid={Boolean(displayError)} aria-describedby={displayError ? `${keyControlId}-error` : undefined}>
              <SelectValue placeholder={isKeyMissing ? t('connection.form.validation.keyNotFound') : t('connection.form.selectKeychainKey')}>
                {(!isKeyMissing && keys.find((key) => key.id === keychainKeyId)?.label) || undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {keys.map((key) => (
                  <SelectItem key={key.id} value={key.id}>
                    {key.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </FormRow>

      <FormRow controlId={pathControlId} label={t('common.privateKey')} error={errors.privateKeyPath}>
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Input id={pathControlId} aria-invalid={Boolean(errors.privateKeyPath)} aria-describedby={errors.privateKeyPath ? `${pathControlId}-error` : undefined} value={privateKeyPath} onChange={(e) => onPrivateKeyPathChange(e.target.value)} placeholder="/path/to/key" className="flex-1" autoComplete="off" autoCapitalize="none" />
            <Button variant="outline" size="sm" className="shrink-0" onClick={onBrowse}>
              <FolderOpenIcon data-icon="inline-start" />
              {t('connection.form.browse')}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground/70">{t('connection.form.privateKeyHint')}</span>
        </div>
      </FormRow>
    </div>
  );
};
