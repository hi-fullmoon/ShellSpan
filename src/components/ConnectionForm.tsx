import { invoke } from '@tauri-apps/api/core';
import { FormEvent, useState, type ChangeEvent } from 'react';
import { t } from '../lib/i18n';
import { parseQuickConnect } from '../lib/profile';
import type { ConnectionProfile } from '../types';
import { cn, PROFILE_COLORS } from '../lib/ui';
import { Input, Checkbox } from '@chakra-ui/react';
import { FolderIcon, Tooltip, FormSelect } from './ui';

interface ConnectionFormProps {
  profile: ConnectionProfile;
  onProfileChange: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => void;
  compact?: boolean;
  isConnecting?: boolean;
}

export function ConnectionForm({ profile, onProfileChange, onConnect, compact = false, isConnecting }: ConnectionFormProps) {
  const [hoveredColor, setHoveredColor] = useState<string | 'clear' | null>(null);

  const handleTextChange = (field: keyof ConnectionProfile) => (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = field === 'port' ? Number(event.target.value) : event.target.value;
    onProfileChange({
      ...profile,
      [field]: nextValue,
    });
  };

  const handleAuthChange = (authMethod: ConnectionProfile['authMethod']) => {
    onProfileChange({
      ...profile,
      authMethod,
      rememberPassword: authMethod === 'password' ? (profile.rememberPassword ?? false) : false,
      password: authMethod === 'password' ? (profile.password ?? '') : '',
      privateKeyPath: authMethod === 'key' ? (profile.privateKeyPath ?? '') : '',
      passphrase: authMethod === 'key' ? (profile.passphrase ?? '') : '',
    });
  };

  const handlePickPrivateKey = async () => {
    try {
      const path = await invoke<string | null>('pick_private_key_file');
      if (!path) return;
      onProfileChange({ ...profile, privateKeyPath: path });
    } catch {
      // silently ignore cancellation or errors
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const remember = (formData.get('remember') ?? '') === 'on';
    const rememberPassword = (formData.get('rememberPassword') ?? '') === 'on';
    onConnect(profile, remember, rememberPassword);
  };

  return (
    <form className="flex h-full flex-col gap-1.5" onSubmit={handleSubmit}>
      {!compact ? (
        <div className="flex shrink-0 flex-col gap-0.5">
          <span className="label">{t('connectionForm.quickConnect')}</span>
          <h2 className="themed-heading text-sm font-semibold">{t('connectionForm.title')}</h2>
          <p className="text-xs text-(--app-text-muted)">{t('connectionForm.description')}</p>
        </div>
      ) : (
        <p className="text-xs text-(--app-text-muted)">{t('connectionForm.compactDescription')}</p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.quickConnect')}</span>
          <Input
            size="sm"
            className="themed-input text-sm outline-none transition focus:border-cyan-400/60"
            placeholder={t('connectionForm.quickConnectPlaceholder')}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') {
                return;
              }
              const parsed = parseQuickConnect(event.currentTarget.value);
              if (!parsed) {
                return;
              }
              onProfileChange({
                ...profile,
                name: parsed.host,
                host: parsed.host,
                username: parsed.username ?? profile.username,
                port: parsed.port ?? profile.port,
              });
              event.currentTarget.value = '';
            }}
          />
          <span className="text-[11px] text-(--app-text-muted)">{t('connectionForm.quickConnectHint')}</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.name')}</span>
          <Input
            size="sm"
            className="themed-input text-sm outline-none transition focus:border-cyan-400/60"
            value={profile.name}
            onChange={handleTextChange('name')}
            placeholder={t('connectionForm.namePlaceholder')}
          />
        </label>

        <div className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_84px]">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.host')}</span>
            <Input
              size="sm"
              className="themed-input text-sm outline-none transition focus:border-cyan-400/60"
              value={profile.host}
              onChange={handleTextChange('host')}
              placeholder={t('connectionForm.hostPlaceholder')}
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.port')}</span>
            <Input
              size="sm"
              className="themed-input no-number-spinner text-sm outline-none transition focus:border-cyan-400/60"
              type="number"
              value={profile.port}
              onChange={handleTextChange('port')}
              min={1}
              max={65535}
              required
            />
          </label>
        </div>

        <div className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_132px]">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.username')}</span>
            <Input
              size="sm"
              className="themed-input text-sm outline-none transition focus:border-cyan-400/60"
              value={profile.username}
              onChange={handleTextChange('username')}
              placeholder={t('connectionForm.usernamePlaceholder')}
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.auth')}</span>
            <FormSelect
              className="themed-input"
              onChange={(v) => handleAuthChange(v as ConnectionProfile['authMethod'])}
              options={[
                { label: t('connectionForm.auth.password'), value: 'password' },
                { label: t('connectionForm.auth.key'), value: 'key' },
              ]}
              value={profile.authMethod}
            />
          </label>
        </div>

        <div className="auth-field-stack">
          {profile.authMethod === 'password' ? (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.password')}</span>
              <Input
                size="sm"
                className="themed-input text-sm outline-none transition focus:border-cyan-400/60"
                type="password"
                value={profile.password ?? ''}
                onChange={handleTextChange('password')}
                placeholder={t('connectionForm.passwordPlaceholder')}
              />
            </label>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.privateKeyPath')}</span>
                <div className="relative">
                  <Input
                    size="sm"
                    className="themed-input w-full pr-8 text-sm outline-none transition focus:border-cyan-400/60"
                    value={profile.privateKeyPath ?? ''}
                    onChange={handleTextChange('privateKeyPath')}
                    placeholder={t('connectionForm.privateKeyPathPlaceholder')}
                    required={profile.authMethod === 'key'}
                  />
                  <button
                    type="button"
                    className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-sm text-(--app-text-muted) transition hover:bg-(--app-icon-hover) hover:text-(--app-text-soft)"
                    onClick={handlePickPrivateKey}
                  >
                    <Tooltip content={t('connectionForm.selectPrivateKey')}>
                      <FolderIcon className="h-4 w-4" />
                    </Tooltip>
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.passphrase')}</span>
                <Input
                  size="sm"
                  className="themed-input text-sm outline-none transition focus:border-cyan-400/60"
                  type="password"
                  value={profile.passphrase ?? ''}
                  onChange={handleTextChange('passphrase')}
                  placeholder={t('connectionForm.passphrasePlaceholder')}
                />
              </label>
            </>
          )}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-(--app-text-soft)">{t('connectionForm.color')}</span>
          <div className="flex flex-wrap items-center gap-2 px-1 py-0.5">
            <button
              className={cn(
                'relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-(--app-border) bg-(--app-bg) transition-transform',
                hoveredColor === 'clear' && 'scale-110',
                profile.color === undefined && 'ring-1 ring-offset-1 ring-(--app-primary-bg)',
              )}
              onClick={() => onProfileChange({ ...profile, color: undefined })}
              onMouseEnter={() => setHoveredColor('clear')}
              onMouseLeave={() => setHoveredColor(null)}
              title={t('sidebar.menu.clearColor')}
              type="button"
            >
              <span className="absolute block h-px w-full rotate-45 bg-(--app-text-muted)/50" />
            </button>
            {PROFILE_COLORS.map((color) => (
              <button
                className={cn(
                  'h-5 w-5 shrink-0 rounded-full transition-transform',
                  hoveredColor === color && 'scale-110',
                  profile.color === color && 'ring-2 ring-offset-1 ring-cyan-400',
                )}
                key={color}
                onClick={() => onProfileChange({ ...profile, color })}
                onMouseEnter={() => setHoveredColor(color)}
                onMouseLeave={() => setHoveredColor(null)}
                style={{ backgroundColor: color }}
                type="button"
              />
            ))}
          </div>
        </label>

        <div className="-ml-1 flex flex-wrap gap-1">
          <Checkbox.Root
            name="remember"
            className="themed-checkbox-row flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
            defaultChecked
            size="sm"
          >
            <Checkbox.Control className="themed-checkbox shrink-0" />
            <Checkbox.HiddenInput />
            <Checkbox.Label>{t('connectionForm.remember')}</Checkbox.Label>
          </Checkbox.Root>

          {profile.authMethod === 'password' ? (
            <Checkbox.Root
              name="rememberPassword"
              className="themed-checkbox-row flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
              checked={profile.rememberPassword ?? false}
              size="sm"
              onCheckedChange={(details) =>
                onProfileChange({
                  ...profile,
                  rememberPassword: details.checked as boolean,
                })
              }
            >
              <Checkbox.Control className="themed-checkbox shrink-0" />
              <Checkbox.HiddenInput />
              <Checkbox.Label>{t('connectionForm.rememberPassword')}</Checkbox.Label>
            </Checkbox.Root>
          ) : null}
        </div>
      </div>

      <div className="mt-auto flex shrink-0 flex-col gap-0.5 pt-1">
        <button className="btn-primary w-full" disabled={isConnecting} type="submit">
          {isConnecting ? t('connectionForm.connecting') : t('connectionForm.submit')}
        </button>
        <small className="block text-xs text-(--app-text-muted)">{t('connectionForm.hint')}</small>
      </div>
    </form>
  );
}
