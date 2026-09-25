import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import evidence from '../../../../../docs/design/deployment-center-product-phase-2-evidence.json';
import { HostComposeFields } from '../host-compose-fields';
import { normalizeDeploymentConfig, type DeploymentEnvironmentConfig } from '@/lib/deployment/applications';
import { initI18n, t } from '@/locales';

describe('existing Compose configuration', () => {
  it('keeps the existing project opt-in and exposes labelled editable fields', async () => {
    await initI18n('zh-CN');
    function View(): React.JSX.Element {
      const [config, setConfig] = React.useState<DeploymentEnvironmentConfig>(evidence.entry.environment.config as DeploymentEnvironmentConfig);
      return <HostComposeFields config={config} onChange={(patch) => setConfig({ ...config, ...patch })} />;
    }
    render(<View />);
    const user = userEvent.setup();
    expect(screen.queryByLabelText(t('deployment.application.host.environmentFile'))).toBeNull();
    await user.click(await screen.findByRole('checkbox', { name: t('deployment.application.host.enabled') }));
    expect(screen.getByLabelText(t('deployment.application.host.environmentFile'))).toHaveValue('.env');
    expect(screen.getByLabelText(t('deployment.application.host.gitRef'))).toHaveValue('main');
    await user.type(screen.getByLabelText(t('deployment.application.host.backup')), 'scripts/backup.sh');
    expect(screen.getByLabelText(t('deployment.application.host.backup'))).toHaveValue('scripts/backup.sh');
    expect(screen.getByLabelText(t('deployment.application.host.overrideFiles'))).toHaveAttribute('data-slot', 'textarea');
    await user.click(screen.getByRole('checkbox', { name: t('deployment.application.host.enabled') }));
    expect(screen.queryByLabelText(t('deployment.application.host.backup'))).toBeNull();
  });

  it('normalizes empty editor lines while preserving verification predicates and argument boundaries', () => {
    const config: DeploymentEnvironmentConfig = { ...evidence.entry.environment.config as DeploymentEnvironmentConfig,
      hostCompose: { environmentFile: ' .env ', overrideFiles: ['override.yml', ''], recreateServices: ['proxy', ''],
        backup: { script: 'scripts/backup.sh', arguments: ['directory with spaces', ''] },
        checks: [{ url: 'https://example.com/health', status: 200, jsonFields: { kind: 'valid' } }] } };
    const normalized = normalizeDeploymentConfig(config);
    expect(normalized.hostCompose?.overrideFiles).toEqual(['override.yml']);
    expect(normalized.hostCompose?.backup.arguments).toEqual(['directory with spaces']);
    expect(normalized.hostCompose?.checks[0]?.jsonFields).toEqual({ kind: 'valid' });
    expect(config.hostCompose?.overrideFiles).toEqual(['override.yml', '']);
  });
});
