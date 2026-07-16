import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { type LocaleKey } from '@/locales';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/drawer';
import { Checkbox } from '@/components/ui/checkbox';
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
  onSubmit: (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>) => void;
  initial?: ConnectionProfile;
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

const authMethodLabels: Record<AuthMethod, LocaleKey> = {
  password: 'connection.form.auth.password',
  key: 'connection.form.auth.key',
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
  initial,
}) => {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setForm(initial ? profileToForm(initial) : EMPTY_FORM);
      setErrors({});
    }
  }, [initial, open]);

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
    if (form.authMethod === 'password' && !form.password.trim()) {
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

  const handleSubmit = (): void => {
    if (!validate()) return;
    onSubmit({
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
    onClose();
  };

  return (
    <Drawer open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>
            {initial
              ? t('connection.form.title.edit')
              : t('connection.form.title.new')}
          </DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
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

        <FormRow label={t('common.authMethod')}>
          <Select value={form.authMethod} onValueChange={(value) => updateField('authMethod', value as AuthMethod)}>
            <SelectTrigger>
              <SelectValue>{t(authMethodLabels[form.authMethod])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">{t('connection.form.auth.password')}</SelectItem>
              <SelectItem value="key">{t('connection.form.auth.key')}</SelectItem>
            </SelectContent>
          </Select>
        </FormRow>

        {form.authMethod === 'password' && (
          <FormRow label={t('common.password')} error={errors.password}>
            <Input
              type="password"
              value={form.password}
              onChange={(e) => updateField('password', e.target.value)}
            />
          </FormRow>
        )}

        {form.authMethod === 'key' && (
          <>
            <FormRow
              label={t('common.privateKey')}
              error={errors.privateKeyPath}
            >
              <div className="flex gap-2">
                <Input
                  value={form.privateKeyPath}
                  onChange={(e) =>
                    updateField('privateKeyPath', e.target.value)
                  }
                  placeholder="/path/to/key"
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => pickPrivateKey('main')}
                >
                  ...
                </Button>
              </div>
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

        <Label className="flex items-center gap-2 text-xs text-app-text">
          <Checkbox
            checked={form.useJumpHost}
            onCheckedChange={(checked) => updateField('useJumpHost', checked === true)}
          />
          {t('connection.form.useJumpHost')}
        </Label>

        {form.useJumpHost && (
          <div className="flex flex-col gap-2 rounded-lg border border-app-border bg-muted p-2.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('connection.form.jumpHost')}
            </span>
            <FormRow label={t('common.host')}>
              <Input
                value={form.jumpHost.host}
                onChange={(e) => updateJumpHost('host', e.target.value)}
              />
            </FormRow>
            <div className="grid grid-cols-2 gap-3">
              <FormRow label={t('common.port')}>
                <Input
                  value={form.jumpHost.port}
                  onChange={(e) =>
                    updateJumpHost('port', Number(e.target.value))
                  }
                  type="number"
                />
              </FormRow>
              <FormRow label={t('common.username')}>
                <Input
                  value={form.jumpHost.username}
                  onChange={(e) => updateJumpHost('username', e.target.value)
                  }
                />
              </FormRow>
            </div>
            <FormRow label={t('common.authMethod')}>
              <Select value={form.jumpHost.authMethod} onValueChange={(value) => updateJumpHost('authMethod', value as AuthMethod)}>
                <SelectTrigger>
                  <SelectValue>{t(authMethodLabels[form.jumpHost.authMethod])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">{t('connection.form.auth.password')}</SelectItem>
                  <SelectItem value="key">{t('connection.form.auth.key')}</SelectItem>
                </SelectContent>
              </Select>
            </FormRow>
            {form.jumpHost.authMethod === 'password' && (
              <FormRow label={t('common.password')}>
                <Input
                  type="password"
                  value={form.jumpHost.password ?? ''}
                  onChange={(e) => updateJumpHost('password', e.target.value)
                  }
                />
              </FormRow>
            )}
            {form.jumpHost.authMethod === 'key' && (
              <>
                <FormRow label={t('common.privateKey')}>
                  <div className="flex gap-2">
                    <Input
                      value={form.jumpHost.privateKeyPath ?? ''}
                      onChange={(e) =>
                        updateJumpHost('privateKeyPath', e.target.value)
                      }
                      className="flex-1"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => pickPrivateKey('jump')}
                    >
                      ...
                    </Button>
                  </div>
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
        <DrawerFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" onClick={handleSubmit}>
            {t('common.save')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
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
    <div className={cn('flex flex-col gap-0.5', className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error && (
        <span className="text-xs text-app-error">{error}</span>
      )}
    </div>
  );
};
