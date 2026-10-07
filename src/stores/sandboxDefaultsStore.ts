import { create } from 'zustand';
import { invokeLoadPreferences, invokeSavePreferences } from '@/lib/ipc/tauri';
import type { AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';

const KEY = 'agent_sandbox_defaults';
export interface SandboxDefaultConfiguration {
  readonly policy: AgentSandboxPolicy;
  readonly cacheDirectories: readonly string[];
}

export function sandboxDefaultScope(target: AgentSessionTarget | undefined): string | null {
  if (!target) return null;
  if (target.kind === 'local') {
    const root = target.localRoot ?? target.rootPath ?? target.cwd;
    return root ? `project:${JSON.stringify(root)}` : null;
  }
  return target.profileId && target.host && target.username && target.port
    ? `connection:${JSON.stringify([target.profileId, target.host, target.port, target.username])}` : null;
}

export function parseSandboxDefaults(entries: readonly [string, string][]): Readonly<Record<string, SandboxDefaultConfiguration>> {
  const stored = entries.find(([key]) => key === KEY)?.[1];
  if (!stored) return {};
  const data: unknown = JSON.parse(stored);
  if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
    || !('defaults' in data) || !data.defaults || typeof data.defaults !== 'object' || Array.isArray(data.defaults)) throw new Error('Invalid sandbox default configuration');
  const result: Record<string, SandboxDefaultConfiguration> = {};
  for (const [key, item] of Object.entries(data.defaults)) {
    if ((!key.startsWith('project:') && !key.startsWith('connection:')) || key.length > 8192) continue;
    if (!item || typeof item !== 'object') throw new Error('Invalid saved sandbox policy');
    const value = item as Record<string, unknown>;
    if (value.policy !== 'readOnly' && value.policy !== 'workspace' && value.policy !== 'host') throw new Error('Invalid saved sandbox policy');
    const cacheDirectories = Array.isArray(value.cacheDirectories) ? value.cacheDirectories.filter((path): path is string => typeof path === 'string' && path.length <= 4096 && /^(?:\/|[A-Za-z]:[\\/])/.test(path) && !/[\x00-\x1f\x7f]/.test(path)) : [];
    // Explicitly rebuild the configuration; grant, expiry, credentials and bearer fields cannot persist.
    result[key] = {policy:value.policy,cacheDirectories:cacheDirectories.slice(0,8)};
  }
  return result;
}

interface SandboxDefaultsState {
  readonly defaults: Readonly<Record<string, SandboxDefaultConfiguration>>;
  readonly initialized: boolean;
  readonly loadError: boolean;
  load: () => Promise<void>;
  remember: (scope: string, configuration: SandboxDefaultConfiguration | null) => Promise<void>;
  clear: () => Promise<void>;
}
let loading: Promise<void> | undefined;
let saving: Promise<void> = Promise.resolve();
export const useSandboxDefaultsStore = create<SandboxDefaultsState>((set,get) => ({
  defaults:{}, initialized:false, loadError:false,
  load: () => {
    if (loading) return loading;
    loading = saving.catch(() => {}).then(() => invokeLoadPreferences()).then(entries => { set({defaults:parseSandboxDefaults(entries),initialized:true,loadError:false}); })
      .catch(() => { set({initialized:true,loadError:true}); })
      .finally(() => { loading = undefined; });
    saving = loading;
    return loading;
  },
  remember: (scope, configuration) => {
    const operation = saving.catch(() => {}).then(async () => {
      if (!get().initialized || get().loadError) throw new Error('Sandbox default configuration is not loaded');
      const defaults = {...get().defaults};
      if (configuration) defaults[scope] = {policy:configuration.policy,cacheDirectories:[...configuration.cacheDirectories].slice(0,8)};
      else delete defaults[scope];
      const safe = parseSandboxDefaults([[KEY,JSON.stringify({version:1,defaults})]]);
      await invokeSavePreferences([[KEY,JSON.stringify({version:1,defaults:safe})]]);
      set({defaults:safe});
    });
    saving = operation;
    return operation;
  },
  clear: () => {
    const operation = saving.catch(() => {}).then(async () => {
      await invokeSavePreferences([[KEY,JSON.stringify({version:1,defaults:{}})]]);
      set({defaults:{},initialized:true,loadError:false});
    });
    saving = operation;
    return operation;
  },
}));
