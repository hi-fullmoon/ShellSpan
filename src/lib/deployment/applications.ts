import equal from 'fast-deep-equal';
import type { DeploymentSourceBinding, DeploymentSourceBindingInspection } from './types';
import type { DeploymentWorkflowRecord } from './types';

export interface DeploymentDataDirectory {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
  containerUser: string;
  backupPolicy: string;
}

export interface DeploymentEnvironmentConfig {
  gitRef?: string;
  imageRepository?: string;
  verification?: { packageManager: 'npm' | 'pnpm'; script: string };
  hostCompose?: HostComposeConfig;
  templateKind: 'dockerCompose' | 'staticSite';
  connectionProfileId: string;
  remoteRoot: string;
  platform: string;
  projectName: string;
  service: string;
  composeFile: string;
  dockerfile: string;
  buildContext: string;
  accessUrl: string;
  basePath: string;
  containerPort: number;
  hostPort: number;
  bindAddress: string;
  dataDirectories: DeploymentDataDirectory[];
  nonSensitiveFiles: string[];
  existingService: boolean;
  managementMethod: string;
  recoveryInstructions: string;
}

export interface HostComposeConfig {
  environmentFile: string;
  overrideFiles: string[];
  recreateServices: string[];
  backup: { script: string; arguments: string[] };
  checks: { url: string; status: number; jsonFields?: Record<string, string>; location?: string }[];
}

export function normalizeDeploymentConfig(config: DeploymentEnvironmentConfig): DeploymentEnvironmentConfig {
  const host = config.hostCompose;
  return {
    ...config,
    gitRef: config.gitRef?.trim() || undefined,
    nonSensitiveFiles: config.nonSensitiveFiles.map((value) => value.trim()).filter(Boolean),
    ...(host ? { hostCompose: {
      ...host,
      environmentFile: host.environmentFile.trim(),
      overrideFiles: host.overrideFiles.map((value) => value.trim()).filter(Boolean),
      recreateServices: host.recreateServices.map((value) => value.trim()).filter(Boolean),
      backup: { script: host.backup.script.trim(), arguments: host.backup.arguments.filter((value) => value.length > 0) },
      checks: host.checks.filter((check) => check.url.trim()).map((check) => ({ ...check, url: check.url.trim() })),
    } } : {}),
  };
}

export interface DeploymentApplicationEntry {
  application: { id: string; name: string; sourceBindingId: string; revision: number; archived: boolean };
  source: DeploymentSourceBinding;
  environment: {
    id: string;
    applicationId: string;
    name: string;
    revision: number;
    workflowId: string | null;
    config: DeploymentEnvironmentConfig;
  };
}

export interface SaveDeploymentApplicationInput {
  entry: DeploymentApplicationEntry;
  expectedApplicationRevision: number;
  expectedEnvironmentRevision: number;
  expectedSourceRevision: number;
  expectedWorkflowRevision: number;
  reconcileManagedFields?: boolean;
  workflowId: string | null;
}

export interface DeploymentProjectInspection {
  source: DeploymentSourceBindingInspection;
  detectedFiles: string[];
  composeServices: string[];
  suggestedTemplate: 'dockerCompose' | 'staticSite';
}

export type ReadinessStatus = 'passed' | 'blocked' | 'notice' | 'unchecked';
export interface DeploymentFilePreview {
  digest: string;
  files: { path: string; content: string; exists: boolean }[];
}
export interface DeploymentReadinessReport {
  configDigest: string;
  checkedAt: number;
  items: { key: string; status: ReadinessStatus; location: string; evidence: string; checkedAt: number | null }[];
}

export function createApplicationEntry(source: DeploymentSourceBinding, name: string, environmentName: string): DeploymentApplicationEntry {
  const applicationId = crypto.randomUUID();
  return {
    application: { id: applicationId, name, sourceBindingId: source.id, revision: 0, archived: false },
    source: { ...source, revision: 1 },
    environment: {
      id: crypto.randomUUID(), applicationId, name: environmentName, revision: 0, workflowId: null,
      config: {
        templateKind: 'dockerCompose',
        connectionProfileId: '', remoteRoot: '', platform: 'linux/amd64', projectName: 'app', service: 'web',
        composeFile: 'compose.yaml', dockerfile: 'Dockerfile', buildContext: '.', accessUrl: '', basePath: '/',
        containerPort: 3000, hostPort: 3000, bindAddress: '127.0.0.1', dataDirectories: [], nonSensitiveFiles: [],
        existingService: false, managementMethod: '', recoveryInstructions: '',
      },
    },
  };
}

