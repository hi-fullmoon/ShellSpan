import React from 'react';
import ReactDOM from 'react-dom/client';
import { DeploymentWorkflowCenter } from '@/components/workbench/deployment-workflow-center';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { buildDeploymentTemplate } from '@/lib/deployment/editor';
import type {
  DeploymentEffectClass,
  DeploymentNodeCategory,
  DeploymentNodeTypeCatalog,
  DeploymentPortType,
  DeploymentApprovalSummary,
  DeploymentArtifactInspection,
  DeploymentRunNodeRecord,
  DeploymentRunSummary,
  DeploymentWorkflowNode,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { initI18n, t, type LocaleKey } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useProfileStore } from '@/stores/profileStore';

const profile = {
  id: 'visual-profile', name: 'Production', host: 'web-01.example.test', port: 22,
  username: 'deploy', authMethod: 'password' as const, createdAt: 1, updatedAt: 1,
};

const VISUAL_SCENARIOS = ['wide', 'medium', 'narrow', 'ai'] as const;
const VISUAL_VIEWS = ['design', 'prepare', 'runs', 'versions'] as const;
const VISUAL_OVERLAYS = ['approval', 'artifact', 'evidence', 'rollback'] as const;

type VisualScenario = typeof VISUAL_SCENARIOS[number];
type VisualView = typeof VISUAL_VIEWS[number];
type VisualOverlay = typeof VISUAL_OVERLAYS[number];

export const DEPLOYMENT_VISUAL_SCENARIO_WIDTHS: Readonly<Record<VisualScenario, number>> = {
  wide: 1_420,
  medium: 860,
  narrow: 430,
  ai: 780,
};

function supportedValue<const T extends readonly string[]>(
  value: string | null,
  supported: T,
  fallback: T[number],
): T[number] {
  return value && supported.includes(value) ? value as T[number] : fallback;
}

function optionalSupportedValue<const T extends readonly string[]>(
  value: string | null,
  supported: T,
): T[number] | null {
  return value && supported.includes(value) ? value as T[number] : null;
}

const OVERLAY_TRIGGER_TEST_IDS: Partial<Record<VisualOverlay, string>> = {
  approval: 'deployment-open-approval',
  evidence: 'deployment-open-evidence',
  rollback: 'deployment-open-rollback',
};

