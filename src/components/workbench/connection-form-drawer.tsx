import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, ChevronDown, KeyRound, Network, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useKeychainStore } from '@/stores/keychainStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/drawer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FormRow } from './shared';
import { invokePickPrivateKeyFile, invokeReadTextFile } from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import type { AuthMethod, ConnectionProfile, JumpHostConfig } from '@/types';

const logger = createLogger('connectionForm');

interface JumpHostFormState extends JumpHostConfig {
  privateKeyPath: string;
}

export interface ConnectionFormDrawerProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>) => void | Promise<void>;
  onConnect?: (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>) => void | Promise<void>;
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
  const submissionInFlightRef = useRef(false);

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
    };
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
    void submit(onConnect ?? onSubmit);
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
    <Drawer
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent className="w-100 gap-0 p-0">
        <DrawerHeader className="border-b border-app-border px-5 py-4">
          <DrawerTitle>{initial ? t('connection.form.title.edit') : t('connection.form.title.new')}</DrawerTitle>
          <p className="text-xs text-muted-foreground">{t('connection.form.subtitle')}</p>
        </DrawerHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 px-5 py-4">
            <FormSection icon={Server} title={t('connection.form.section.general')}>
              <FormRow label={t('common.name')} error={errors.name}>
                <Input value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="My Server" autoComplete="off" autoCapitalize="none" />
              </FormRow>
              <div className="grid grid-cols-3 gap-2">
                <FormRow className="col-span-2" label={t('common.host')} error={errors.host}>
                  <Input value={form.host} onChange={(e) => updateField('host', e.target.value)} onBlur={handleHostBlur} placeholder="192.168.1.1" autoComplete="off" autoCapitalize="none" />
                </FormRow>
                <FormRow label={t('common.port')} error={errors.port}>
                  <Input value={form.port} onChange={(e) => updateField('port', e.target.value)} type="number" placeholder="22" autoComplete="off" autoCapitalize="none" />
                </FormRow>
              </div>
              <FormRow label={t('common.username')} error={errors.username}>
                <Input value={form.username} onChange={(e) => updateField('username', e.target.value)} placeholder="root" autoComplete="off" autoCapitalize="none" />
              </FormRow>
            </FormSection>

            <FormSection icon={KeyRound} title={t('connection.form.section.auth')}>
              <AuthMethodToggle value={form.authMethod} onChange={(value) => handleAuthMethodChange(value, 'main')} />
              {form.authMethod === 'password' && (
                <FormRow label={t('common.password')} error={errors.password}>
                  <Input type="password" value={form.password} onChange={(e) => updateField('password', e.target.value)} placeholder={t('common.password')} autoComplete="off" autoCapitalize="none" />
                </FormRow>
              )}
              {form.authMethod === 'key' && (
                <>
                  <KeyAuthInput
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
                  <FormRow label={t('common.passphrase')}>
                    <Input type="password" value={form.passphrase} onChange={(e) => updateField('passphrase', e.target.value)} placeholder={t('common.passphrase')} autoComplete="off" autoCapitalize="none" />
                  </FormRow>
                </>
              )}
            </FormSection>

            <FormSection icon={Network} title={t('connection.form.jumpHost')}>
              <div className={cn('flex flex-col rounded-lg border border-app-border transition-colors', form.useJumpHost && 'bg-muted/50')}>
                <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-app-text">{t('connection.form.useJumpHost')}</span>
                    <span className="text-xs text-muted-foreground">{t('connection.form.jumpHostHint')}</span>
                  </div>
                  <Switch checked={form.useJumpHost} onCheckedChange={(checked) => updateField('useJumpHost', checked)} />
                </div>
                {form.useJumpHost && (
                  <div className="flex flex-col gap-2.5 border-t border-app-border px-3.5 py-3">
                    <div className="grid grid-cols-3 gap-3">
                      <FormRow className="col-span-2" label={t('common.host')} error={errors.jumpHostHost}>
                        <Input value={form.jumpHost.host} onChange={(e) => updateJumpHost('host', e.target.value)} placeholder="192.168.1.1" autoComplete="off" autoCapitalize="none" />
                      </FormRow>
                      <FormRow label={t('common.port')}>
                        <Input value={form.jumpHost.port} onChange={(e) => updateJumpHost('port', Number(e.target.value))} type="number" placeholder="22" autoComplete="off" autoCapitalize="none" />
                      </FormRow>
                    </div>
                    <FormRow label={t('common.username')} error={errors.jumpHostUsername}>
                      <Input value={form.jumpHost.username} onChange={(e) => updateJumpHost('username', e.target.value)} placeholder="root" autoComplete="off" autoCapitalize="none" />
                    </FormRow>
                    <AuthMethodToggle value={form.jumpHost.authMethod} onChange={(value) => handleAuthMethodChange(value, 'jump')} />
                    {form.jumpHost.authMethod === 'password' && (
                      <FormRow label={t('common.password')} error={errors.jumpHostPassword}>
                        <Input type="password" value={form.jumpHost.password ?? ''} onChange={(e) => updateJumpHost('password', e.target.value)} placeholder={t('common.password')} autoComplete="off" autoCapitalize="none" />
                      </FormRow>
                    )}
                    {form.jumpHost.authMethod === 'key' && (
                      <>
                        <KeyAuthInput
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
                        <FormRow label={t('common.passphrase')}>
                          <Input
                            type="password"
                            value={form.jumpHost.passphrase ?? ''}
                            onChange={(e) => updateJumpHost('passphrase', e.target.value)}
                            placeholder={t('common.passphrase')}
                            autoComplete="off"
                            autoCapitalize="none"
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

        <DrawerFooter className="border-t-0 px-5 pb-4 pt-1">
          <div className="flex w-full">
            <Button variant="default" className="flex-1 rounded-r-none" onClick={handleConnect} disabled={isSubmitting}>
              {t('common.connect')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="default"
                    className="rounded-l-none border-l border-primary-foreground/20 px-2"
                    aria-label={t('connection.form.moreActions')}
                    disabled={isSubmitting}
                  />
                }
              >
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-40 rounded-md">
                <DropdownMenuItem onClick={handleSaveOnly} disabled={isSubmitting}>
                  {t('connection.form.saveOnly')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
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
      {children}
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

  return (
    <div className="flex flex-col gap-2.5">
      <FormRow label={t('common.keychainKey')} error={displayError}>
        {keys.length === 0 && !isKeyMissing ? (
          <div className="flex items-center justify-between rounded-lg border border-dashed border-app-border px-3 py-2 text-sm text-muted-foreground">
            <span>{t('connection.form.noKeychainKeys')}</span>
          </div>
        ) : (
          <Select value={(!isKeyMissing && keychainKeyId) || undefined} onValueChange={(next) => onKeychainKeyIdChange(next ?? '')}>
            <SelectTrigger>
              <SelectValue placeholder={isKeyMissing ? t('connection.form.validation.keyNotFound') : t('connection.form.selectKeychainKey')}>
                {(!isKeyMissing && keys.find((key) => key.id === keychainKeyId)?.label) || undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {keys.map((key) => (
                <SelectItem key={key.id} value={key.id}>
                  {key.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormRow>

      <FormRow label={t('common.privateKey')} error={errors.privateKeyPath}>
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Input value={privateKeyPath} onChange={(e) => onPrivateKeyPathChange(e.target.value)} placeholder="/path/to/key" className="flex-1" autoComplete="off" autoCapitalize="none" />
            <Button variant="outline" className="shrink-0" onClick={onBrowse}>
              <FolderOpen />
              {t('connection.form.browse')}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground/70">{t('connection.form.privateKeyHint')}</span>
        </div>
      </FormRow>
    </div>
  );
};