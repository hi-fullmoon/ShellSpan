import type { LocaleKey } from '@/locales';
import type {
  DeploymentJsonObject,
  DeploymentNodePortSpec,
  DeploymentNodeRetryPolicy,
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentPortBinding,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowLayout,
  DeploymentWorkflowNode,
  DeploymentWorkflowValidationCode,
  DeploymentWorkflowValidationError,
} from '@/lib/deployment/types';

export type DeploymentWorkflowTemplateKind =
  | 'staticSite'
  | 'dockerCompose'
  | 'prebuiltFiles'
  | 'blank';

export const DEPLOYMENT_FLOW_CONTENT_PADDING = 36;

export interface DeploymentEditorIssue {
  id: string;
  code: DeploymentWorkflowValidationCode | 'LOCAL_MISSING_INPUT' | 'LOCAL_UNKNOWN_NODE';
  messageKey: LocaleKey;
  nodeId?: string;
  path?: string;
  source: 'local' | 'native';
}

export interface DeploymentProjectedEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

interface TemplateTarget {
  connectionProfileId: string;
  remoteRoot: string;
}

type NodeName = (typeName: string) => string;

const retryOnce: DeploymentNodeRetryPolicy = { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 };
const retryRead: DeploymentNodeRetryPolicy = { maxAttempts: 2, initialBackoffSeconds: 2, maxBackoffSeconds: 10 };

function node(
  id: string,
  type: string,
  typeVersion: number,
  inputs: Readonly<Record<string, DeploymentPortBinding>>,
  config: DeploymentJsonObject,
  nameForNode: NodeName,
  timeoutSeconds = 120,
  retry: DeploymentNodeRetryPolicy = retryOnce,
): DeploymentWorkflowNode {
  return {
    id,
    type,
    typeVersion,
    displayName: nameForNode(type),
    inputs,
    config,
    timeoutSeconds,
    retry,
    runWhen: 'allSucceeded',
  };
}

function staticNodes(
  producer: 'build' | 'collect',
  nameForNode: NodeName,
): DeploymentWorkflowNode[] {
  const source = node('source', 'source.snapshot', 1, {}, { sourceRef: 'workspace' }, nameForNode, 60);
  const artifact = producer === 'build'
    ? node(
        'build',
        'build.package-script',
        1,
        { source: { fromNodeId: 'source', fromPort: 'source' } },
        {
          packageManager: 'pnpm',
          workingDirectory: '.',
          installMode: 'frozen',
          scriptName: 'build',
          outputDirectory: 'dist',
          environmentRefs: [],
        },
        nameForNode,
        1_800,
        retryRead,
      )
    : node(
        'collect',
        'artifact.collect',
        1,
        { source: { fromNodeId: 'source', fromPort: 'source' } },
        { kind: 'fileTree', paths: ['dist'] },
        nameForNode,
        300,
        retryRead,
      );
  const artifactId = artifact.id;
  return [
    source,
    artifact,
    node(
      'preflight',
      'target.preflight',
      2,
      { bundle: { fromNodeId: artifactId, fromPort: 'bundle' } },
      { targetId: 'production', requiredCapabilities: ['sftp', 'atomicSymlink', 'http'] },
      nameForNode,
      120,
      retryRead,
    ),
    node(
      'candidate',
      'release.create-candidate',
      1,
      {
        bundle: { fromNodeId: artifactId, fromPort: 'bundle' },
        target: { fromNodeId: 'preflight', fromPort: 'target' },
      },
      { targetId: 'production', strategy: 'staticFiles' },
      nameForNode,
      30,
    ),
    node(
      'approval',
      'control.approval',
      1,
      {
        candidate: { fromNodeId: 'candidate', fromPort: 'candidate' },
        target: { fromNodeId: 'preflight', fromPort: 'target' },
      },
      { targetId: 'production' },
      nameForNode,
      3_600,
    ),
    node(
      'transfer',
      'transfer.sftp',
      2,
      {
        bundle: { fromNodeId: artifactId, fromPort: 'bundle' },
        approval: { fromNodeId: 'approval', fromPort: 'approval' },
      },
      { targetId: 'production' },
      nameForNode,
      1_800,
    ),
    node(
      'prepare',
      'release.prepare-files',
      1,
      { transfer: { fromNodeId: 'transfer', fromPort: 'transfer' } },
      { targetId: 'production' },
      nameForNode,
      600,
    ),
    node(
      'switch',
      'deploy.static-switch',
      1,
      { release: { fromNodeId: 'prepare', fromPort: 'release' } },
      { targetId: 'production', linkName: 'current' },
      nameForNode,
    ),
    node(
      'verify',
      'verify.http',
      2,
      { activation: { fromNodeId: 'switch', fromPort: 'activation' } },
      { targetId: 'production', scheme: 'https', port: 443, path: '/healthz', expectedStatuses: [200] },
      nameForNode,
      120,
      { maxAttempts: 3, initialBackoffSeconds: 2, maxBackoffSeconds: 10 },
    ),
    node(
      'commit',
      'release.commit',
      1,
      { evidence: { fromNodeId: 'verify', fromPort: 'evidence' } },
      { targetId: 'production' },
      nameForNode,
      60,
    ),
  ];
}