const VisualOverlayOpener: React.FC<{ overlay: VisualOverlay | null }> = ({ overlay }) => {
  React.useEffect(() => {
    const triggerTestId = overlay ? OVERLAY_TRIGGER_TEST_IDS[overlay] : undefined;
    if (!triggerTestId) return undefined;
    let nestedFrame: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      if (trigger) {
        trigger.click();
        return;
      }
      if (overlay === 'evidence') {
        document.querySelector<HTMLElement>('[data-testid="deployment-open-runtime-inspector"]')?.click();
        nestedFrame = window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`)?.click();
        });
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (nestedFrame !== null) window.cancelAnimationFrame(nestedFrame);
    };
  }, [overlay]);
  return null;
};

const PORTS: Record<string, {
  inputs: Array<[string, DeploymentPortType]>;
  outputs: Array<[string, DeploymentPortType]>;
  effect: DeploymentEffectClass;
}> = {
  'source.snapshot': { inputs: [], outputs: [['source', 'source.snapshot']], effect: 'localRead' },
  'build.package-script': { inputs: [['source', 'source.snapshot']], outputs: [['bundle', 'artifact.bundle']], effect: 'localBuild' },
  'target.preflight': { inputs: [['bundle', 'artifact.bundle']], outputs: [['target', 'target.snapshot']], effect: 'remoteRead' },
  'release.create-candidate': { inputs: [['bundle', 'artifact.bundle'], ['target', 'target.snapshot']], outputs: [['candidate', 'release.candidate']], effect: 'pure' },
  'control.approval': { inputs: [['candidate', 'release.candidate'], ['target', 'target.snapshot']], outputs: [['approval', 'control.approval']], effect: 'control' },
  'transfer.sftp': { inputs: [['bundle', 'artifact.bundle'], ['approval', 'control.approval']], outputs: [['transfer', 'transfer.receipt']], effect: 'remoteWrite' },
  'release.prepare-files': { inputs: [['transfer', 'transfer.receipt']], outputs: [['release', 'release.receipt']], effect: 'remoteWrite' },
  'deploy.static-switch': { inputs: [['release', 'release.receipt']], outputs: [['activation', 'activation.receipt']], effect: 'trafficSwitch' },
  'verify.http': { inputs: [['activation', 'activation.receipt']], outputs: [['evidence', 'verification.evidence']], effect: 'remoteRead' },
  'release.commit': { inputs: [['evidence', 'verification.evidence']], outputs: [['activeRelease', 'release.receipt']], effect: 'trafficSwitch' },
};

function category(typeName: string): DeploymentNodeCategory {
  const value = typeName.split('.')[0];
  return (value === 'build' || value === 'target' || value === 'release' || value === 'control'
    || value === 'transfer' || value === 'deploy' || value === 'verify')
    ? value
    : 'source';
}

function visualCatalog(nodes: readonly DeploymentWorkflowNode[]): DeploymentNodeTypeCatalog {
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => {
      const ports = PORTS[node.type];
      const key = node.type.replace(/[.-]/g, '_');
      return {
        typeName: node.type,
        typeVersion: node.typeVersion,
        displayNameKey: `deployment.node.${key}.name`,
        descriptionKey: `deployment.node.${key}.description`,
        category: category(node.type),
        inputs: (ports?.inputs ?? []).map(([name, portType]) => ({ name, portType, required: true })),
        outputs: (ports?.outputs ?? []).map(([name, portType]) => ({ name, portType, required: false })),
        executionDomain: ports?.effect.startsWith('remote') || ports?.effect === 'trafficSwitch' ? 'target' : 'local',
        effectClass: ports?.effect ?? 'pure',
        capabilities: [],
        configSchemaVersion: 1,
        configSchema: { schemaVersion: 1, fields: [] },
        defaultConfig: node.config,
        riskLevel: ports?.effect === 'trafficSwitch' ? 'high' : 'low',
        fixedActions: ['visual_fixture'],
        retryable: false,
      };
    }),
  };
}

export async function mountDeploymentWorkflowPage(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const locale = params.get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
  const scenario = supportedValue(params.get('scenario'), VISUAL_SCENARIOS, 'wide');
  const initialTab = supportedValue(params.get('view'), VISUAL_VIEWS, 'design');
  const overlay = optionalSupportedValue(params.get('overlay'), VISUAL_OVERLAYS);
  useAppStore.setState({ locale });
  await initI18n(locale);
  const { definition, layout } = buildDeploymentTemplate(
    'staticSite',
    { connectionProfileId: profile.id, remoteRoot: '/srv/www/acme' },
    (typeName) => t(`deployment.node.${typeName.replace(/[.-]/g, '_')}.name` as LocaleKey),
  );
  const workflow: DeploymentWorkflowRecord = {
    id: 'visual-workflow', name: locale === 'zh-CN' ? '官网生产发布' : 'Production website',
    enabled: false, archived: false, revision: 7,
    definitionDigest: `sha256:${'a'.repeat(64)}`, definition,
    layoutRevision: 12, layout, createdAt: 1, updatedAt: 2,
  };
  useProfileStore.setState({ profiles: [profile] });
  useDeploymentWorkflowStore.setState({
    capabilities: {
      schemaVersion: 1, admissionsEnabled: true, defaultEnabled: false,
      flagName: 'SHELLSPAN_DEPLOYMENT_WORKFLOW', source: 'environment',
      readOnlyAvailable: true, cancelRecoveryAuditAvailable: true, coordinatorAvailable: true,
    },
    catalog: visualCatalog(definition.nodes),
    workflows: [workflow],
    selectedWorkflowId: workflow.id,
    selectedNodeId: 'build',
    draft: {
      id: workflow.id, name: workflow.name, enabled: workflow.enabled,
      revision: workflow.revision, layoutRevision: workflow.layoutRevision,
      definition: structuredClone(definition), layout: structuredClone(layout),
    },
    initialized: true,
    loading: false,
    semanticDirty: false,
    layoutDirty: false,
    issues: [],
  });
  const planDigest = `sha256:${'b'.repeat(64)}` as const;
  const contentDigest = `sha256:${'c'.repeat(64)}` as const;
  const manifestDigest = `sha256:${'d'.repeat(64)}` as const;
  const artifactReference = `deployment-artifact:${manifestDigest}` as const;
  const runSummary: DeploymentRunSummary = {
    runId: 'run-visual-7', workflowId: workflow.id, workflowRevision: workflow.revision,
    operationKind: 'deploy', triggerKind: 'manual', status: initialTab === 'prepare' ? 'awaiting_approval' : 'succeeded',
    planDigest,
    targetRelease: { releaseId: 'release-c0ffee42', artifactContentDigest: contentDigest, layoutDigest: `sha256:${'e'.repeat(64)}` as const },
    artifactReferences: [artifactReference], expiresAt: Date.now() + 900_000,
    expired: false, planDrifted: false, createdAt: Date.now() - 82_000,
    updatedAt: Date.now() - 2_000, startedAt: Date.now() - 80_000,
    finishedAt: initialTab === 'prepare' ? null : Date.now() - 2_000,
  };
  const runNodes: DeploymentRunNodeRecord[] = definition.nodes.map((node, index): DeploymentRunNodeRecord => ({
    runId: runSummary.runId, nodeId: node.id, nodeType: node.type,
    nodeTypeVersion: node.typeVersion, status: 'succeeded' as const, lastAttempt: 1,
    outputSummary: index === 1 ? { bytes: 2_621_440 } : { completed: true },
    startedAt: Date.now() - 80_000 + index * 6_000,
    finishedAt: Date.now() - 76_000 + index * 6_000,
    updatedAt: Date.now() - 2_000,
  }));
  const approvalSummary: DeploymentApprovalSummary = {
    schemaVersion: 1, workflowId: workflow.id, workflowRevision: workflow.revision,
    definitionDigest: workflow.definitionDigest, runId: runSummary.runId,
    operationKind: 'deploy', triggerKind: 'manual', parameters: {}, planDigest,
    preparedAt: Date.now() - 10_000, expiresAt: runSummary.expiresAt,
    source: { sourceRef: 'workspace', revision: 'c0ffee42', dirty: false, snapshotDigest: `sha256:${'1'.repeat(64)}`, metadataDigest: `sha256:${'2'.repeat(64)}` },
    target: { targetId: 'production', connectionProfileId: profile.id, profileRevision: 1, hostIdentityDigest: `sha256:${'3'.repeat(64)}`, remoteRoot: '/srv/www/acme', capabilitiesDigest: `sha256:${'4'.repeat(64)}` },
    preflight: { capabilities: { ssh: true, sftp: true, atomicSymlink: true } },
    artifacts: [{
      handle: { artifactReference, manifestDigest, contentDigest },
      artifactType: 'application/vnd.shellspan.file-tree',
      components: [{ name: 'site.tar.zst', role: 'application', mediaType: 'application/vnd.shellspan.file-tree.tar+zstd', digest: `sha256:${'5'.repeat(64)}`, size: 2_621_440, annotations: {} }],
      componentCount: 1, totalSize: 2_621_440,
    }],
    currentRelease: { releaseId: 'release-a11ce123', artifactContentDigest: `sha256:${'6'.repeat(64)}`, layoutDigest: `sha256:${'7'.repeat(64)}` },
    previousRelease: { releaseId: 'release-a11ce123', artifactContentDigest: `sha256:${'6'.repeat(64)}`, layoutDigest: `sha256:${'7'.repeat(64)}` },
    targetRelease: runSummary.targetRelease,
    effects: definition.nodes.filter((node) => ['transfer.sftp', 'release.prepare-files', 'deploy.static-switch', 'release.commit'].includes(node.type)).map((node) => ({ nodeId: node.id, displayName: node.displayName, effectClass: node.type === 'deploy.static-switch' || node.type === 'release.commit' ? 'trafficSwitch' : 'remoteWrite', fixedActions: ['fixed_native_action'] })),
    risks: { highestLevel: 'high', entries: [] },
    compensations: [{ nodeId: 'switch', compensationKind: 'restore_previous_release', fixedActions: ['restore_current_link'] }],
    verificationNodes: ['verify'], retention: 3,
  };
  const artifactInspection: DeploymentArtifactInspection = {
    handle: { artifactReference, manifestDigest, contentDigest },
    manifest: {
      schemaVersion: 2, artifactType: 'application/vnd.shellspan.file-tree',
      source: { revision: 'c0ffee42', dirty: false, snapshotDigest: `sha256:${'1'.repeat(64)}` },
      components: Array.from({ length: 12 }, (_, index) => ({ name: `assets/chunk-${index + 1}.js`, role: 'application' as const, mediaType: 'text/javascript', digest: `sha256:${String(index + 1).padStart(64, '0')}`, size: 218_000 + index, annotations: {} })),
      producer: { nodeType: 'build.package-script', nodeTypeVersion: 1, configDigest: `sha256:${'8'.repeat(64)}` }, annotations: {},
    },
    componentCount: 12, totalSize: 2_621_440,
    retention: { referenceCount: 3, leaseCount: 1, currentRelease: true, previousRelease: false, retainedUntil: Date.now() + 86_400_000, protected: true },
    references: [{ workflowId: workflow.id, runId: runSummary.runId, nodeId: definition.nodes[1].id, referenceKind: 'release_current', ownerId: runSummary.targetRelease.releaseId, leaseActive: true, retainUntil: Date.now() + 86_400_000, createdAt: Date.now() - 2_000 }],
  };
  useDeploymentWorkflowRunStore.setState({
    workflowId: workflow.id,
    runs: [runSummary],
    nextRunCursor: null,
    selectedRunId: runSummary.runId,
    detail: {
      summary: runSummary,
      approvalSummary: initialTab === 'prepare' ? approvalSummary : null,
      outputs: [{
        nodeId: definition.nodes[1].id,
        outputName: 'bundle',
        outputKind: 'artifact',
        value: { artifactReference, manifestDigest, contentDigest },
        artifactReference,
        createdAt: Date.now() - 70_000,
      }],
      receipts: [],
    },
    nodes: runNodes,
    events: runNodes.slice().reverse().map((node, index) => ({
      runId: runSummary.runId,
      sequence: runNodes.length - index,
      nodeId: node.nodeId,
      attempt: 1,
      eventKind: 'node_succeeded',
      status: 'succeeded',
      summaryKey: 'deployment.node.succeeded',
      payload: null,
      recordedAt: node.finishedAt ?? Date.now(),
    })),
    nextEventSequence: null,
    selectedNodeId: definition.nodes[1].id,
    attempts: [{
      schemaVersion: 1, runId: runSummary.runId, nodeId: definition.nodes[1].id,
      attempt: 1, nodeType: definition.nodes[1].type, nodeTypeVersion: definition.nodes[1].typeVersion,
      executorVersion: 'native-static', idempotencyKey: 'visual-attempt', status: 'succeeded',
      startedAt: Date.now() - 74_000, finishedAt: Date.now() - 68_000,
      createdAt: Date.now() - 74_000, updatedAt: Date.now() - 68_000,
    }],
    releases: [
      {
        workflowId: workflow.id, releaseId: 'release-c0ffee42', position: 'current', artifactReference,
        manifestDigest, contentDigest, artifactType: 'application/vnd.shellspan.file-tree',
        identity: runSummary.targetRelease, sourceRunId: runSummary.runId,
        activatedAt: runSummary.finishedAt, rollbackable: false,
      },
      {
        workflowId: workflow.id, releaseId: 'release-a11ce123', position: 'previous', artifactReference,
        manifestDigest, contentDigest, artifactType: 'application/vnd.shellspan.file-tree',
        identity: { ...runSummary.targetRelease, releaseId: 'release-a11ce123' },
        sourceRunId: 'run-visual-6', activatedAt: Date.now() - 86_400_000, rollbackable: true,
      },
    ],
    artifact: overlay === 'artifact' ? artifactInspection : null,
  });

  const width = DEPLOYMENT_VISUAL_SCENARIO_WIDTHS[scenario];
  ReactDOM.createRoot(root).render(
    <div
      className="flex h-screen bg-app-bg p-3"
      data-testid="deployment-visual-fixture"
      data-scenario={scenario}
      data-view={initialTab}
      data-overlay={overlay ?? 'none'}
      data-locale={locale}
    >
      <div
        className="min-w-0 overflow-hidden rounded-xl border bg-background"
        style={{ width }}
        data-testid="deployment-visual-workbench"
      >
        <DeploymentWorkflowCenter initialTab={initialTab} />
        <VisualOverlayOpener overlay={overlay} />
      </div>
      {scenario === 'ai' && (
        <Card
          className="ml-3 min-w-0 flex-1"
          size="sm"
          variant="outline"
          radius="compact"
          data-testid="deployment-visual-ai-panel"
        >
          <CardHeader><CardTitle>{locale === 'zh-CN' ? 'AI 助手' : 'AI assistant'}</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">{locale === 'zh-CN' ? '工作台被 AI 面板动态压窄。' : 'The AI panel narrows the workbench container.'}</CardContent>
        </Card>
      )}
    </div>,
  );
}
