import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = path.join(root, 'artifacts', 'tests', 'workbench-host-tools');
await mkdir(output, { recursive: true });

const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  cacheDir: path.join(output, 'vite-cache'),
  plugins: [tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: {
    entries: [
      'src/components/workbench/port-forward-panel.tsx',
      'src/components/workbench/host-quick-actions-panel.tsx',
      'src/components/workbench/workbench-sidebar.tsx',
    ],
    include: ['react', 'react-dom/client'],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});

server.middlewares.use((request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html class="h-full"><body class="h-full m-0"><div id="root" class="h-full"></div></body></html>');
});

async function launchBrowser() {
  for (const options of [{}, { channel: 'msedge' }, { channel: 'chrome' }]) {
    try {
      return await chromium.launch(options);
    } catch {
      // Try next available Chromium-based browser on this machine.
    }
  }
  return chromium.launch();
}

try {
  await server.listen();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    await page.goto(server.resolvedUrls.local[0]);

    await page.evaluate(async () => {
      const { default: React } = await import('/@id/react');
      const { default: ReactDOM } = await import('/@id/react-dom/client');
      const { ConnectionList } = await import('/src/components/workbench/connection-list.tsx');
      const { PortForwardPanel } = await import('/src/components/workbench/port-forward-panel.tsx');
      const { HostQuickActionsPanel } = await import('/src/components/workbench/host-quick-actions-panel.tsx');
      const { WorkbenchSidebar } = await import('/src/components/workbench/workbench-sidebar.tsx');
      const { useAppStore } = await import('/src/stores/appStore.ts');
      const { useProfileStore } = await import('/src/stores/profileStore.ts');
      const { usePortForwardStore } = await import('/src/stores/portForwardStore.ts');
      const { useTerminalStore } = await import('/src/stores/terminalStore.ts');
      const { initI18n } = await import('/src/locales/index.ts');
      await import('/src/styles/base.css');

      useAppStore.setState({ locale: 'zh-CN', activeWorkbenchTab: 'portForwards' });
      await initI18n('zh-CN');

      const profiles = [
        {
          id: 'p1',
          name: '生产数据库',
          host: '111.229.249.191',
          port: 22,
          username: 'root',
          authMethod: 'password',
          portForwards: [
            { id: 'r1', name: 'PostgreSQL 隧道', kind: 'local', localPort: 5432, remoteHost: '127.0.0.1', remotePort: 5432, autoStart: true },
            { id: 'r2', name: 'Redis 调试', kind: 'local', localPort: 6379, remoteHost: '127.0.0.1', remotePort: 6379, autoStart: false },
          ],
          quickActions: [
            { id: 'q1', kind: 'directory', label: '日志目录', path: '/var/log/postgresql', target: 'sftp' },
            { id: 'q2', kind: 'command', label: '查看最近日志', command: 'tail -n 100 /var/log/postgresql/main.log' },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'p2',
          name: '网关主机',
          host: '175.178.66.45',
          port: 22,
          username: 'deploy',
          authMethod: 'key',
          portForwards: [
            { id: 'r3', name: '内网代理', kind: 'dynamic', localPort: 1080, remoteHost: '', remotePort: 0, autoStart: false },
          ],
          quickActions: [
            { id: 'q3', kind: 'connection', label: '管理端口转发', action: 'portForward' },
          ],
          createdAt: 2,
          updatedAt: 2,
        },
      ];
      useProfileStore.setState({ profiles, initialized: true });
      usePortForwardStore.setState({
        runtimes: [
          {
            operationId: 'op-1',
            profileId: 'p1',
            configId: 'r1',
            name: 'PostgreSQL 隧道',
            kind: 'local',
            mode: 'auto',
            status: 'running',
            startedAt: Date.now() - 60_000,
            bytesSent: 15360,
            bytesReceived: 128000,
            ownerIds: ['terminal:1'],
          },
          {
            operationId: 'op-2',
            profileId: 'p1',
            configId: 'r2',
            name: 'Redis 调试',
            kind: 'local',
            mode: 'manual',
            status: 'failed',
            bytesSent: 0,
            bytesReceived: 0,
            lastError: 'local port 127.0.0.1:6379 is already in use',
            errorCategory: 'portInUse',
            ownerIds: [],
          },
        ],
      });
      useTerminalStore.setState({
        sessions: [
          { sessionId: 's1', profileId: 'p1', title: '生产数据库', host: '111.229.249.191', port: 22, username: 'root', status: 'connected' },
        ],
        activeSessionId: 's1',
      });

      function Harness() {
        const activeTab = useAppStore((s) => s.activeWorkbenchTab);
        const setActiveTab = useAppStore((s) => s.setActiveWorkbenchTab);
        const listProfiles = useProfileStore((s) => s.profiles);
        return React.createElement(
          'div',
          { className: 'flex h-full w-full' },
          React.createElement(WorkbenchSidebar, {
            activeTab,
            onTabChange: setActiveTab,
            onOpenSettings() {},
            onCheckForUpdates() {},
            onOpenAbout() {},
            onRequestExit() {},
          }),
          React.createElement(
            'div',
            { className: 'flex h-full min-w-0 flex-1 flex-col overflow-hidden' },
            activeTab === 'connections'
              ? React.createElement(ConnectionList, {
                  profiles: listProfiles,
                  initialized: true,
                  onAdd() {},
                  onEdit() {},
                  onDelete() {},
                  onConnectTerminal() {},
                  onConnectSftp() {},
                  onDuplicate() {},
                  onToggleFavorite() {},
                  onImport() {},
                  onExport() {},
                })
              : activeTab === 'portForwards'
                ? React.createElement(PortForwardPanel)
                : React.createElement(HostQuickActionsPanel),
          ),
        );
      }

      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    });

    for (const width of [1200, 640]) {
      await page.setViewportSize({ width, height: 760 });
      if (width === 1200) {
        await page.locator('nav').getByRole('button', { name: /^连接管理/ }).click();
        await page.getByText('生产数据库').waitFor();
        await page.screenshot({ path: path.join(output, 'connections-1200.png') });
      }
      await page.locator('nav').getByRole('button', { name: /^端口转发/ }).click();
      await page.getByText('PostgreSQL 隧道').waitFor();

      const pfSearchBox = await page.getByRole('textbox', { name: /搜索规则/ }).locator('..').boundingBox();
      const pfAddBox = await page.getByRole('button', { name: '添加规则' }).boundingBox();
      assert.ok(Math.abs(pfSearchBox.height - pfAddBox.height) <= 1, `PF header height mismatch at ${width}: ${pfSearchBox.height} vs ${pfAddBox.height}`);

      const pfAllBox = await page.getByRole('button', { name: '全部', exact: true }).boundingBox();
      const pfHostBox = await page.getByRole('combobox', { name: '按主机筛选' }).boundingBox();
      assert.ok(Math.abs(pfAllBox.height - pfHostBox.height) <= 1, `PF toolbar height mismatch at ${width}: ${pfAllBox.height} vs ${pfHostBox.height}`);

      const pfCardGap = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-slot="management-card"]')];
        if (cards.length < 2) return 8;
        const a = cards[0].getBoundingClientRect();
        const b = cards[1].getBoundingClientRect();
        return Math.abs(a.y - b.y) < 4 ? Math.round(b.x - a.right) : Math.round(b.y - a.bottom);
      });
      assert.equal(pfCardGap, 8, `PF card gap expected 8px at ${width}, got ${pfCardGap}`);

      if (width === 1200) {
        await page.screenshot({ path: path.join(output, 'port-forward-1200.png') });
      }
      await page.getByRole('button', { name: '添加规则' }).click();
      const pfDrawer = page.getByRole('dialog');
      await pfDrawer.waitFor();
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-slot="drawer-content"]');
          return el && getComputedStyle(el).opacity === '1';
        },
      );
      const pfFooterBorder = await pfDrawer.locator('[data-slot="drawer-footer"]').evaluate(el => getComputedStyle(el).borderTopWidth);
      assert.equal(pfFooterBorder, '0px', 'PF drawer footer must have no top border');
      const pfFooterBox = await pfDrawer.locator('[data-slot="drawer-footer"]').boundingBox();
      assert.ok(pfFooterBox.y + pfFooterBox.height <= 760, 'PF drawer footer stays inside viewport');
      if (width === 1200) {
        await page.screenshot({ path: path.join(output, 'port-forward-drawer-1200.png') });
      }
      await page.keyboard.press('Escape');
      await pfDrawer.waitFor({ state: 'hidden' });

      await page.locator('nav').getByRole('button', { name: /^快捷操作/ }).click();
      await page.getByText('日志目录').waitFor();

      const qaSearchBox = await page.getByRole('textbox', { name: /搜索名称/ }).locator('..').boundingBox();
      const qaAddBox = await page.getByRole('button', { name: '添加快捷操作' }).boundingBox();
      assert.ok(Math.abs(qaSearchBox.height - qaAddBox.height) <= 1, `QA header height mismatch at ${width}: ${qaSearchBox.height} vs ${qaAddBox.height}`);

      const qaAllBox = await page.getByRole('button', { name: '全部', exact: true }).boundingBox();
      const qaHostBox = await page.getByRole('combobox', { name: '按主机筛选' }).boundingBox();
      assert.ok(Math.abs(qaAllBox.height - qaHostBox.height) <= 1, `QA toolbar height mismatch at ${width}: ${qaAllBox.height} vs ${qaHostBox.height}`);

      if (width === 1200) {
        await page.screenshot({ path: path.join(output, 'quick-actions-1200.png') });
      }
      await page.getByRole('button', { name: '添加快捷操作' }).click();
      const qaDrawer = page.getByRole('dialog');
      await qaDrawer.waitFor();
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-slot="drawer-content"]');
          return el && getComputedStyle(el).opacity === '1';
        },
      );
      const qaFooterBorder = await qaDrawer.locator('[data-slot="drawer-footer"]').evaluate(el => getComputedStyle(el).borderTopWidth);
      assert.equal(qaFooterBorder, '0px', 'QA drawer footer must have no top border');
      if (width === 1200) {
        await page.screenshot({ path: path.join(output, 'quick-actions-drawer-1200.png') });
      }
      await page.keyboard.press('Escape');
      await qaDrawer.waitFor({ state: 'hidden' });
      if (width === 640) {
        await page.screenshot({ path: path.join(output, 'quick-actions-640.png') });
      }
    }

    console.log('Workbench host-tools layout checks passed at 1200px and 640px.');
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