function dockerComposeNodes(nameForNode: NodeName): DeploymentWorkflowNode[] {
  return [
    node('source', 'source.snapshot', 1, {}, { sourceRef: 'workspace' }, nameForNode, 60),
    node(
      'image',
      'build.docker-buildx',
      2,
      { source: { fromNodeId: 'source', fromPort: 'source' } },
      { context: '.', dockerfile: 'Dockerfile', platform: 'linux/amd64', imageRepository: 'example/app' },
      nameForNode,
      3_600,
      retryRead,
    ),
    node(
      'bundle',
      'artifact.bundle-compose',
      1,
      {
        imageBundle: { fromNodeId: 'image', fromPort: 'bundle' },
        source: { fromNodeId: 'source', fromPort: 'source' },
      },
      { composeFiles: ['compose.yml'], projectName: 'app', services: [] },
      nameForNode,
      60,
    ),
    node(
      'preflight',
      'target.preflight',
      2,
      { bundle: { fromNodeId: 'bundle', fromPort: 'bundle' } },
      { targetId: 'production', requiredCapabilities: ['sftp', 'docker', 'compose', 'http'] },
      nameForNode,
      120,
      retryRead,
    ),
    node(
      'candidate',
      'release.create-candidate',
      1,
      {
        bundle: { fromNodeId: 'bundle', fromPort: 'bundle' },
        target: { fromNodeId: 'preflight', fromPort: 'target' },
      },
      { targetId: 'production', strategy: 'dockerCompose' },
      nameForNode,
      30,
    ),
    node(
      'approval',
      'control.approval',
      1,
      {
        candidate: { fromNodeId: 'candidate', fromPort: 'candidate' },
        target: { fromNodeId: 'preflight', fromPort: 'target' },
      },
      { targetId: 'production' },
      nameForNode,
      3_600,
    ),
    node(
      'transfer',
      'transfer.sftp',
      2,
      {
        bundle: { fromNodeId: 'bundle', fromPort: 'bundle' },
        approval: { fromNodeId: 'approval', fromPort: 'approval' },
      },
      { targetId: 'production' },
      nameForNode,
      1_800,
    ),
    node(
      'prepare',
      'release.prepare-compose',
      1,
      { transfer: { fromNodeId: 'transfer', fromPort: 'transfer' } },
      { targetId: 'production' },
      nameForNode,
      300,
    ),
    node(
      'load',
      'runtime.load-image',
      1,
      { release: { fromNodeId: 'prepare', fromPort: 'release' } },
      { targetId: 'production' },
      nameForNode,
      900,
    ),
    node(
      'deploy',
      'deploy.compose',
      2,
      { image: { fromNodeId: 'load', fromPort: 'image' } },
      { targetId: 'production', projectName: 'app', services: [], pullPolicy: 'never' },
      nameForNode,
      900,
    ),
    node(
      'verify',
      'verify.http',
      2,
      { activation: { fromNodeId: 'deploy', fromPort: 'activation' } },
      { targetId: 'production', scheme: 'https', port: 443, path: '/healthz', expectedStatuses: [200] },
      nameForNode,
      120,
      { maxAttempts: 3, initialBackoffSeconds: 2, maxBackoffSeconds: 10 },
    ),
    node(
      'commit',
      'release.commit',
      1,
      { evidence: { fromNodeId: 'verify', fromPort: 'evidence' } },
      { targetId: 'production' },
      nameForNode,
      60,
    ),
  ];
}

