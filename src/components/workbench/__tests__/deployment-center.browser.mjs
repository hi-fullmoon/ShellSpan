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
    name: 'deployment-center-density',
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

fixtures.runSummary = {
  runId: 'run-1', workflowId: 'workflow-1', workflowRevision: 3,
  operationKind: 'deploy', triggerKind: 'manual', status: 'succeeded',
  planDigest: digest('b'),
  targetRelease: { releaseId: 'release-next', artifactContentDigest: digest('c'), layoutDigest: digest('d') },
  artifactReferences: [], expiresAt: Date.now() + 60_000, expired: false, planDrifted: false,
  createdAt: 1, updatedAt: 2, startedAt: 10, finishedAt: 30,
};

fixtures.runDetail = { summary: fixtures.runSummary, approvalSummary: null, outputs: [], receipts: [] };

let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async (seed) => {
    await import('/src/styles/base.css');
    const { React, createRoot, DeploymentWorkflowCenter, useProfileStore, useDeploymentWorkflowStore, useDeploymentWorkflowRunStore } = await import('/deployment-runtime.js');
    useDeploymentWorkflowRunStore.getState().reset();
    useDeploymentWorkflowStore.getState().reset();
    useDeploymentWorkflowRunStore.setState({ workflowId: seed.workflow.id });
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
      selectedNodeId: 'build',
      draft: {
        id: seed.workflow.id, name: seed.workflow.name, enabled: seed.workflow.enabled,
        revision: seed.workflow.revision, layoutRevision: seed.workflow.layoutRevision,
        definition: seed.workflow.definition, layout: seed.workflow.layout,
      },
      initialized: true,
    });
    window.__seedRunStore = (state) => useDeploymentWorkflowRunStore.setState(state);
    createRoot(document.getElementById('root')).render(
      React.createElement(DeploymentWorkflowCenter, { initialTab: 'runs' }),
    );
  }, fixtures);

  const centeringOf = (selector, containerSelector, region) => page.evaluate(({
    emptySelector, containerSelector: containerSel, regionMode,
  }) => {
    const centerOf = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    const empty = document.querySelector(emptySelector);
    const container = document.querySelector(containerSel);
    const emptyCenter = centerOf(empty.getBoundingClientRect());
    let containerCenter;
    if (regionMode === 'below-header') {
      const headerBottom = container.querySelector('header').getBoundingClientRect().bottom;
      const box = container.getBoundingClientRect();
      containerCenter = { x: box.left + box.width / 2, y: (headerBottom + box.bottom) / 2 };
    } else {
      containerCenter = centerOf(container.getBoundingClientRect());
    }
    return {
      offsetXPx: Math.abs(emptyCenter.x - containerCenter.x),
      offsetYPx: Math.abs(emptyCenter.y - containerCenter.y),
    };
  }, { emptySelector: selector, containerSelector, regionMode: region });

  // The AI panel's resize handle paints the divider on the workspace's right
  // edge, so the workspace itself must stay borderless there or the two lines
  // stack into a 2px seam; the outline survives through the bottom border.
  const activeWorkspaceBorder = (testid) => page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      right: `${style.borderRightWidth} ${style.borderRightStyle}`,
      bottom: `${style.borderBottomWidth} ${style.borderBottomStyle} ${style.borderBottomColor}`,
    };
  }, testid);

  // Every column pane must start under the same shared header height so the
  // resizable panes' dividing borders stay aligned across the workspace.
  const paneHeaderHeights = (scopeSelector) => page.evaluate((scopeSel) => {
    const scope = document.querySelector(scopeSel);
    if (!scope) return null;
    return [...scope.querySelectorAll('[data-slot="deployment-pane-header"]')].map(
      (header) => header.getBoundingClientRect().height,
    );
  }, scopeSelector);

  // Step separators divide whole rows: each must reach both edges of the list.
  const separatorEdges = () => page.evaluate(() => {
    const list = document.querySelector('[data-testid="deployment-step-list"]');
    if (!list) return null;
    const container = list.getBoundingClientRect();
    return [...list.querySelectorAll('[data-slot="separator"]')].map((separator) => {
      const box = separator.getBoundingClientRect();
      return {
        insetLeftPx: box.left - container.left,
        insetRightPx: container.right - box.right,
      };
    });
  });

  // Step node cards must start flush under the pane header divider, keep a
  // small gap between rows, and stay compact while remaining a comfortable
  // click target.
  const stepListDensity = () => page.evaluate(() => {
    const list = document.querySelector('[data-testid="deployment-step-list"]');
    const header = document.querySelector('[data-testid="deployment-editor-toolbar"]');
    if (!list || !header) return null;
    const cards = [...list.querySelectorAll('[data-step-node-id]')]
      .map((row) => row.querySelector('button'))
      .map((card) => card.getBoundingClientRect());
    const headerBottom = header.getBoundingClientRect().bottom;
    return {
      topInsetPx: cards[0].top - headerBottom,
      gapPx: cards.slice(1).map((box, index) => box.top - cards[index].bottom),
      cardHeights: cards.map((box) => Math.round(box.height)),
    };
  });

  // Workflow list rows (inside the scroll area, excluding the header actions)
  // must stay tall enough to remain an easy click target in every layout that
  // renders the pane.
  const workflowRowHeights = () => page.evaluate(() => {
    const list = document.querySelector('[data-testid="deployment-workflow-list"]');
    if (!list) return null;
    return [...list.querySelectorAll('[data-slot="scroll-area"] button')]
      .map((button) => Math.round(button.getBoundingClientRect().height));
  });

  // The workspace sits under the tab toolbar and beside the workbench sidebar,
  // so its own top and left edges must stay borderless: the toolbar's bottom
  // border and the sidebar's right border are the single dividers there.
  const workspaceEdges = () => page.evaluate(() => {
    const workspace = document.querySelector(
      '[data-testid="deployment-design-workspace"], [data-testid="deployment-runtime-workspace"], [data-testid="deployment-versions-view"]',
    );
    const toolbar = document.querySelector('[data-testid="deployment-workflow-toolbar"]');
    return {
      workspaceTop: getComputedStyle(workspace).borderTopWidth,
      workspaceLeft: getComputedStyle(workspace).borderLeftWidth,
      toolbarBottom: getComputedStyle(toolbar).borderBottomWidth,
      adjacent: Math.abs(workspace.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom) < 1,
    };
  });

  const clickTab = (index) => page.evaluate((tabIndex) => {
    document.querySelectorAll('[role="tab"]')[tabIndex].click();
  }, index);

  // Narrow pipeline layout swaps the inspector column for a configure drawer
  // whose header has no description line: the close button must stay on the
  // title line and inside the header box instead of hanging below the divider.
  // The workflows drawer shares that single-line header structure.
  const openConfigureDrawer = () => page.evaluate(() => {
    const button = document.querySelector([
      '[aria-label="deployment.editor.configure"]',
      '[aria-label="配置"]',
      '[aria-label="Configure"]',
    ].join(','));
    button.click();
  });
  const openWorkflowsDrawer = () => page.evaluate(() => {
    const button = document.querySelector([
      '[aria-label="deployment.editor.workflows"]',
      '[aria-label="工作流列表"]',
      '[aria-label="Workflows"]',
    ].join(','));
    button.click();
  });
  const drawerCloseMetrics = () => page.evaluate(() => {
    const drawer = document.querySelector('[data-slot="drawer-content"]');
    const header = drawer.querySelector('[data-slot="drawer-header"]');
    const title = drawer.querySelector('[data-slot="drawer-title"]');
    const close = drawer.querySelector('[data-slot="drawer-close"]');
    const centerOf = (box) => box.top + box.height / 2;
    const headerBox = header.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const closeBox = close.getBoundingClientRect();
    return {
      headerHeightPx: Math.round(headerBox.height),
      closeCenterOffsetFromTitlePx: Math.abs(centerOf(closeBox) - centerOf(titleBox)),
      closeCenterOffsetFromHeaderPx: Math.abs(centerOf(closeBox) - centerOf(headerBox)),
      closeRightInsetPx: drawer.getBoundingClientRect().right - closeBox.right,
      closeWithinHeader: closeBox.top >= headerBox.top - 0.5 && closeBox.bottom <= headerBox.bottom + 0.5,
    };
  });

  // The template dialog sizes to its content: while that fits the viewport the
  // body scroll area must not overflow, so the dialog renders without a
  // scrollbar; in a short window it caps at the viewport and only the body
  // scrolls instead of clipping.
  const openTemplateDialog = () => page.evaluate(() => {
    const button = document.querySelector([
      '[aria-label="deployment.editor.newWorkflow"]',
      '[aria-label="新建工作流"]',
      '[aria-label="New workflow"]',
    ].join(','));
    button.click();
  });
  const templateDialogMetrics = () => page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const viewport = dialog.querySelector('[data-slot="scroll-area-viewport"]');
    const box = dialog.getBoundingClientRect();
    return {
      heightPx: Math.round(box.height),
      capPx: window.innerHeight - 32,
      withinViewport: box.top >= -0.5 && box.bottom <= window.innerHeight + 0.5,
      overflowPx: viewport.scrollHeight - viewport.clientHeight,
    };
  });

  // The active line tab must show its underline: a rounded accent that no
  // overflow container can clip, unlike the old below-the-box marker. The strip
  // starts flush with the toolbar's left edge and the underline rides flush on
  // the toolbar divider: its bottom edge stops exactly at the scroller's clip.
  const waitForUnderlineSettled = () => page.waitForFunction(() => {
    const active = document.querySelector('[role="tab"][aria-selected="true"]');
    return getComputedStyle(active, '::after').opacity === '1';
  }, undefined, { timeout: 5_000 });
  const activeUnderline = () => page.evaluate(() => {
    const active = document.querySelector('[role="tab"][aria-selected="true"]');
    const triggerBox = active.getBoundingClientRect();
    const scroller = active.closest('[data-testid="deployment-workflow-toolbar"] > div');
    const scrollerBox = scroller.getBoundingClientRect();
    const toolbar = document.querySelector('[data-testid="deployment-workflow-toolbar"]');
    const toolbarBox = toolbar.getBoundingClientRect();
    const toolbarContentBottom = toolbarBox.bottom - parseFloat(getComputedStyle(toolbar).borderBottomWidth);
    const firstTab = toolbar.querySelector('[role="tab"]');
    const after = getComputedStyle(active, '::after');
    return {
      opacity: after.opacity,
      heightPx: parseFloat(after.height),
      bottomPx: parseFloat(after.bottom),
      leftPx: parseFloat(after.left),
      widthPx: parseFloat(after.width),
      triggerWidth: triggerBox.width,
      stripLeftInsetPx: firstTab.getBoundingClientRect().left - toolbarBox.left,
      insideScroller: triggerBox.bottom <= scrollerBox.bottom && triggerBox.top >= scrollerBox.top,
      flushWithBorder: Math.abs(triggerBox.bottom - toolbarContentBottom) < 1,
    };
  });

  // Below the 72rem container breakpoint the labelled actions collapse to
  // icon-only triggers, which must render as squares, not wide rectangles.
  const actionButtonsShape = () => page.evaluate(() => [...document
    .querySelectorAll('[data-testid="deployment-workflow-actions"] button')]
    .map((button) => {
      const box = button.getBoundingClientRect();
      return {
        square: Math.abs(box.width - box.height) < 1,
        w: Math.round(box.width),
        h: Math.round(box.height),
      };
    }));

  const centering = {};
  const borders = {};
  const junctions = {};
  const underlines = {};
  const buttonShapes = {};
  const paneHeights = {};
  const separators = {};
  const stepDensity = {};
  const workflowRows = {};
  const templateDialogs = {};
  const drawerCloseAlignment = {};
  for (const viewport of [{ width: 1440, height: 900 }, { width: 680, height: 720 }]) {
    const size = viewport.width;
    await page.setViewportSize(viewport);

    // Start every viewport pass from the empty runs list on the runs tab.
    await page.evaluate(() => window.__seedRunStore({
      runs: [],
      nextRunCursor: null,
      selectedRunId: null,
      detail: null,
      nodes: [],
      events: [],
      attempts: [],
      releases: [],
      loading: false,
    }));
    await clickTab(0);
    await page.waitForSelector('[role="tabpanel"]');

    // Runs tab with no run records: the whole-panel empty state must sit in the middle.
    await page.waitForSelector('[data-testid="deployment-run-empty-cta"]');
    centering[`runsEmpty@${size}`] = await centeringOf(
      '[role="tabpanel"] [data-slot="empty-state"]',
      '[data-slot="panel-empty-state"]',
    );

    // Load a finished run without step records: the steps panel empty state must center in its panel.
    await page.evaluate((seed) => window.__seedRunStore({
      runs: [seed.runSummary],
      selectedRunId: seed.runSummary.runId,
      detail: seed.runDetail,
      nodes: [],
      events: [],
      attempts: [],
      releases: [],
      loading: false,
    }), fixtures);
    await page.waitForSelector('[data-testid="deployment-runtime-step-list"] [data-slot="empty-state"]');
    centering[`stepsEmpty@${size}`] = await centeringOf(
      '[data-testid="deployment-runtime-step-list"] [data-slot="empty-state"]',
      '[data-testid="deployment-runtime-step-list"]',
    );
    borders[`runs@${size}`] = await activeWorkspaceBorder('deployment-runtime-workspace');
    junctions[`runs@${size}`] = await workspaceEdges();
    paneHeights[`runs@${size}`] = await paneHeaderHeights(
      '[data-testid="deployment-runtime-workspace"][data-layout="wide"]',
    );
    await waitForUnderlineSettled();
    underlines[`runs@${size}`] = await activeUnderline();
    buttonShapes[`${size}`] = await actionButtonsShape();

    // Versions tab without releases: centered empty state below the pane
    // header; rollback guidance lives in the rollback dialog, not a footer.
    await clickTab(2);
    await page.waitForSelector('[data-testid="deployment-versions-view"] [data-slot="empty-state"]');
    centering[`versionsEmpty@${size}`] = await centeringOf(
      '[data-testid="deployment-versions-view"] [data-slot="empty-state"]',
      '[data-testid="deployment-versions-view"]',
      'below-header',
    );
    borders[`versions@${size}`] = await activeWorkspaceBorder('deployment-versions-view');
    junctions[`versions@${size}`] = await workspaceEdges();
    await waitForUnderlineSettled();
    underlines[`versions@${size}`] = await activeUnderline();

    // Pipeline tab: confirm the outlined workspace matches the runtime tabs.
    await clickTab(1);
    await page.waitForSelector('[data-testid="deployment-design-workspace"]');
    borders[`pipeline@${size}`] = await activeWorkspaceBorder('deployment-design-workspace');
    junctions[`pipeline@${size}`] = await workspaceEdges();
    paneHeights[`pipeline@${size}`] = await paneHeaderHeights(
      '[data-testid="deployment-workspace-wide"]',
    );
    separators[`${size}`] = await separatorEdges();
    stepDensity[`${size}`] = await stepListDensity();
    workflowRows[`${size}`] = await workflowRowHeights();
    await waitForUnderlineSettled();
    underlines[`pipeline@${size}`] = await activeUnderline();

    // Only the narrow pass swaps the inspector for the configure drawer.
    if (size === 680) {
      await openConfigureDrawer();
      await page.waitForSelector('[data-slot="drawer-close"]');
      drawerCloseAlignment[`configure@${size}`] = await drawerCloseMetrics();
      await page.click('[data-slot="drawer-close"]');
      await page.waitForSelector('[data-slot="drawer-content"]', { state: 'hidden' });

      await openWorkflowsDrawer();
      await page.waitForSelector('[data-slot="drawer-close"]');
      drawerCloseAlignment[`workflows@${size}`] = await drawerCloseMetrics();
      await page.click('[data-slot="drawer-close"]');
      await page.waitForSelector('[data-slot="drawer-content"]', { state: 'hidden' });
    }

    await openTemplateDialog();
    await page.waitForSelector('[role="dialog"]');
    templateDialogs[`${size}`] = await templateDialogMetrics();
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="dialog"]', { state: 'hidden' });
  }

  // Short window: the dialog must cap at the viewport and keep the body
  // scrollable rather than clipping the form.
  await page.setViewportSize({ width: 680, height: 420 });
  await openTemplateDialog();
  await page.waitForSelector('[role="dialog"]');
  templateDialogs['680x420'] = await templateDialogMetrics();
  await page.keyboard.press('Escape');

  const tolerance = 2;
  const failures = [];
  for (const [key, value] of Object.entries(centering)) {
    if (value.offsetXPx > tolerance || value.offsetYPx > tolerance) {
      failures.push(`${key}: empty state off-center by ${value.offsetXPx.toFixed(1)}px x / ${value.offsetYPx.toFixed(1)}px y`);
    }
  }
  const uniqueBorders = [...new Set(Object.values(borders).map((border) => border?.bottom))];
  if (uniqueBorders.length !== 1 || uniqueBorders[0] === '0px none rgba(0, 0, 0, 0)') {
    failures.push(`workspace bottom borders not uniform across tabs: ${JSON.stringify(borders)}`);
  }
  for (const [key, border] of Object.entries(borders)) {
    if (!border || !border.right.startsWith('0px')) {
      failures.push(`${key}: workspace paints its own right border (${JSON.stringify(border)}), stacking on the AI panel divider`);
    }
  }
  for (const [key, value] of Object.entries(junctions)) {
    if (!value.adjacent
      || value.workspaceTop !== '0px'
      || value.workspaceLeft !== '0px'
      || value.toolbarBottom === '0px') {
      failures.push(`${key}: toolbar/workspace junction not a single divider (${JSON.stringify(value)})`);
    }
  }
  for (const [key, value] of Object.entries(underlines)) {
    const centered = Math.abs((value.triggerWidth - value.widthPx) / 2 - value.leftPx) <= 1;
    if (value.opacity !== '1'
      || value.heightPx !== 2
      || value.bottomPx !== -1
      || value.stripLeftInsetPx > 0.5
      || !value.insideScroller
      || !value.flushWithBorder
      || !centered
      || value.widthPx >= value.triggerWidth) {
      failures.push(`${key}: active tab underline not a visible centered accent flush-left and riding the toolbar divider (${JSON.stringify(value)})`);
    }
  }

  // Only the narrow pass collapses labels to icon-only buttons; they must be square.
  if ((buttonShapes['680'] ?? []).some((shape) => !shape.square)) {
    failures.push(`icon-only toolbar buttons not square at 680px: ${JSON.stringify(buttonShapes['680'])}`);
  }

  for (const [key, heights] of Object.entries(paneHeights)) {
    if (!heights) continue;
    const rounded = heights.map((height) => Math.round(height));
    if (new Set(rounded).size !== 1 || heights.length < 3) {
      failures.push(`${key}: pane header heights not unified: ${JSON.stringify(heights)}`);
    } else if (Math.abs(rounded[0] - 48) > 1) {
      failures.push(`${key}: unified pane header height ${rounded[0]}px, expected 48px`);
    }
  }
  for (const [key, edges] of Object.entries(separators)) {
    if (!edges) continue;
    if (edges.length === 0) {
      failures.push(`${key}: step list separators missing`);
    } else if (edges.some((edge) => edge.insetLeftPx > 1 || edge.insetRightPx > 1)) {
      failures.push(`${key}: step separators not full-width: ${JSON.stringify(edges)}`);
    }
  }

  // The first step card must sit flush against the pane header divider, rows
  // keep a small separator gap between each other, and every row stays a
  // compact (48px) click target rather than the old padded 52px card.
  for (const [key, density] of Object.entries(stepDensity)) {
    if (!density) continue;
    if (Math.abs(density.topInsetPx) > 1) {
      failures.push(`${key}: first step card not flush with the pane header divider (${density.topInsetPx.toFixed(1)}px below it)`);
    }
    if (density.gapPx.some((gap) => gap < 2 || gap > 12)) {
      failures.push(`${key}: step row gaps out of the compact range: ${JSON.stringify(density.gapPx.map((gap) => gap.toFixed(1)))}`);
    }
    if (density.cardHeights.some((height) => height < 40 || height > 50)) {
      failures.push(`${key}: step rows not compact click targets: ${JSON.stringify(density.cardHeights)}`);
    }
  }

  // The wide pipeline layout always shows the workflow pane; its rows must keep
  // the taller 34px click target (14px label line + py-2.5 paddings).
  const wideWorkflowRows = workflowRows['1440'] ?? [];
  if (wideWorkflowRows.length === 0) {
    failures.push('pipeline wide layout did not render workflow list rows');
  } else if (wideWorkflowRows.some((height) => height < 34)) {
    failures.push(`workflow list rows too short at 1440px: ${JSON.stringify(wideWorkflowRows)}`);
  }
  for (const [key, heights] of Object.entries(workflowRows)) {
    if (!heights || key === '1440') continue;
    if (heights.length > 0 && heights.some((height) => height < 34)) {
      failures.push(`${key}: workflow list rows too short: ${JSON.stringify(heights)}`);
    }
  }

  for (const [key, value] of Object.entries(templateDialogs)) {
    if (!value) {
      failures.push(`${key}: template dialog did not render`);
      continue;
    }
    if (!value.withinViewport || value.heightPx > value.capPx + 1) {
      failures.push(`${key}: template dialog exceeds the viewport cap: ${JSON.stringify(value)}`);
    } else if (key !== '680x420' && value.overflowPx > 0) {
      failures.push(`${key}: template dialog shows a scrollbar with fitting content: ${JSON.stringify(value)}`);
    } else if (key === '680x420' && Math.abs(value.capPx - value.heightPx) <= 1 && value.overflowPx <= 0) {
      failures.push(`${key}: capped template dialog body must scroll instead of clipping: ${JSON.stringify(value)}`);
    }
  }

  // The configure and workflows drawer headers have no description line, so
  // the close button must align with the title line and the 48px header box.
  for (const [key, value] of Object.entries(drawerCloseAlignment)) {
    if (!value) {
      failures.push(`${key}: drawer did not render`);
    } else if (Math.abs(value.closeCenterOffsetFromTitlePx) > 1
      || Math.abs(value.closeCenterOffsetFromHeaderPx) > 1
      || !value.closeWithinHeader
      || Math.abs(value.closeRightInsetPx - 12) > 1
      || Math.abs(value.headerHeightPx - 48) > 1) {
      failures.push(`${key}: drawer close button misaligned: ${JSON.stringify(value)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`deployment center render check failed:\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`deployment center render check passed: ${Object.keys(centering).length} centering checks within ${tolerance}px, `
      + `${Object.keys(borders).length} workspaces borderless beside the AI panel with uniform bottom borders (${uniqueBorders[0]}), `
      + `${Object.keys(junctions).length} single-divider workspace edges, `
      + `${Object.keys(underlines).length} flush-left tab underlines riding the toolbar divider, `
      + `${(buttonShapes['680'] ?? []).length} square icon-only buttons at 680px, `
      + `${Object.values(paneHeights).filter(Boolean).length} unified 48px pane header rows, `
      + `${(workflowRows['1440'] ?? []).length} workflow list rows at >=34px, `
      + `${Object.values(separators).filter(Boolean).flat().length} full-width step separators, `
      + `${Object.values(stepDensity).filter(Boolean).flatMap((density) => density.cardHeights).length} compact flush step rows, `
      + `${Object.values(drawerCloseAlignment).filter(Boolean).length} aligned drawer close buttons, `
      + `${Object.keys(templateDialogs).length} scrollbar-free template dialog renders`);
  }
} catch (error) {
  console.error(`deployment center render check failed: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