export function workflowMappingIssues(workflow: DeploymentWorkflowRecord, entry?: DeploymentApplicationEntry | null): string[] {
  const issues: string[] = [];
  if (workflow.definition.targets.length !== 1) issues.push('targets');
  for (const role of ['source.snapshot', 'build.docker-buildx', 'artifact.bundle-compose', 'deploy.compose']) {
    const nodes = workflow.definition.nodes.filter((node) => node.type === role);
    if (nodes.length > 1 || (role === 'source.snapshot' && nodes.length !== 1)) {
      issues.push(...(nodes.length ? nodes.map((node) => `nodes/${node.id}`) : [`nodes/${role}`]));
    }
    if (role === 'artifact.bundle-compose') {
      for (const node of nodes) {
        for (const field of ['composeFiles', 'services']) {
          const value = node.config[field];
          if (Array.isArray(value) && value.length !== 1) issues.push(`nodes/${node.id}/config/${field}`);
        }
      }
    }
  }
  if (entry?.environment.workflowId === workflow.id) {
    const projected = associateWorkflowDefaults(entry, workflow).environment.config;
    const saved = entry.environment.config;
    for (const field of ['connectionProfileId', 'remoteRoot', 'templateKind', 'platform', 'dockerfile', 'buildContext', 'projectName', 'service', 'composeFile', 'nonSensitiveFiles', 'hostCompose', 'gitRef', 'verification', 'imageRepository'] as const) {
      if (!equal(projected[field], saved[field])) issues.push(`managedFields/${field}`);
    }
    const mounts = (directories: DeploymentDataDirectory[]): unknown => directories.map(({ hostPath, containerPath, readOnly }) => ({ hostPath, containerPath, readOnly }));
    if (!equal(mounts(projected.dataDirectories), mounts(saved.dataDirectories))) issues.push('managedFields/dataDirectories');
  }
  return issues;
}

export function associateWorkflowDefaults(entry: DeploymentApplicationEntry, workflow: DeploymentWorkflowRecord): DeploymentApplicationEntry {
  const config = { ...entry.environment.config };
  const source = workflow.definition.nodes.find((node) => node.type === 'source.snapshot');
  if (typeof source?.config.sourceRef === 'string' && source.config.sourceRef !== 'workspace') config.gitRef = source.config.sourceRef;
  else delete config.gitRef;
  const target = workflow.definition.targets[0];
  if (target) { config.connectionProfileId = target.connectionProfileId; config.remoteRoot = target.remoteRoot; }
  config.templateKind = workflow.definition.nodes.some((node) => node.type === 'deploy.compose') ? 'dockerCompose' : 'staticSite';
  const image = workflow.definition.nodes.find((node) => node.type === 'build.docker-buildx');
  const bundle = workflow.definition.nodes.find((node) => node.type === 'artifact.bundle-compose');
  if (image) {
    if (config.imageRepository !== undefined && typeof image.config.imageRepository === 'string') config.imageRepository = image.config.imageRepository;
    if (image.config.verification && typeof image.config.verification === 'object') config.verification = image.config.verification as unknown as NonNullable<DeploymentEnvironmentConfig['verification']>;
    else delete config.verification;
    if (typeof image.config.platform === 'string') config.platform = image.config.platform;
    if (typeof image.config.dockerfile === 'string') config.dockerfile = image.config.dockerfile;
    if (typeof image.config.context === 'string') config.buildContext = image.config.context;
  }
  if (bundle) {
    if (bundle.config.hostCompose && typeof bundle.config.hostCompose === 'object') {
      config.hostCompose = bundle.config.hostCompose as unknown as HostComposeConfig;
    } else delete config.hostCompose;
    if (typeof bundle.config.projectName === 'string') config.projectName = bundle.config.projectName;
    if (Array.isArray(bundle.config.services) && typeof bundle.config.services[0] === 'string') config.service = bundle.config.services[0];
    if (Array.isArray(bundle.config.composeFiles) && typeof bundle.config.composeFiles[0] === 'string') config.composeFile = bundle.config.composeFiles[0];
    if (Array.isArray(bundle.config.nonSensitiveFiles)) config.nonSensitiveFiles = bundle.config.nonSensitiveFiles.filter((value): value is string => typeof value === 'string');
    if (Array.isArray(bundle.config.registeredMounts)) {
      config.dataDirectories = bundle.config.registeredMounts.flatMap((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
        const mount = value as Record<string, unknown>;
        if (typeof mount.source !== 'string' || typeof mount.target !== 'string' || typeof mount.readOnly !== 'boolean') return [];
        const existing = entry.environment.config.dataDirectories.find((directory) => directory.hostPath === mount.source && directory.containerPath === mount.target);
        return [{ hostPath: mount.source, containerPath: mount.target, readOnly: mount.readOnly, containerUser: existing?.containerUser ?? '', backupPolicy: existing?.backupPolicy ?? '' }];
      });
    }
  }
  return { ...entry, environment: { ...entry.environment, config } };
}
