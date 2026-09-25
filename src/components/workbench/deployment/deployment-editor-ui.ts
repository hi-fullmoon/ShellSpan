import type {
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentWorkflowNode,
} from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';

export type DeploymentEditorTranslate = (
  key: LocaleKey,
  values?: Record<string, string | number>,
) => string;

export const DEPLOYMENT_NONE_VALUE = '__none__';

export function deploymentLocaleKey(value: string): LocaleKey {
  return value as LocaleKey;
}

export function readableDeploymentProfile(profile: {
  username: string;
  host: string;
}): string {
  return `${profile.username}@${profile.host}`;
}

export function readableDeploymentTarget(
  remoteRoot: string,
  profile?: { username: string; host: string },
): string {
  return profile ? `${profile.username}@${profile.host} · ${remoteRoot}` : remoteRoot;
}

export function findDeploymentNodeSpec(
  catalog: DeploymentNodeTypeCatalog | null,
  node: DeploymentWorkflowNode,
): DeploymentNodeTypeSpec | undefined {
  return catalog?.nodes.find(
    (item) => item.typeName === node.type && item.typeVersion === node.typeVersion,
  );
}

export function deploymentPortLabel(
  name: string,
  t: DeploymentEditorTranslate,
): string {
  return t(deploymentLocaleKey(`deployment.editor.port.${name}`));
}

export function deploymentPortTypeLabel(
  value: string,
  t: DeploymentEditorTranslate,
): string {
  return t(deploymentLocaleKey(`deployment.editor.portType.${value}`));
}
