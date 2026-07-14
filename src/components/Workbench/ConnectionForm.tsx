import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Dialog } from '@/components/ui/Dialog';
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
    setForm(initial ? profileToForm(initial) : EMPTY_FORM);
    setErrors({});
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
    <Dialog
      open={open}
      onClose={onClose}
      title={
        initial
          ? t('connection.form.title.edit')
          : t('connection.form.title.new')
      }
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
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
          <Select
            value={form.authMethod}
            options={[
              {
                value: 'password',
                label: t('connection.form.auth.password'),
              },
              { value: 'key', label: t('connection.form.auth.key') },
            ]}
            onChange={(e) => updateField('authMethod', e.target.value as AuthMethod)}
          />
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

        <label className="flex items-center gap-2 text-xs text-app-text">
          <input
            type="checkbox"
            checked={form.useJumpHost}
            onChange={(e) => updateField('useJumpHost', e.target.checked)}
            className="rounded border-app-border"
          />
          {t('connection.form.useJumpHost')}
        </label>

        {form.useJumpHost && (
          <div className="flex flex-col gap-4 rounded-lg border border-app-border bg-app-bg p-4">
            <span className="text-xs font-medium text-app-text-soft">
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
              <Select
                value={form.jumpHost.authMethod}
                options={[
                  {
                    value: 'password',
                    label: t('connection.form.auth.password'),
                  },
                  {
                    value: 'key',
                    label: t('connection.form.auth.key'),
                  },
                ]}
                onChange={(e) =>
                  updateJumpHost(
                    'authMethod',
                    e.target.value as AuthMethod,
                  )
                }
              />
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
    </Dialog>
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
      <label className="text-xs text-app-text-soft">{label}</label>
      {children}
      {error && (
        <span className="text-xs text-app-error">{error}</span>
      )}
    </div>
  );
};
