import { useState, type ChangeEvent, FormEvent } from 'react';
import { t } from '../lib/i18n';
import { parseQuickConnect } from '../lib/profile';
import type { ConnectionProfile, JumpHostConfig, PortForwardConfig } from '../types';

type TabKey = 'basic' | 'jumpHost' | 'portForwarding';

interface ConnectionFormProps {
  profile: ConnectionProfile;
  onProfileChange: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => void;
  compact?: boolean;
}

const tabKeys: TabKey[] = ['basic', 'jumpHost', 'portForwarding'];

export function ConnectionForm({ profile, onProfileChange, onConnect, compact = false }: ConnectionFormProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('basic');

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

  const tabLabel = (key: TabKey): string => {
    switch (key) {
      case 'basic': return t('connectionForm.tabBasic');
      case 'jumpHost': return t('connectionForm.tabJumpHost');
      case 'portForwarding': return t('connectionForm.tabPortForwarding');
    }
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

      {/* Tab bar */}
      <div className="settings-tab-bar">
        {tabKeys.map((key) => (
          <button
            key={key}
            className={`settings-tab ${activeTab === key ? 'settings-tab--active' : ''}`}
            onClick={() => setActiveTab(key)}
            type="button"
          >
            {tabLabel(key)}
          </button>
        ))}
      </div>

      {/* Tab panels — grid overlay so all share the same height */}
      <div className="connection-tab-panels">
        {/* ───────── Tab: Basic ───────── */}
        <div className={activeTab === 'basic' ? '' : 'connection-tab-panel--hidden'}>
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.quickConnect')}</span>
              <input
                className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
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
              <span className="text-[11px] text-slate-500">{t('connectionForm.quickConnectHint')}</span>
            </label>

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
          </div>
        </div>

        {/* ───────── Tab: Jump Host ───────── */}
        <div className={activeTab === 'jumpHost' ? '' : 'connection-tab-panel--hidden'}>
          <div className="flex flex-col gap-1.5">
            <div className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_84px]">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.host')}</span>
                <input
                  className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
                  value={profile.jumpHost?.host ?? ''}
                  onChange={(event) => {
                    const next: JumpHostConfig = { ...profile.jumpHost, host: event.target.value, port: profile.jumpHost?.port ?? 22, username: profile.jumpHost?.username ?? '', authMethod: profile.jumpHost?.authMethod ?? 'password' };
                    onProfileChange({ ...profile, jumpHost: next });
                  }}
                  placeholder={t('connectionForm.hostPlaceholder')}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.port')}</span>
                <input
                  className="themed-input no-number-spinner rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
                  type="number"
                  value={profile.jumpHost?.port ?? 22}
                  onChange={(event) => {
                    const next: JumpHostConfig = { host: profile.jumpHost?.host ?? '', port: Number(event.target.value), username: profile.jumpHost?.username ?? '', authMethod: profile.jumpHost?.authMethod ?? 'password', ...(profile.jumpHost ? { password: profile.jumpHost.password, privateKeyPath: profile.jumpHost.privateKeyPath, passphrase: profile.jumpHost.passphrase } : {}) };
                    onProfileChange({ ...profile, jumpHost: next });
                  }}
                  min={1}
                  max={65535}
                />
              </label>
            </div>
            <div className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_132px]">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.username')}</span>
                <input
                  className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
                  value={profile.jumpHost?.username ?? ''}
                  onChange={(event) => {
                    const next: JumpHostConfig = { host: profile.jumpHost?.host ?? '', port: profile.jumpHost?.port ?? 22, username: event.target.value, authMethod: profile.jumpHost?.authMethod ?? 'password', ...(profile.jumpHost ? { password: profile.jumpHost.password, privateKeyPath: profile.jumpHost.privateKeyPath, passphrase: profile.jumpHost.passphrase } : {}) };
                    onProfileChange({ ...profile, jumpHost: next });
                  }}
                  placeholder={t('connectionForm.usernamePlaceholder')}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.auth')}</span>
                <select
                  className="themed-input h-8.5 rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
                  value={profile.jumpHost?.authMethod ?? 'password'}
                  onChange={(event) => {
                    const authMethod = event.target.value as ConnectionProfile['authMethod'];
                    const next: JumpHostConfig = { host: profile.jumpHost?.host ?? '', port: profile.jumpHost?.port ?? 22, username: profile.jumpHost?.username ?? '', authMethod };
                    onProfileChange({ ...profile, jumpHost: next });
                  }}
                >
                  <option value="password">{t('connectionForm.auth.password')}</option>
                  <option value="key">{t('connectionForm.auth.key')}</option>
                </select>
              </label>
            </div>
            {(profile.jumpHost?.authMethod ?? 'password') === 'password' ? (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.password')}</span>
                <input
                  className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
                  type="password"
                  value={profile.jumpHost?.password ?? ''}
                  onChange={(event) => {
                    const next: JumpHostConfig = { host: profile.jumpHost?.host ?? '', port: profile.jumpHost?.port ?? 22, username: profile.jumpHost?.username ?? '', authMethod: profile.jumpHost?.authMethod ?? 'password', password: event.target.value };
                    onProfileChange({ ...profile, jumpHost: next });
                  }}
                />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.privateKeyPath')}</span>
                  <input
                    className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
                    value={profile.jumpHost?.privateKeyPath ?? ''}
                    onChange={(event) => {
                      const next: JumpHostConfig = { host: profile.jumpHost?.host ?? '', port: profile.jumpHost?.port ?? 22, username: profile.jumpHost?.username ?? '', authMethod: 'key', privateKeyPath: event.target.value, passphrase: profile.jumpHost?.passphrase };
                      onProfileChange({ ...profile, jumpHost: next });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-slate-300">{t('connectionForm.passphrase')}</span>
                  <input
                    className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
                    type="password"
                    value={profile.jumpHost?.passphrase ?? ''}
                    onChange={(event) => {
                      const next: JumpHostConfig = { host: profile.jumpHost?.host ?? '', port: profile.jumpHost?.port ?? 22, username: profile.jumpHost?.username ?? '', authMethod: 'key', privateKeyPath: profile.jumpHost?.privateKeyPath ?? '', passphrase: event.target.value, ...(profile.jumpHost ? { password: profile.jumpHost.password } : {}) };
                      onProfileChange({ ...profile, jumpHost: next });
                    }}
                  />
                </label>
              </>
            )}
          </div>
        </div>

        {/* ───────── Tab: Port Forwarding ───────── */}
        <div className={activeTab === 'portForwarding' ? '' : 'connection-tab-panel--hidden'}>
          <div className="flex flex-col gap-2">
            <p className="text-[11px] text-slate-500">{t('connectionForm.portForwardingHint')}</p>
            <div className="port-forward-list">
            {(profile.portForwards ?? []).map((fw, i) => (
              <div key={i} className="flex flex-wrap items-end gap-1.5 rounded-md border border-slate-700/30 p-1.5">
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium text-slate-400">{t('connectionForm.portForwardKind')}</span>
                  <select
                    className="themed-input h-7 rounded-lg px-2 text-xs outline-none transition focus:border-cyan-400/60"
                    value={fw.kind}
                    onChange={(event) => {
                      const kind = event.target.value as 'local' | 'remote';
                      const next = [...(profile.portForwards ?? [])];
                      next[i] = { ...next[i], kind };
                      onProfileChange({ ...profile, portForwards: next });
                    }}
                  >
                    <option value="local">{t('connectionForm.portForwardLocal')}</option>
                    <option value="remote">{t('connectionForm.portForwardRemote')}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium text-slate-400">{t('connectionForm.port')}</span>
                  <input
                    className="themed-input no-number-spinner h-7 w-16 rounded-lg px-2 text-xs outline-none transition focus:border-cyan-400/60"
                    type="number"
                    value={fw.localPort}
                    onChange={(event) => {
                      const next = [...(profile.portForwards ?? [])];
                      next[i] = { ...next[i], localPort: Number(event.target.value) };
                      onProfileChange({ ...profile, portForwards: next });
                    }}
                    min={1}
                    max={65535}
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium text-slate-400">{t('connectionForm.remoteHost')}</span>
                  <input
                    className="themed-input h-7 w-28 rounded-lg px-2 text-xs outline-none transition focus:border-cyan-400/60"
                    value={fw.remoteHost}
                    onChange={(event) => {
                      const next = [...(profile.portForwards ?? [])];
                      next[i] = { ...next[i], remoteHost: event.target.value };
                      onProfileChange({ ...profile, portForwards: next });
                    }}
                    placeholder={t('connectionForm.hostPlaceholder')}
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-medium text-slate-400">{t('connectionForm.port')}</span>
                  <input
                    className="themed-input no-number-spinner h-7 w-16 rounded-lg px-2 text-xs outline-none transition focus:border-cyan-400/60"
                    type="number"
                    value={fw.remotePort}
                    onChange={(event) => {
                      const next = [...(profile.portForwards ?? [])];
                      next[i] = { ...next[i], remotePort: Number(event.target.value) };
                      onProfileChange({ ...profile, portForwards: next });
                    }}
                    min={1}
                    max={65535}
                  />
                </label>
                <button
                  className="mb-0.5 inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs text-rose-400 transition hover:bg-rose-400/10"
                  onClick={() => {
                    const next = (profile.portForwards ?? []).filter((_, idx) => idx !== i);
                    onProfileChange({ ...profile, portForwards: next.length > 0 ? next : undefined });
                  }}
                  type="button"
                  title={t('common.delete')}
                >
                  &times;
                </button>
              </div>
            ))}
            </div>
            <button
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-dashed border-slate-600/50 px-3 py-1.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-300"
              onClick={() => {
                const next: PortForwardConfig = { kind: 'local', localPort: 8080, remoteHost: '', remotePort: 80 };
                onProfileChange({ ...profile, portForwards: [...(profile.portForwards ?? []), next] });
              }}
              type="button"
            >
              + {t('connectionForm.addForward')}
            </button>
          </div>
        </div>
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
