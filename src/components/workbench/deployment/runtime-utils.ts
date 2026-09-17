import type {
  DeploymentJsonValue,
  DeploymentRunNodeRecord,
  DeploymentRunNodeStatus,
  DeploymentRunStatus,
} from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';

export type DeploymentTranslate = (
  key: LocaleKey,
  values?: Record<string, string | number>,
) => string;

export function deploymentRuntimeKey(value: string): LocaleKey {
  return value as LocaleKey;
}

export function formatDeploymentDate(value: number | null | undefined): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
    : '—';
}

export function formatDeploymentDuration(
  startedAt: number | null | undefined,
  finishedAt: number | null | undefined,
): string {
  if (!startedAt) return '—';
  const duration = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  if (duration < 1_000) return `${duration} ms`;
  if (duration < 60_000) return `${Math.round(duration / 1_000)} s`;
  return `${Math.round(duration / 60_000)} min`;
}

export function formatDeploymentBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}

export function shortDeploymentDigest(value: string): string {
  return value.length > 24 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value;
}

export function deploymentStatusBadgeVariant(
  status: DeploymentRunStatus | DeploymentRunNodeStatus | string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'succeeded' || status === 'compensated') return 'default';
  if (status === 'failed' || status === 'state_unknown') return 'destructive';
  if (
    status === 'in_progress'
    || status === 'running'
    || status === 'verifying'
    || status === 'reconciling'
  ) return 'secondary';
  return 'outline';
}

export function deploymentStatusLabel(status: string, t: DeploymentTranslate): string {
  return t(deploymentRuntimeKey(`deployment.runtime.status.${status}`));
}

export function deploymentEventLabel(summaryKey: string, t: DeploymentTranslate): string {
  return t(deploymentRuntimeKey(summaryKey));
}

export function deploymentJsonObject(
  value: DeploymentJsonValue | undefined,
): Readonly<Record<string, DeploymentJsonValue>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, DeploymentJsonValue>>
    : null;
}

export function deploymentNodeProgress(node: DeploymentRunNodeRecord): {
  percent: number;
  valueLabel: string;
} {
  const summary = deploymentJsonObject(node.outputSummary);
  const bytes = summary && typeof summary.bytes === 'number' ? summary.bytes : null;
  const percent = bytes !== null || node.status === 'succeeded' || node.status === 'compensated'
    ? 100
    : node.status === 'running'
      ? 50
      : 0;
  return {
    percent,
    valueLabel: bytes !== null ? formatDeploymentBytes(bytes) : `${percent}%`,
  };
}
