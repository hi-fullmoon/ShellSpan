import type { ChangeEvent, FormEvent } from 'react';
import { t } from '../lib/i18n';
import type { ConnectionProfile } from '../types';

interface ConnectionFormProps {
  profile: ConnectionProfile;
  onProfileChange: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => void;
  compact?: boolean;
}

export function ConnectionForm({ profile, onProfileChange, onConnect, compact = false }: ConnectionFormProps) {
  const handleTextChange = (field: keyof ConnectionProfile) => (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = field === 'port' ? Number(event.target.value) : event.target.value;
    onProfileChange({
      ...profile,
      [field]: nextValue,
    });
  };

  const handleAuthChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const authMethod = event.target.value as ConnectionProfile['authMethod'];
    onProfileChange({
      ...profile,
      authMethod,
      rememberPassword: authMethod === 'password' ? (profile.rememberPassword ?? false) : false,
      password: authMethod === 'password' ? (profile.password ?? '') : '',
      privateKeyPath: authMethod === 'key' ? (profile.privateKeyPath ?? '') : '',
      passphrase: authMethod === 'key' ? (profile.passphrase ?? '') : '',
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const remember = (formData.get('remember') ?? '') === 'on';
    const rememberPassword = (formData.get('rememberPassword') ?? '') === 'on';
    onConnect(profile, remember, rememberPassword);
  };

  return (
    <form className="flex flex-col gap-1.5" onSubmit={handleSubmit}>
      {!compact ? (
        <div className="flex flex-col gap-0.5">
          <span className="label">{t('connectionForm.quickConnect')}</span>
          <h2 className="themed-heading text-sm font-semibold">{t('connectionForm.title')}</h2>
          <p className="text-xs text-slate-400">{t('connectionForm.description')}</p>
        </div>
      ) : (
        <p className="text-xs text-slate-400">{t('connectionForm.compactDescription')}</p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.name')}</span>
        <input
          className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
          value={profile.name}
          onChange={handleTextChange('name')}
          placeholder={t('connectionForm.namePlaceholder')}
        />
      </label>

      <div className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_84px]">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.host')}</span>
          <input
            className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            value={profile.host}
            onChange={handleTextChange('host')}
            placeholder={t('connectionForm.hostPlaceholder')}
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.port')}</span>
          <input
            className="themed-input no-number-spinner rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
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
          <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.username')}</span>
          <input
            className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            value={profile.username}
            onChange={handleTextChange('username')}
            placeholder={t('connectionForm.usernamePlaceholder')}
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.auth')}</span>
          <select
            className="themed-input h-8.5 rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            value={profile.authMethod}
            onChange={handleAuthChange}
          >
            <option value="password">{t('connectionForm.auth.password')}</option>
            <option value="key">{t('connectionForm.auth.key')}</option>
          </select>
        </label>
      </div>

      {profile.authMethod === 'password' ? (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.password')}</span>
          <input
            className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            type="password"
            value={profile.password ?? ''}
            onChange={handleTextChange('password')}
            placeholder={t('connectionForm.passwordPlaceholder')}
          />
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.privateKeyPath')}</span>
            <input
              className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
              value={profile.privateKeyPath ?? ''}
              onChange={handleTextChange('privateKeyPath')}
              placeholder={t('connectionForm.privateKeyPathPlaceholder')}
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.passphrase')}</span>
            <input
              className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
              type="password"
              value={profile.passphrase ?? ''}
              onChange={handleTextChange('passphrase')}
              placeholder={t('connectionForm.passphrasePlaceholder')}
            />
          </label>
        </>
      )}

      <div className="flex flex-wrap gap-1">
        <label className="themed-checkbox-row flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs">
          <input className="themed-checkbox" name="remember" type="checkbox" defaultChecked />
          <span>{t('connectionForm.remember')}</span>
        </label>

        {profile.authMethod === 'password' ? (
          <label className="themed-checkbox-row flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs">
            <input
              className="themed-checkbox"
              checked={profile.rememberPassword ?? false}
              name="rememberPassword"
              onChange={(event) =>
                onProfileChange({
                  ...profile,
                  rememberPassword: event.target.checked,
                })
              }
              type="checkbox"
            />
            <span>{t('connectionForm.rememberPassword')}</span>
          </label>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5">
        <button className="primary-btn w-full" type="submit">
          {t('connectionForm.submit')}
        </button>
        <small className="text-xs text-slate-500">{t('connectionForm.hint')}</small>
      </div>
    </form>
  );
}
