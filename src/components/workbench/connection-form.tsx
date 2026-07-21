import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, ChevronDown, KeyRound, Network, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/drawer';
import { Label } from '@/components/ui/label';
import { invokePickPrivateKeyFile } from '@/lib/tauri';
import type {
  AuthMethod,
  ConnectionProfile,
  JumpHostConfig,
} from '@/types';

export interface ConnectionFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>,
  ) => void | Promise<void>;
  onConnect?: (
    profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>,
  ) => void | Promise<void>;
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
  privateKeyPath: string;
  passphrase: string;
  useJumpHost: boolean;
  jumpHost: JumpHostConfig;
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  useJumpHost: false,
  jumpHost: {
    host: '',
    port: 22,
    username: '',
    authMethod: 'password',
    password: '',
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
    privateKeyPath: profile.privateKeyPath ?? '',
    passphrase: profile.passphrase ?? '',
    useJumpHost: !!profile.jumpHost,
    jumpHost: profile.jumpHost ?? EMPTY_FORM.jumpHost,
  };
}

export const ConnectionForm: React.FC<ConnectionFormProps> = ({
  open,
  onClose,
  onSubmit,
  onConnect,
  initial,
  initialValues,
}) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
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

  const updateField = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const updateJumpHost = <K extends keyof JumpHostConfig>(
    key: K,
    value: JumpHostConfig[K],
  ): void => {
    setForm((prev) => ({
      ...prev,
      jumpHost: { ...prev.jumpHost, [key]: value },
    }));
  };

  const pickPrivateKey = async (
    target: 'main' | 'jump' = 'main',
  ): Promise<void> => {
    const path = await invokePickPrivateKeyFile();
    if (!path) return;
    if (target === 'main') {
      updateField('privateKeyPath', path);
    } else {
      updateJumpHost('privateKeyPath', path);
    }
  };

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
    const canKeepStoredPassword = Boolean(
      initial?.authMethod === 'password' &&
        (initial.passwordStored || initial.password),
    );
    if (
      form.authMethod === 'password' &&
      !form.password.trim() &&
      !canKeepStoredPassword
    ) {
      nextErrors.password = t('connection.form.validation.passwordRequired');
    }
    if (form.authMethod === 'key' && !form.privateKeyPath.trim()) {
      nextErrors.privateKeyPath = t(
        'connection.form.validation.privateKeyRequired',
      );
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const buildValues = (): Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> => ({
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.password.trim() || undefined,
    privateKeyPath: form.privateKeyPath.trim() || undefined,
    passphrase: form.passphrase.trim() || undefined,
    jumpHost: form.useJumpHost ? form.jumpHost : undefined,
  });

  const submit = async (
    action: ConnectionFormProps['onSubmit'],
  ): Promise<void> => {
    if (submissionInFlightRef.current || !validate()) return;

    submissionInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      await action(buildValues());
      onClose();
    } catch {
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

  return (
    <Drawer open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DrawerContent className="w-[400px] gap-0 p-0">
        <DrawerHeader className="border-b border-app-border px-5 py-4">
          <DrawerTitle>
            {initial
              ? t('connection.form.title.edit')
              : t('connection.form.title.new')}
          </DrawerTitle>
          <p className="text-xs text-muted-foreground">
            {t('connection.form.subtitle')}
          </p>
        </DrawerHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          <FormSection icon={Server} title={t('connection.form.section.general')}>
            <FormRow label={t('common.name')} error={errors.name}>
              <Input
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="My Server"
              />
            </FormRow>
            <div className="grid grid-cols-3 gap-3">
              <FormRow className="col-span-2" label={t('common.host')} error={errors.host}>
                <Input
                  value={form.host}
                  onChange={(e) => updateField('host', e.target.value)}
                  onBlur={handleHostBlur}
                  placeholder="192.168.1.1"
                />
              </FormRow>
              <FormRow label={t('common.port')} error={errors.port}>
                <Input
                  value={form.port}
                  onChange={(e) => updateField('port', e.target.value)}
                  type="number"
                />
              </FormRow>
            </div>
            <FormRow label={t('common.username')} error={errors.username}>
              <Input
                value={form.username}
                onChange={(e) => updateField('username', e.target.value)}
                placeholder="root"
              />
            </FormRow>
          </FormSection>

          <FormSection icon={KeyRound} title={t('connection.form.section.auth')}>
            <AuthMethodToggle
              value={form.authMethod}
              onChange={(value) => updateField('authMethod', value)}
            />
            {form.authMethod === 'password' && (
              <FormRow label={t('common.password')} error={errors.password}>
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  placeholder={
                    initial?.passwordStored
                      ? t('connection.form.passwordStoredPlaceholder')
                      : undefined
                  }
                />
              </FormRow>
            )}
            {form.authMethod === 'key' && (
              <>
                <FormRow label={t('common.privateKey')} error={errors.privateKeyPath}>
                  <PrivateKeyPicker
                    value={form.privateKeyPath}
                    onChange={(value) => updateField('privateKeyPath', value)}
                    onBrowse={() => pickPrivateKey('main')}
                  />
                </FormRow>
                <FormRow label={t('common.passphrase')}>
                  <Input
                    type="password"
                    value={form.passphrase}
                    onChange={(e) => updateField('passphrase', e.target.value)}
                  />
                </FormRow>
              </>
            )}
          </FormSection>

          <FormSection icon={Network} title={t('connection.form.jumpHost')}>
            <div
              className={cn(
                'flex flex-col rounded-lg border border-app-border transition-colors',
                form.useJumpHost && 'bg-muted/50',
              )}
            >
              <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-app-text">
                    {t('connection.form.useJumpHost')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('connection.form.jumpHostHint')}
                  </span>
                </div>
                <Switch
                  checked={form.useJumpHost}
                  onCheckedChange={(checked) =>
                    updateField('useJumpHost', checked)
                  }
                />
              </div>
              {form.useJumpHost && (
                <div className="flex flex-col gap-2.5 border-t border-app-border px-3.5 py-3">
                  <div className="grid grid-cols-3 gap-3">
                    <FormRow className="col-span-2" label={t('common.host')}>
                      <Input
                        value={form.jumpHost.host}
                        onChange={(e) => updateJumpHost('host', e.target.value)}
                      />
                    </FormRow>
                    <FormRow label={t('common.port')}>
                      <Input
                        value={form.jumpHost.port}
                        onChange={(e) =>
                          updateJumpHost('port', Number(e.target.value))
                        }
                        type="number"
                      />
                    </FormRow>
                  </div>
                  <FormRow label={t('common.username')}>
                    <Input
                      value={form.jumpHost.username}
                      onChange={(e) => updateJumpHost('username', e.target.value)}
                    />
                  </FormRow>
                  <AuthMethodToggle
                    value={form.jumpHost.authMethod}
                    onChange={(value) => updateJumpHost('authMethod', value)}
                  />
                  {form.jumpHost.authMethod === 'password' && (
                    <FormRow label={t('common.password')}>
                      <Input
                        type="password"
                        value={form.jumpHost.password ?? ''}
                        onChange={(e) => updateJumpHost('password', e.target.value)}
                      />
                    </FormRow>
                  )}
                  {form.jumpHost.authMethod === 'key' && (
                    <>
                      <FormRow label={t('common.privateKey')}>
                        <PrivateKeyPicker
                          value={form.jumpHost.privateKeyPath ?? ''}
                          onChange={(value) =>
                            updateJumpHost('privateKeyPath', value)
                          }
                          onBrowse={() => pickPrivateKey('jump')}
                        />
                      </FormRow>
                      <FormRow label={t('common.passphrase')}>
                        <Input
                          type="password"
                          value={form.jumpHost.passphrase ?? ''}
                          onChange={(e) =>
                            updateJumpHost('passphrase', e.target.value)
                          }
                        />
                      </FormRow>
                    </>
                  )}
                </div>
              )}
            </div>
          </FormSection>
        </div>

        <DrawerFooter className="border-t-0 px-5 pb-4 pt-1">
          <div className="flex w-full">
            <Button
              variant="default"
              className="flex-1 rounded-r-none"
              onClick={handleConnect}
              disabled={isSubmitting}
            >
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
                <DropdownMenuItem
                  onClick={handleSaveOnly}
                  disabled={isSubmitting}
                >
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
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
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

interface PrivateKeyPickerProps {
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
}

const PrivateKeyPicker: React.FC<PrivateKeyPickerProps> = ({
  value,
  onChange,
  onBrowse,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/path/to/key"
        className="flex-1"
      />
      <Button variant="outline" className="shrink-0" onClick={onBrowse}>
        <FolderOpen />
        {t('connection.form.browse')}
      </Button>
    </div>
  );
};

interface FormRowProps {
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

const FormRow: React.FC<FormRowProps> = ({
  label,
  error,
  children,
  className,
}) => {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error && (
        <span className="text-xs text-app-error">{error}</span>
      )}
    </div>
  );
};
