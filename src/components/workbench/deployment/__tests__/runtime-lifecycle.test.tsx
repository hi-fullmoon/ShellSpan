import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import evidence from '../../../../../docs/design/deployment-center-product-phase-4-lifecycle-evidence.json';
import type { DeploymentRunDetail } from '@/lib/deployment/types';
import { t } from '@/locales';
import zh from '@/locales/zh-CN';
import en from '@/locales/en-US';
import { RunStatusAlert } from '../../deployment-workflow-runtime';
import { formatDeploymentDate } from '../runtime-utils';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

describe('Recorded deployment lifecycle feedback', () => {
  it('keeps a failed release failed while exposing its recorded recovery receipt', async () => {
    const detail = evidence.failed as unknown as DeploymentRunDetail;
    render(<RunStatusAlert status={detail.summary.status} detail={detail} onReconcile={() => undefined}
      hasEvidence onOpenEvidence={() => undefined} />);
    expect(await screen.findByText(t('deployment.runtime.failed.title'))).toBeVisible();
    expect(screen.getByText(t('deployment.runtime.restore.receiptRecorded'))).toBeVisible();
    expect(screen.getByRole('button', { name: t('deployment.runtime.evidence.action') })).toBeVisible();
    const alert = screen.getByTestId('deployment-run-failed-alert');
    expect(alert.className).toContain('minmax(0,1fr)');
    expect(alert.querySelector('[data-slot="alert-action"]')?.className).toContain('col-start-3');
    expect(screen.queryByText(t('deployment.runtime.status.succeeded'))).toBeNull();
    expect(detail.summary.status).toBe('failed');
  });

  it('does not show restoration for the recorded successful initial release', () => {
    const detail = evidence.initial as unknown as DeploymentRunDetail;
    render(<RunStatusAlert status={detail.summary.status} detail={detail} onReconcile={() => undefined} />);
    expect(screen.queryByText(t('deployment.runtime.restore.receiptRecorded'))).toBeNull();
  });

  it('offers only read-only reconciliation for the unknown-state presentation contract', async () => {
    render(<RunStatusAlert status="state_unknown" onReconcile={() => undefined} />);
    expect(await screen.findByText(t('deployment.runtime.unknown.description'))).toBeVisible();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: t('deployment.runtime.reconcile') })).toBeVisible();
    expect(screen.queryByText(t('deployment.runtime.restore.receiptRecorded'))).toBeNull();
  });

  it('keeps all deployment translation keys aligned', () => {
    expect(Object.keys(en).filter(key => key.startsWith('deployment.')).sort())
      .toEqual(Object.keys(zh).filter(key => key.startsWith('deployment.')).sort());
    expect(en['deployment.runtime.restore.receiptRecorded']).toContain('remains failed');
    expect(zh['deployment.runtime.restore.receiptRecorded']).toContain('仍为失败');
  });

  it('formats recorded timestamps using the selected application language', () => {
    const previous = useAppStore.getState().locale;
    try {
      for (const locale of ['zh-CN', 'en-US'] as const) {
        useAppStore.setState({ locale });
        expect(formatDeploymentDate(evidence.initial.summary.createdAt)).toBe(
          new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(evidence.initial.summary.createdAt),
        );
      }
    } finally { useAppStore.setState({ locale: previous }); }
  });
});
