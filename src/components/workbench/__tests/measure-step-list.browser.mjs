import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'deployment-measure',
    resolveId(id) {
      if (id === '/deployment-runtime.js') return id;
    },
    load(id) {
      if (id === '/deployment-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { DeploymentWorkflowCenter } from '/src/components/workbench/deployment-workflow-center.tsx';
        export { useProfileStore } from '/src/stores/profileStore.ts';
        export { useDeploymentWorkflowStore } from '/src/stores/deploymentWorkflowStore.ts';
        export { useDeploymentWorkflowRunStore } from '/src/stores/deploymentWorkflowRunStore.ts';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><html><head><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div></body></html>`);
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});

const digest = (character) => `sha256:${character.repeat(64)}`;

const fixtures = {
  profile: {
    id: 'profile-1', name: 'Production', host: 'example.test', port: 22,
    username: 'deploy', authMethod: 'password', createdAt: 1, updatedAt: 1,
  },
  catalog: {
    schemaVersion: 1,
    nodes: [
      {
        typeName: 'source.snapshot', typeVersion: 1,
        displayNameKey: 'deployment.node.source_snapshot.name',
        descriptionKey: 'deployment.node.source_snapshot.description', category: 'source',
        inputs: [], outputs: [{ name: 'source', portType: 'source.snapshot', required: false }],
        executionDomain: 'local', effectClass: 'localRead', capabilities: ['sourceSnapshot'],
        configSchemaVersion: 1,
        configSchema: {
          schemaVersion: 1,
          fields: [{
            name: 'sourceRef', labelKey: 'deployment.editor.config.sourceRef.label',
            descriptionKey: 'deployment.editor.config.sourceRef.description', kind: 'string', required: true,
          }],
        },
        defaultConfig: { sourceRef: 'workspace' }, riskLevel: 'low',
        fixedActions: ['freeze_source_snapshot'], retryable: true,
      },
      {
        typeName: 'build.package-script', typeVersion: 1,
        displayNameKey: 'deployment.node.build_package_script.name',
        descriptionKey: 'deployment.node.build_package_script.description', category: 'build',
        inputs: [{ name: 'source', portType: 'source.snapshot', required: true }],
        outputs: [{ name: 'bundle', portType: 'artifact.bundle', required: false, artifactTypes: ['application/vnd.shellspan.file-tree'] }],
        executionDomain: 'local', effectClass: 'localBuild', capabilities: ['packageManager'],
        configSchemaVersion: 1,
        configSchema: {
          schemaVersion: 1,
          fields: [{
            name: 'packageManager', labelKey: 'deployment.editor.config.packageManager.label',
            descriptionKey: 'deployment.editor.config.packageManager.description', kind: 'select', required: true,
            options: [
              { value: 'pnpm', labelKey: 'deployment.editor.option.packageManager.pnpm' },
              { value: 'npm', labelKey: 'deployment.editor.option.packageManager.npm' },
            ],
          }],
        },
        defaultConfig: { packageManager: 'pnpm' }, riskLevel: 'medium',
        fixedActions: ['run_fixed_package_manager_script'], retryable: true,
      },
    ],
  },
  definition: {
    schemaVersion: 3,
    targets: [{ id: 'production', connectionProfileId: 'profile-1', remoteRoot: '/srv/site' }],
    parameters: [],
    nodes: [
      {
        id: 'source', type: 'source.snapshot', typeVersion: 1, displayName: 'Freeze source',
        inputs: {}, config: { sourceRef: 'workspace' }, timeoutSeconds: 60,
        retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded',
      },
      {
        id: 'build', type: 'build.package-script', typeVersion: 1, displayName: 'Build site',
        inputs: { source: { fromNodeId: 'source', fromPort: 'source' } },
        config: { packageManager: 'pnpm' }, timeoutSeconds: 120,
        retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded',
      },
    ],
    outputs: {},
    policy: { failFast: true, maxParallelLocalNodes: 2, releasesToKeep: 3, automaticRestore: true },
  },
};

fixtures.workflow = {
  id: 'workflow-1', name: 'Website', enabled: true, archived: false,
  revision: 3, definitionDigest: digest('a'), definition: fixtures.definition,
  layoutRevision: 2, layout: { schemaVersion: 1, nodes: { source: { x: 24, y: 24 }, build: { x: 340, y: 180 } }, edges: [] },
  createdAt: 1, updatedAt: 2,
};

let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async (seed) => {
    await import('/src/styles/base.css');
    const { React, createRoot, DeploymentWorkflowCenter, useProfileStore, useDeploymentWorkflowStore, useDeploymentWorkflowRunStore } = await import('/deployment-runtime.js');
    useDeploymentWorkflowRunStore.getState().reset();
    useDeploymentWorkflowStore.getState().reset();
    useProfileStore.setState({ profiles: [seed.profile] });
    useDeploymentWorkflowStore.setState({
      capabilities: {
        schemaVersion: 1, admissionsEnabled: true, defaultEnabled: true,
        flagName: 'SHELLSPAN_DEPLOYMENT_WORKFLOW', source: 'environment',
        readOnlyAvailable: true, cancelRecoveryAuditAvailable: true, coordinatorAvailable: true,
      },
      catalog: seed.catalog,
      workflows: [seed.workflow],
      selectedWorkflowId: seed.workflow.id,
      selectedNodeId: 'source',
      draft: {
        id: seed.workflow.id, name: seed.workflow.name, enabled: seed.workflow.enabled,
        revision: seed.workflow.revision, layoutRevision: seed.workflow.layoutRevision,
        definition: seed.workflow.definition, layout: seed.workflow.layout,
      },
      initialized: true,
    });
    createRoot(document.getElementById('root')).render(
      React.createElement(DeploymentWorkflowCenter, { initialTab: 'pipeline' }),
    );
  }, fixtures);

  await page.waitForSelector('[data-testid="deployment-step-list"]');
  await page.waitForTimeout(300);

  const report = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="deployment-step-list"]');
    const section = list.parentElement?.closest('section');
    const header = section?.querySelector('[data-slot="deployment-pane-header"]');
    const content = list.querySelector('[data-slot="scroll-area-viewport"]')?.firstElementChild;
    const rows = [...list.querySelectorAll('[data-step-node-id]')];
    const cards = rows.map((row) => row.querySelector('button'));
    const box = (el) => (el ? el.getBoundingClientRect() : null);
    const headerBox = box(header);
    const rowBoxes = rows.map(box);
    const cardBoxes = cards.map(box);
    const contentBox = box(content);
    return {
      header: headerBox && { bottom: headerBox.bottom, height: headerBox.height },
      content: contentBox && { top: contentBox.top, paddingTop: getComputedStyle(content).paddingTop },
      rows: rowBoxes.map((r) => ({ top: r.top, bottom: r.bottom, height: r.height })),
      cards: cardBoxes.map((b) => ({ top: b.top, bottom: b.bottom, height: b.height })),
      topInset: cardBoxes[0] ? cardBoxes[0].top - headerBox.bottom : null,
      interCardGap: cardBoxes[1] ? cardBoxes[1].top - cardBoxes[0].bottom : null,
    };
  });

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`measure failed: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
