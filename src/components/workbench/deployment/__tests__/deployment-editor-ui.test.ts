import { describe, expect, it } from 'vitest';
import { readableDeploymentProfile, readableDeploymentTarget } from '../deployment-editor-ui';

describe('deployment target labels', () => {
  it('shows only the SSH address for template connection choices', () => {
    const profile = {
      name: '175.178.66.45',
      username: 'root',
      host: '175.178.66.45',
    };
    expect(readableDeploymentProfile(profile)).toBe('root@175.178.66.45');
  });

  it('shows only the SSH address and remote directory', () => {
    const profile = {
      name: '175.178.66.45',
      username: 'root',
      host: '175.178.66.45',
    };
    expect(readableDeploymentTarget('/srv/apps/example', profile))
      .toBe('root@175.178.66.45 · /srv/apps/example');
  });

  it('keeps the directory readable when the connection profile is unavailable', () => {
    expect(readableDeploymentTarget('/srv/apps/example')).toBe('/srv/apps/example');
  });
});
