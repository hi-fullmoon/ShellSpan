import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentExperience } from '@/components/deployment-experience';
import { useAppStore } from '@/stores/appStore';
import { useDeploymentStore } from '@/stores/deploymentStore';
import { useToastStore } from '@/stores/toastStore';

const ipc = vi.hoisted(() => ({
  getRunDetail: vi.fn(),
  showNotification: vi.fn(),
  listenNotification: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeGetDeploymentRunDetail: ipc.getRunDetail,
  invokeShowDeploymentNotification: ipc.showNotification,
  listenToDeploymentNotificationOpen: ipc.listenNotification,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => `${key}${values?.run ? `:${values.run}` : ''}`,
    locale: 'en-US',
    ready: true,
    setLocale: () => undefined,
  }),
}));

describe('DeploymentExperience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.showNotification.mockResolvedValue(undefined);
    ipc.listenNotification.mockResolvedValue(vi.fn());
    useToastStore.setState({ toasts: [] });
    useAppStore.setState({ activeSection: 'terminal', activeWorkbenchTab: 'connections' });
    useDeploymentStore.setState({
      initialized: true,
      loading: false,
      notificationReceipts: [],
      recoveryCandidates: [],
      selectedRunId: null,
      runDetail: null,
      runDetailLoading: false,
    });
    ipc.getRunDetail.mockRejectedValue(new Error('fixture detail unavailable'));
  });

  it('creates one actionable notification that routes to the exact run', async () => {
    useDeploymentStore.setState({
      notificationReceipts: [{
        runId: 'run-exact',
        workflowId: 'workflow-1',
        workflowName: 'API',
        eventSequence: 8,
        status: 'failed',
        kind: 'failed',
        createdAt: 10,
      }],
    });
    render(<DeploymentExperience />);

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    useToastStore.getState().toasts[0]!.action?.onClick();
    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'workbench',
      activeWorkbenchTab: 'deployments',
    });
    expect(useDeploymentStore.getState().selectedRunId).toBe('run-exact');
    expect(ipc.getRunDetail).toHaveBeenCalledWith('run-exact', 100);
    expect(ipc.showNotification).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-exact',
      body: expect.not.stringContaining('example.test'),
    }));
  });

  it('does not duplicate the same receipt during rerender', async () => {
    const receipt = {
      runId: 'run-once',
      workflowId: 'workflow-1',
      workflowName: 'API',
      eventSequence: 9,
      status: 'succeeded' as const,
      kind: 'succeeded' as const,
      createdAt: 10,
    };
    useDeploymentStore.setState({ notificationReceipts: [receipt] });
    const view = render(<DeploymentExperience />);
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    view.rerender(<DeploymentExperience />);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('routes a native notification click event to the exact durable run', async () => {
    let onOpen: ((event: { payload: string }) => void) | undefined;
    ipc.listenNotification.mockImplementation(async (callback) => {
      onOpen = callback;
      return vi.fn();
    });
    render(<DeploymentExperience />);
    await waitFor(() => expect(onOpen).toBeDefined());

    onOpen?.({ payload: 'run-from-native-click' });
    expect(useDeploymentStore.getState().selectedRunId).toBe('run-from-native-click');
    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'workbench',
      activeWorkbenchTab: 'deployments',
    });
  });
});
