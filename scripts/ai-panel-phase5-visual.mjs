import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHELLSPAN_PHASE5_PORT ?? 1433);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EVIDENCE = join(ROOT, 'docs/ai-panel-phase5/evidence');
const SCREENSHOTS = join(EVIDENCE, 'screenshots');
const SEMANTIC = join(EVIDENCE, 'semantic');
const MANIFEST = join(EVIDENCE, 'manifest.json');
const ENVIRONMENT = join(EVIDENCE, 'environment.json');
const FIXED_NOW = Date.parse('2026-09-03T00:00:30.000Z');

const scenes = Object.freeze([
  {
    id: 'hello-320-light-collapsed-1x', scenario: 'hello', width: 320, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect the minimum 320px panel-width contract without horizontal transcript or Composer overflow.',
  },
  {
    id: 'hello-400-light-collapsed-1x', scenario: 'hello', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Primary DeepSeek-aligned hello baseline for the completed, collapsed Turn Process hierarchy.',
  },
  {
    id: 'hello-400-light-collapsed-2x', scenario: 'hello', width: 400, theme: 'light',
    deviceScaleFactor: 2, expanded: false,
    coverageReason: 'Protect the primary collapsed hello hierarchy at 2x device scale factor.',
  },
  {
    id: 'hello-400-light-expanded-1x', scenario: 'hello', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: true,
    coverageReason: 'Protect the expanded Context Injection then Reasoning structure at the core narrow width.',
  },
  {
    id: 'hello-560-light-completed-1x', scenario: 'hello', width: 560, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect completed answer, durable stats wrapping, and Composer clearance at the middle width.',
  },
  {
    id: 'single-tool-720-light-expanded-1x', scenario: 'single-tool', width: 720, theme: 'light',
    deviceScaleFactor: 1, expanded: true,
    coverageReason: 'Protect the maximum-width Context and tool-process hierarchy without payload or panel overflow.',
  },
  {
    id: 'hello-400-dark-completed-1x', scenario: 'hello', width: 400, theme: 'dark',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect semantic dark tokens across the core completed hello hierarchy and Composer.',
  },
  {
    id: 'streaming-reasoning-400-light-2x', scenario: 'streaming-reasoning', width: 400, theme: 'light',
    deviceScaleFactor: 2, expanded: true,
    coverageReason: 'Protect the truthful running Process and streaming Reasoning state at 2x without relying on motion.',
  },
  {
    id: 'retry-success-400-light-expanded-1x', scenario: 'retry-success', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: true,
    coverageReason: 'Protect the retry process child and the successful final answer as distinct information tiers.',
  },
  {
    id: 'provider-error-400-light-expanded-1x', scenario: 'provider-error', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: true,
    coverageReason: 'Protect the accessible provider-error child, failed Process state, and unobscured Composer.',
  },
  {
    id: 'missing-usage-400-light-completed-1x', scenario: 'missing-usage', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect omission of unproven usage fields while retaining factual turn timing and counts.',
  },
  {
    id: 'direct-answer-400-light-completed-1x', scenario: 'direct-answer', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect the no-reasoning fallback with a visible answer and no invented reasoning row.',
  },
  {
    id: 'multiple-tools-720-light-expanded-1x', scenario: 'multiple-tools', width: 720, theme: 'light',
    deviceScaleFactor: 1, expanded: true,
    coverageReason: 'Protect provider-ordered multiple tool rows inside one expanded Turn Process.',
  },
  {
    id: 'cancelled-400-light-expanded-1x', scenario: 'cancelled', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: true,
    coverageReason: 'Protect interrupted answer copy and the cancelled Turn Process hierarchy.',
  },
  {
    id: 'max-tokens-400-light-completed-1x', scenario: 'max-tokens', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect the length stop reason, partial answer, and provider-reported usage.',
  },
  {
    id: 'partial-history-400-light-expanded-1x', scenario: 'partial-history', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: true,
    coverageReason: 'Protect a partial event window without a misleading completed fold or stats tail.',
  },
  {
    id: 'pagination-560-light-completed-1x', scenario: 'pagination', width: 560, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect the full prepended history layout and stable two-turn ordering.',
  },
  {
    id: 'compaction-400-light-completed-1x', scenario: 'compaction', width: 400, theme: 'light',
    deviceScaleFactor: 1, expanded: false,
    coverageReason: 'Protect a compacted event log without leaking compaction lifecycle into Conversation.',
  },
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments() {
  const updateIndex = process.argv.indexOf('--update');
  const reasonIndex = process.argv.indexOf('--reason');
  const updateId = updateIndex < 0 ? null : process.argv[updateIndex + 1];
  const reason = reasonIndex < 0 ? null : process.argv[reasonIndex + 1];
  if (updateIndex >= 0 && (!updateId || updateId === 'all')) {
    throw new Error('--update requires exactly one concrete scene id; bulk baseline replacement is intentionally unsupported.');
  }
  if (updateId && !scenes.some((scene) => scene.id === updateId)) {
    throw new Error(`Unknown Phase 5 scene: ${updateId}`);
  }
  if (updateId && !reason?.trim()) {
    throw new Error('--update requires a non-empty --reason explaining this one baseline change.');
  }
  return { updateId, reason: reason?.trim() ?? null };
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function waitForServer(server, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Phase 5 Vite server exited early (${String(server.exitCode)}):\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/?aiPhase5Visual=hello&theme=light`);
      if (response.ok) return;
    } catch {
      // The bounded readiness loop owns connection-refused during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Phase 5 Vite server did not become ready:\n${output.join('')}`);
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  const exited = once(server, 'exit').catch(() => undefined);
  try {
    if (process.platform === 'win32' || server.pid === undefined) server.kill('SIGTERM');
    else process.kill(-server.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

function assertSemantic(scene, semantic) {
  assert.equal(semantic.surface.width, scene.width, `${scene.id}: panel width drifted`);
  assert.equal(semantic.surface.height, 900, `${scene.id}: panel height drifted`);
  assert.deepEqual(semantic.horizontalOverflow, [], `${scene.id}: horizontal panel overflow`);
  assert.deepEqual(semantic.clippedEssential, [], `${scene.id}: essential transcript content is clipped`);
  assert.equal(semantic.composer.visible, true, `${scene.id}: Composer is not visible`);
  assert.equal(semantic.composer.overlapsConversation, false, `${scene.id}: Composer overlaps the conversation viewport`);
  assert.equal(semantic.composer.bottomGap, 0, `${scene.id}: Composer seat no longer reaches the panel edge`);
  assert.equal(semantic.composer.bottomPadding, 8, `${scene.id}: Composer bottom clearance drifted`);
  assert.equal(semantic.conversation.bottomPadding >= 28, true, `${scene.id}: conversation lacks Composer clearance`);
  assert.equal(semantic.providerRequests, 0, `${scene.id}: visual fixture contacted an external provider`);
  assert.equal(semantic.process.expanded, scene.expanded || scene.scenario === 'streaming-reasoning');
  assert.equal(semantic.process.separatorVisible, true, `${scene.id}: Process separator disappeared`);
  assert.equal(semantic.icons.systemPrompt, true, `${scene.id}: system-prompt icon semantics drifted`);

  if (scene.scenario === 'hello') {
    assert.deepEqual(semantic.nodeKinds, [
      'systemPrompt', 'userMessage', 'turnProcess', 'assistantMessage', 'turnTail',
    ]);
    assert.deepEqual(semantic.process.childKinds, scene.expanded ? ['contextInjection', 'reasoning'] : []);
    assert.equal(semantic.process.label, '已思考');
    assert.equal(semantic.answerBeforeStats, true);
    assert.equal(semantic.icons.contextInjection, scene.expanded);
    assert.equal(semantic.icons.reasoning, scene.expanded);
    assert.equal(semantic.process.visibleChildKinds.length, scene.expanded ? 2 : 0);
  }
  if (scene.scenario === 'single-tool') {
    assert.equal(semantic.process.childKinds.includes('tool'), true);
    assert.equal(semantic.process.visibleChildKinds.includes('tool'), true);
  }
  if (scene.scenario === 'direct-answer') {
    assert.equal(semantic.process.childKinds.includes('reasoning'), false);
    assert.equal(semantic.answerText.includes('Hello! How can I help?'), true);
  }
  if (scene.scenario === 'multiple-tools') {
    assert.equal(semantic.process.visibleChildKinds.filter((kind) => kind === 'tool').length, 2);
  }
  if (scene.scenario === 'streaming-reasoning') {
    assert.equal(semantic.process.status, 'running');
    assert.equal(semantic.reasoning.state, 'running');
    assert.equal(semantic.reasoning.statusRole, true);
    assert.equal(semantic.reasoning.expanded, false);
  }
  if (scene.scenario === 'retry-success') {
    assert.equal(semantic.process.visibleChildKinds.includes('retry'), true);
    assert.equal(semantic.answerText.includes('Hello after retry.'), true);
  }
  if (scene.scenario === 'provider-error') {
    assert.equal(semantic.process.visibleChildKinds.includes('error'), true);
    assert.equal(semantic.alertCount, 1);
  }
  if (scene.scenario === 'missing-usage') {
    for (const unavailable of [
      'rate', 'cacheRead', 'cacheWrite', 'cacheHit', 'inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens',
    ]) assert.equal(semantic.stats.keys.includes(unavailable), false);
  }
  if (scene.scenario === 'cancelled') {
    assert.equal(semantic.process.status, 'cancelled');
    assert.equal(semantic.answerText.includes('The report begins with'), true);
  }
  if (scene.scenario === 'max-tokens') {
    assert.equal(semantic.answerText.includes('This item was cut'), true);
    assert.equal(semantic.stats.keys.includes('outputTokens'), true);
  }
  if (scene.scenario === 'partial-history') {
    assert.equal(semantic.process.status, 'partial');
    assert.equal(semantic.stats.keys.length, 0);
  }
  if (scene.scenario === 'pagination') {
    assert.equal(semantic.nodeKinds.filter((kind) => kind === 'userMessage').length, 2);
    assert.equal(semantic.nodeKinds.filter((kind) => kind === 'assistantMessage').length, 2);
  }
  if (scene.scenario === 'compaction') {
    assert.equal(semantic.nodeKinds.includes('lifecycleMarker'), false);
    assert.equal(semantic.answerText.includes('Hello after compaction.'), true);
  }
  if (scene.theme === 'dark') {
    assert.equal(semantic.colors.workspaceMatchesSemantic, true);
    assert.equal(semantic.colors.userBubbleMatchesSemantic, true);
    assert.notEqual(semantic.colors.workspace, 'rgb(255, 255, 255)');
    assert.notEqual(semantic.colors.userBubble, 'rgb(237, 243, 254)');
  }
}

async function captureScene(browser, scene) {
  const context = await browser.newContext({
    viewport: { width: scene.width, height: 900 },
    deviceScaleFactor: scene.deviceScaleFactor,
    colorScheme: scene.theme,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Shanghai',
  });
  const externalRequests = [];
  try {
    await context.addInitScript(({ fixedNow }) => {
      const NativeDate = Date;
      class FixedDate extends NativeDate {
        constructor(...values) {
          super(values.length === 0 ? fixedNow : values[0]);
        }
        static now() { return fixedNow; }
      }
      Object.defineProperty(window, 'Date', { configurable: true, value: FixedDate });
      let randomState = 0x5f3759df;
      Math.random = () => {
        randomState = (randomState * 1664525 + 1013904223) >>> 0;
        return randomState / 0x1_0000_0000;
      };
      let uuidCounter = 0;
      Object.defineProperty(crypto, 'randomUUID', {
        configurable: true,
        value: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
      });
    }, { fixedNow: FIXED_NOW });
    const page = await context.newPage();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1') externalRequests.push(request.url());
    });
    await page.goto(`${ORIGIN}/?aiPhase5Visual=${scene.scenario}&theme=${scene.theme}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('[data-phase5-ready="true"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}',
    });
    const processTrigger = page.locator('[data-ai-node-kind="turnProcess"] .ai-turn-process-trigger');
    if (scene.expanded && await processTrigger.getAttribute('aria-expanded') !== 'true') {
      await processTrigger.click();
    }
    await page.locator('[data-phase5-surface]').evaluate((surface) => {
      const viewport = surface.querySelector('[data-message-scroller-viewport]');
      if (viewport instanceof HTMLElement) viewport.scrollTop = 0;
    });

    const semantic = await page.locator('[data-phase5-surface]').evaluate((surface, capture) => {
      const visible = (element) => element instanceof Element
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
      const rect = (element) => element instanceof HTMLElement ? element.getBoundingClientRect() : null;
      const root = surface.querySelector('[data-slot="ai-workspace-root"]');
      const conversation = surface.querySelector('.ai-conversation-content');
      const viewport = surface.querySelector('[data-message-scroller-viewport]');
      const composer = surface.querySelector('[data-composer-seat]');
      const process = surface.querySelector('[data-ai-node-kind="turnProcess"] .ai-turn-process');
      const processTrigger = process?.querySelector('.ai-turn-process-trigger');
      const processSeparator = process?.querySelector('.ai-turn-process-separator');
      const reasoning = surface.querySelector('.ai-reasoning-row');
      const answer = surface.querySelector('[data-ai-node-kind="assistantMessage"]');
      const stats = surface.querySelector('[data-ai-node-kind="turnTail"] .ai-turn-stats');
      const surfaceRect = rect(surface);
      const viewportRect = rect(viewport);
      const composerRect = rect(composer);
      const answerRect = rect(answer);
      const statsRect = rect(stats);
      const overflowCandidates = [
        ['document', document.documentElement], ['body', document.body], ['surface', surface],
        ['workspace', root], ['conversationViewport', viewport],
      ];
      const essential = [
        ...surface.querySelectorAll('.ai-message, .ai-turn-process, .ai-turn-stats, .ai-semantic-note'),
      ];
      const style = getComputedStyle(surface);
      const workspaceStyle = root ? getComputedStyle(root) : null;
      const bubble = surface.querySelector('.ai-message-bubble-user .ai-message-bubble-content');
      const bubbleStyle = bubble ? getComputedStyle(bubble) : null;
      const childRows = [...surface.querySelectorAll('[data-ai-process-child]')];
      return {
        scene: capture,
        surface: {
          width: Math.round(surfaceRect?.width ?? 0),
          height: Math.round(surfaceRect?.height ?? 0),
        },
        nodeKinds: [...surface.querySelectorAll('[data-ai-node-kind]')]
          .map((element) => element.getAttribute('data-ai-node-kind')),
        horizontalOverflow: overflowCandidates.flatMap(([name, element]) => (
          element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1 ? [name] : []
        )),
        clippedEssential: essential.flatMap((element) => (
          element instanceof HTMLElement && visible(element) && element.scrollWidth > element.clientWidth + 1
            ? [element.className]
            : []
        )),
        conversation: {
          bottomPadding: conversation ? Number.parseFloat(getComputedStyle(conversation).paddingBottom) : 0,
        },
        composer: {
          visible: visible(composer),
          overlapsConversation: Boolean(viewportRect && composerRect && viewportRect.bottom > composerRect.top + 0.5),
          bottomGap: Math.round((surfaceRect?.bottom ?? 0) - (composerRect?.bottom ?? 0)),
          bottomPadding: composer ? Number.parseFloat(getComputedStyle(composer).paddingBottom) : 0,
        },
        process: {
          label: processTrigger?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          expanded: processTrigger?.getAttribute('aria-expanded') === 'true',
          status: process?.getAttribute('data-status') ?? null,
          separatorVisible: visible(processSeparator)
            && Number.parseFloat(processSeparator ? getComputedStyle(processSeparator).height : '0') > 0,
          childKinds: childRows.map((element) => element.getAttribute('data-ai-process-child')),
          visibleChildKinds: childRows.filter(visible)
            .map((element) => element.getAttribute('data-ai-process-child')),
        },
        reasoning: {
          state: reasoning?.getAttribute('data-state') ?? null,
          expanded: reasoning?.getAttribute('data-expanded') === 'true',
          statusRole: reasoning?.getAttribute('role') === 'status',
        },
        icons: {
          systemPrompt: surface.querySelector('[data-ai-node-kind="systemPrompt"] .lucide-notebook-text') !== null,
          contextInjection: visible(surface.querySelector('[data-ai-process-child="contextInjection"] .lucide-file-input')),
          reasoning: visible(surface.querySelector('[data-ai-process-child="reasoning"] .lucide-atom')),
        },
        answerText: answer?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        answerBeforeStats: Boolean(answerRect && statsRect && answerRect.bottom <= statsRect.top),
        stats: {
          keys: [...surface.querySelectorAll('.ai-turn-stats [data-stat]')]
            .map((element) => element.getAttribute('data-stat')),
          text: stats?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        },
        alertCount: [...surface.querySelectorAll('[role="alert"]')].filter(visible).length,
        colors: {
          workspace: workspaceStyle?.backgroundColor ?? '',
          workspaceMatchesSemantic: workspaceStyle?.backgroundColor === style.getPropertyValue('--dsw-alias-bg-base').trim(),
          userBubble: bubbleStyle?.backgroundColor ?? '',
          userBubbleMatchesSemantic: bubbleStyle?.backgroundColor === style.getPropertyValue('--dsw-specific-bubble').trim(),
        },
        providerRequests: 0,
      };
    }, {
      id: scene.id,
      scenario: scene.scenario,
      width: scene.width,
      height: 900,
      theme: scene.theme,
      deviceScaleFactor: scene.deviceScaleFactor,
      expanded: scene.expanded,
    });
    semantic.providerRequests = externalRequests.length;
    assertSemantic(scene, semantic);
    const screenshot = await page.locator('[data-phase5-surface]').screenshot({ animations: 'disabled' });
    return { screenshot, semantic };
  } finally {
    await context.close();
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeEvidence(browser, selected, result, reason) {
  await mkdir(SCREENSHOTS, { recursive: true });
  await mkdir(SEMANTIC, { recursive: true });
  const screenshotPath = join(SCREENSHOTS, `${selected.id}.png`);
  const semanticPath = join(SEMANTIC, `${selected.id}.json`);
  await writeFile(screenshotPath, result.screenshot);
  await writeFile(semanticPath, `${JSON.stringify(result.semantic, null, 2)}\n`);

  const previous = await readJson(MANIFEST, { scenes: [] });
  const previousReasons = new Map(previous.scenes.map((scene) => [scene.id, scene.lastUpdatedReason]));
  const manifestScenes = [];
  for (const scene of scenes) {
    const png = join(SCREENSHOTS, `${scene.id}.png`);
    const json = join(SEMANTIC, `${scene.id}.json`);
    if (!await exists(png) || !await exists(json)) continue;
    const [pngBytes, jsonBytes] = await Promise.all([readFile(png), readFile(json)]);
    manifestScenes.push({
      ...scene,
      screenshot: relative(ROOT, png),
      semantic: relative(ROOT, json),
      screenshotSha256: sha256(pngBytes),
      semanticSha256: sha256(jsonBytes),
      lastUpdatedReason: scene.id === selected.id ? reason : previousReasons.get(scene.id),
    });
  }
  await writeFile(MANIFEST, `${JSON.stringify({
    schemaVersion: 1,
    baselinePolicy: 'One scene per --update invocation with a required reason; bulk replacement is unsupported.',
    scenes: manifestScenes,
  }, null, 2)}\n`);

  const playwrightPackage = JSON.parse(await readFile(join(ROOT, 'node_modules/playwright/package.json'), 'utf8'));
  await writeFile(ENVIRONMENT, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    platform: platform(),
    architecture: arch(),
    node: process.version,
    playwright: playwrightPackage.version,
    browser: { engine: 'chromium', version: browser.version() },
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    fixedNowUnixMs: FIXED_NOW,
    randomIds: 'deterministic seeded Math.random and monotonic crypto.randomUUID',
    caretAndAnimation: 'disabled before every capture',
    fonts: 'document.fonts.ready awaited before every capture',
  }, null, 2)}\n`);
}

async function verifyManifest(browser) {
  const manifest = await readJson(MANIFEST, null);
  const environment = await readJson(ENVIRONMENT, null);
  assert(manifest, 'Phase 5 manifest is missing; create baselines one scene at a time.');
  assert(environment, 'Phase 5 environment record is missing.');
  assert.equal(environment.platform, platform(), 'Phase 5 baselines were captured on a different platform');
  assert.equal(environment.architecture, arch(), 'Phase 5 baselines were captured on a different architecture');
  assert.equal(environment.browser.version, browser.version(), 'Phase 5 Chromium version changed; review scenes individually');
  assert.deepEqual(manifest.scenes.map((scene) => scene.id), scenes.map((scene) => scene.id));
  for (const scene of manifest.scenes) {
    const [png, semantic] = await Promise.all([
      readFile(join(ROOT, scene.screenshot)),
      readFile(join(ROOT, scene.semantic)),
    ]);
    assert.equal(sha256(png), scene.screenshotSha256, `${scene.id}: screenshot manifest hash mismatch`);
    assert.equal(sha256(semantic), scene.semanticSha256, `${scene.id}: semantic manifest hash mismatch`);
    assert.equal(Boolean(scene.lastUpdatedReason), true, `${scene.id}: baseline update reason is missing`);
  }
}

const { updateId, reason } = parseArguments();
const selectedScenes = updateId ? scenes.filter((scene) => scene.id === updateId) : scenes;
const output = [];
const server = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  },
);
server.stdout.on('data', (chunk) => output.push(String(chunk)));
server.stderr.on('data', (chunk) => output.push(String(chunk)));

let browser;
try {
  await waitForServer(server, output);
  browser = await chromium.launch({ headless: true });
  if (!updateId) await verifyManifest(browser);
  for (const scene of selectedScenes) {
    const first = await captureScene(browser, scene);
    const second = await captureScene(browser, scene);
    assert.equal(second.screenshot.equals(first.screenshot), true, `${scene.id}: consecutive screenshots differ`);
    assert.deepEqual(second.semantic, first.semantic, `${scene.id}: consecutive semantic snapshots differ`);
    if (updateId) {
      await writeEvidence(browser, scene, first, reason);
      process.stdout.write(`updated ${scene.id}: ${reason}\n`);
      continue;
    }
    const [expectedPng, expectedSemantic] = await Promise.all([
      readFile(join(SCREENSHOTS, `${scene.id}.png`)),
      readFile(join(SEMANTIC, `${scene.id}.json`), 'utf8'),
    ]);
    assert.equal(first.screenshot.equals(expectedPng), true, `${scene.id}: pixel baseline mismatch`);
    assert.equal(`${JSON.stringify(first.semantic, null, 2)}\n`, expectedSemantic, `${scene.id}: semantic DOM baseline mismatch`);
    process.stdout.write(`verified ${scene.id}\n`);
  }
} finally {
  await browser?.close();
  await stopServer(server);
}