export function buildDeploymentTemplate(
  kind: DeploymentWorkflowTemplateKind,
  target: TemplateTarget,
  nameForNode: NodeName,
): { definition: DeploymentWorkflowDefinition; layout: DeploymentWorkflowLayout } {
  const nodes = kind === 'dockerCompose'
    ? dockerComposeNodes(nameForNode)
    : kind === 'staticSite'
      ? staticNodes('build', nameForNode)
      : kind === 'prebuiltFiles'
        ? staticNodes('collect', nameForNode)
        : [];
  const definition: DeploymentWorkflowDefinition = {
    schemaVersion: 3,
    targets: [{ id: 'production', ...target }],
    parameters: [],
    nodes,
    outputs: nodes.length > 0
      ? {
          activeRelease: { fromNodeId: 'commit', fromPort: 'activeRelease' },
          verification: { fromNodeId: 'verify', fromPort: 'evidence' },
        }
      : {},
    policy: {
      failFast: true,
      maxParallelLocalNodes: 4,
      releasesToKeep: 5,
      automaticRestore: true,
    },
  };
  const layout: DeploymentWorkflowLayout = {
    schemaVersion: 1,
    nodes: Object.fromEntries(nodes.map((item, index) => [
      item.id,
      {
        x: DEPLOYMENT_FLOW_CONTENT_PADDING + (index % 4) * 280,
        y: DEPLOYMENT_FLOW_CONTENT_PADDING + Math.floor(index / 4) * 190,
      },
    ])),
    groups: [],
  };
  return { definition, layout };
}

export function projectDeploymentEdges(
  definition: DeploymentWorkflowDefinition,
): DeploymentProjectedEdge[] {
  return definition.nodes.flatMap((targetNode) => Object.entries(targetNode.inputs).map(
    ([targetPort, binding]) => ({
      id: `${binding.fromNodeId}:${binding.fromPort}->${targetNode.id}:${targetPort}`,
      sourceNodeId: binding.fromNodeId,
      sourcePort: binding.fromPort,
      targetNodeId: targetNode.id,
      targetPort,
    }),
  ));
}

function artifactPortsCompatible(
  input: DeploymentNodePortSpec,
  output: DeploymentNodePortSpec,
): boolean {
  if (input.portType !== 'artifact.bundle') return true;
  const accepted = input.artifactTypes ?? [];
  const produced = output.artifactTypes ?? [];
  return accepted.length === 0 || produced.length === 0
    ? true
    : accepted.some((value) => produced.includes(value));
}

export function compatibleOutputBindings(
  definition: DeploymentWorkflowDefinition,
  catalog: DeploymentNodeTypeCatalog,
  targetNodeId: string,
  targetPortName: string,
): Array<{ binding: DeploymentPortBinding; node: DeploymentWorkflowNode; port: DeploymentNodePortSpec }> {
  const targetNode = definition.nodes.find((item) => item.id === targetNodeId);
  const targetSpec = targetNode
    ? catalog.nodes.find((item) => item.typeName === targetNode.type && item.typeVersion === targetNode.typeVersion)
    : undefined;
  const input = targetSpec?.inputs.find((item) => item.name === targetPortName);
  if (!input) return [];
  return definition.nodes.flatMap((candidate) => {
    if (candidate.id === targetNodeId) return [];
    const spec = catalog.nodes.find(
      (item) => item.typeName === candidate.type && item.typeVersion === candidate.typeVersion,
    );
    if (!spec) return [];
    return spec.outputs
      .filter((output) => output.portType === input.portType && artifactPortsCompatible(input, output))
      .map((output) => ({
        binding: { fromNodeId: candidate.id, fromPort: output.name },
        node: candidate,
        port: output,
      }));
  });
}

