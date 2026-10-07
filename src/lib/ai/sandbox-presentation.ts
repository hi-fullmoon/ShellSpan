import type { AgentSandboxPolicy, AgentSessionTarget } from '@/types/agent-session';
import type { LocaleKey } from '@/locales';

export const sandboxPolicyLabels: Record<AgentSandboxPolicy, LocaleKey> = {
  readOnly: 'agent.sandbox.readOnly',
  workspace: 'agent.sandbox.workspace',
  host: 'agent.sandbox.host',
};

export const sandboxGapLabels: Readonly<Record<string, LocaleKey>> = {
  'No verified production sandbox backend; host operations are not isolated': 'agent.sandbox.backendUnavailable',
  'Native path restrictions do not isolate hard-link aliases or hostile same-account filesystem races': 'agent.sandbox.aliasGap',
  'Process groups do not guarantee containment of all hostile descendants': 'agent.sandbox.processGap',
  'Remote Seatbelt path rules do not isolate hard-link aliases or hostile same-account filesystem races': 'agent.sandbox.aliasGap',
  'Remote controller process groups do not contain hostile descendants that escape their group': 'agent.sandbox.processGap',
  'Only verified macOS SSH Direct and its owned process controls are supported; remote resource/network grants and non-Shell tools remain unsupported': 'agent.sandbox.remoteToolsGap',
  'Native Direct shell, process controls and per-call/session project-file read grants are available; network grants are unavailable': 'agent.sandbox.legacyToolsGap',
  'Native Direct shell, process controls, project-file read grants and per-call public TCP proxy grants are available; local services are unavailable': 'agent.sandbox.legacyNetworkToolsGap',
  'Native Direct shell, process controls, project-file reads, public TCP proxies and Node loopback service relays are available; other tools and runtimes are unsupported': 'agent.sandbox.toolsGap',
  'Native Direct shell, process controls, project-file reads, cache-directory read/write grants, public TCP proxies and Node loopback service relays are available; other tools and runtimes are unsupported': 'agent.sandbox.cacheToolsGap',
  'Native Direct shell, process controls, project and approved non-sensitive external file reads, cache-directory read/write grants, public TCP proxies and Node loopback service relays are available; other tools and runtimes are unsupported': 'agent.sandbox.externalToolsGap',
};

export function defaultSandboxIntent(target: Pick<AgentSessionTarget, 'kind'>): AgentSandboxPolicy {
  return target.kind === 'remote' ? 'host' : 'workspace';
}
