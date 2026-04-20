import type { ChangeEvent, FormEvent } from 'react';
import type { ConnectionProfile } from '../types';

interface ConnectionFormProps {
  profile: ConnectionProfile;
  onProfileChange: (profile: ConnectionProfile) => void;
  onConnect: (
    profile: ConnectionProfile,
    remember: boolean,
    rememberPassword: boolean,
  ) => void;
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
      rememberPassword: authMethod === 'password' ? profile.rememberPassword ?? false : false,
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
          <span className="label">快速连接</span>
          <h2 className="themed-heading text-sm font-semibold">打开远程终端</h2>
          <p className="text-xs text-slate-400">密码和密钥口令只参与本次连接，不会持久化。</p>
        </div>
      ) : (
        <p className="text-xs text-slate-400">填好主机和认证信息后直接启动新的 SSH 会话。</p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-slate-300">名称</span>
        <input
          className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
          value={profile.name}
          onChange={handleTextChange('name')}
          placeholder="生产 / 堡垒机 / 演示"
        />
      </label>

      <div className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_84px]">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">主机</span>
          <input
            className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            value={profile.host}
            onChange={handleTextChange('host')}
            placeholder="192.168.1.10 / server.example.com"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">端口</span>
          <input
            className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
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
          <span className="text-[11px] font-medium text-slate-300">用户名</span>
          <input
            className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            value={profile.username}
            onChange={handleTextChange('username')}
            placeholder="root / ubuntu / deploy"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">认证</span>
          <select
            className="themed-input h-[34px] rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            value={profile.authMethod}
            onChange={handleAuthChange}
          >
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </label>
      </div>

      {profile.authMethod === 'password' ? (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-300">密码</span>
          <input
            className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
            type="password"
            value={profile.password ?? ''}
            onChange={handleTextChange('password')}
            placeholder="不会写入本地存储"
          />
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-300">私钥路径</span>
            <input
              className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
              value={profile.privateKeyPath ?? ''}
              onChange={handleTextChange('privateKeyPath')}
              placeholder="~/.ssh/id_ed25519 或 C:\\Users\\you\\.ssh\\id_rsa"
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-300">私钥口令</span>
            <input
              className="themed-input rounded-lg px-3 py-1.5 text-sm outline-none transition focus:border-cyan-400/60"
              type="password"
              value={profile.passphrase ?? ''}
              onChange={handleTextChange('passphrase')}
              placeholder="如密钥有口令可填写"
            />
          </label>
        </>
      )}

      <div className="flex flex-wrap gap-1">
        <label className="themed-checkbox-row flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs">
          <input className="themed-checkbox" name="remember" type="checkbox" defaultChecked />
          <span>保存连接信息</span>
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
            <span>保存密码</span>
          </label>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5">
        <button className="primary-btn w-full" type="submit">
          启动连接
        </button>
        <small className="text-xs text-slate-500">建议优先为常用主机配置私钥认证。</small>
      </div>
    </form>
  );
}