export function localDeploymentEditorIssues(
  definition: DeploymentWorkflowDefinition,
  catalog: DeploymentNodeTypeCatalog | null,
): DeploymentEditorIssue[] {
  const issues: DeploymentEditorIssue[] = [];
  if (!definition.nodes.some((node) => node.type.startsWith('build.') || node.type.startsWith('artifact.'))) {
    issues.push({
      id: 'workflow:missing-artifact-producer',
      code: 'MISSING_ARTIFACT_PRODUCER',
      messageKey: 'deployment.editor.validation.missingArtifactProducer',
      source: 'local',
    });
  }
  if (!definition.nodes.some((node) => node.type === 'control.approval')) {
    issues.push({
      id: 'workflow:missing-approval',
      code: 'MISSING_APPROVAL',
      messageKey: 'deployment.editor.validation.missingApproval',
      source: 'local',
    });
  }
  if (!definition.nodes.some((node) => node.type.startsWith('deploy.'))) {
    issues.push({
      id: 'workflow:missing-deployment',
      code: 'MISSING_DEPLOYMENT',
      messageKey: 'deployment.editor.validation.missingDeployment',
      source: 'local',
    });
  }
  if (!definition.nodes.some((node) => node.type.startsWith('verify.'))) {
    issues.push({
      id: 'workflow:missing-verification',
      code: 'MISSING_VERIFICATION',
      messageKey: 'deployment.editor.validation.missingVerification',
      source: 'local',
    });
  }
  if (!catalog) return issues;
  for (const workflowNode of definition.nodes) {
    const spec = catalog.nodes.find(
      (item) => item.typeName === workflowNode.type && item.typeVersion === workflowNode.typeVersion,
    );
    if (!spec) {
      issues.push({
        id: `unknown:${workflowNode.id}`,
        code: 'LOCAL_UNKNOWN_NODE',
        messageKey: 'deployment.editor.validation.localUnknownNode',
        nodeId: workflowNode.id,
        source: 'local',
      });
      continue;
    }
    issues.push(...spec.inputs
      .filter((input) => input.required && !workflowNode.inputs[input.name])
      .map((input) => ({
        id: `missing:${workflowNode.id}:${input.name}`,
        code: 'LOCAL_MISSING_INPUT' as const,
        messageKey: 'deployment.editor.validation.localMissingInput' as LocaleKey,
        nodeId: workflowNode.id,
        path: `nodes.${workflowNode.id}.inputs.${input.name}`,
        source: 'local' as const,
      })));
  }
  return issues;
}

const VALIDATION_KEYS: Partial<Record<DeploymentWorkflowValidationCode, LocaleKey>> = {
  CYCLE_DETECTED: 'deployment.editor.validation.cycle',
  PORT_TYPE_MISMATCH: 'deployment.editor.validation.portType',
  ARTIFACT_TYPE_MISMATCH: 'deployment.editor.validation.artifactType',
  MISSING_INPUT: 'deployment.editor.validation.missingInput',
  MISSING_ARTIFACT_PRODUCER: 'deployment.editor.validation.missingArtifactProducer',
  MISSING_APPROVAL: 'deployment.editor.validation.missingApproval',
  APPROVAL_BYPASS: 'deployment.editor.validation.approvalBypass',
  MISSING_DEPLOYMENT: 'deployment.editor.validation.missingDeployment',
  MISSING_VERIFICATION: 'deployment.editor.validation.missingVerification',
  INVALID_NODE_CONFIG: 'deployment.editor.validation.invalidConfig',
  UNKNOWN_NODE_TYPE: 'deployment.editor.validation.unknownNode',
};

export function mapNativeValidationErrors(
  errors: readonly DeploymentWorkflowValidationError[],
): DeploymentEditorIssue[] {
  return errors.map((error, index) => ({
    id: `native:${error.code}:${error.nodeId ?? 'workflow'}:${error.path ?? index}`,
    code: error.code,
    messageKey: VALIDATION_KEYS[error.code] ?? 'deployment.editor.validation.generic',
    nodeId: error.nodeId,
    path: error.path,
    source: 'native',
  }));
}

export function topologyOrder(definition: DeploymentWorkflowDefinition): DeploymentWorkflowNode[] {
  const nodes = new Map(definition.nodes.map((item) => [item.id, item]));
  const incoming = new Map(definition.nodes.map((item) => [item.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of projectDeploymentEdges(definition)) {
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) continue;
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
  }
  const ready = definition.nodes.filter((item) => incoming.get(item.id) === 0).map((item) => item.id);
  const ordered: DeploymentWorkflowNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    const current = nodes.get(id);
    if (current) ordered.push(current);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  const seen = new Set(ordered.map((item) => item.id));
  return [...ordered, ...definition.nodes.filter((item) => !seen.has(item.id))];
}

export function createNodeFromCatalog(
  spec: DeploymentNodeTypeSpec,
  existingNodes: readonly DeploymentWorkflowNode[],
  displayName: string,
): DeploymentWorkflowNode {
  const stem = spec.typeName.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node';
  let id = stem;
  let suffix = 2;
  while (existingNodes.some((item) => item.id === id)) {
    id = `${stem}-${suffix}`;
    suffix += 1;
  }
  return {
    id,
    type: spec.typeName,
    typeVersion: spec.typeVersion,
    displayName,
    inputs: {},
    config: structuredClone(spec.defaultConfig),
    timeoutSeconds: spec.effectClass === 'control' ? 3_600 : 120,
    retry: retryOnce,
    runWhen: spec.effectClass === 'finalizer' ? 'always' : 'allSucceeded',
  };
}
