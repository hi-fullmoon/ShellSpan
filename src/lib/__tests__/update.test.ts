import { describe, expect, it } from 'vitest';
import {
  markStartupUpdateCheck,
  shouldRunStartupUpdateCheck,
  updateFlowReducer,
} from '@/lib/update';

describe('updateFlowReducer', () => {
  it('starts checking', () => {
    const next = updateFlowReducer({ phase: 'idle', version: {} }, { type: 'checkStarted' });
    expect(next.phase).toBe('checking');
  });

  it('transitions to no_update', () => {
    const next = updateFlowReducer({ phase: 'checking', version: {} }, { type: 'noUpdateFound' });
    expect(next.phase).toBe('no_update');
  });

  it('records the latest version when an update is found', () => {
    const next = updateFlowReducer(
      { phase: 'checking', version: {} },
      { type: 'updateFound', payload: { latestVersion: '1.3.0' } },
    );
    expect(next.phase).toBe('update_available');
    expect(next.version.latestVersion).toBe('1.3.0');
  });

  it('transitions to downloading', () => {
    const next = updateFlowReducer(
      { phase: 'update_available', version: { latestVersion: '1.3.0' } },
      { type: 'downloadStarted' },
    );
    expect(next.phase).toBe('downloading');
    expect(next.version.latestVersion).toBe('1.3.0');
  });

  it('records the downloaded version', () => {
    const next = updateFlowReducer(
      { phase: 'downloading', version: { latestVersion: '1.3.0' } },
      { type: 'downloadCompleted', payload: { downloadedVersion: '1.3.0' } },
    );
    expect(next.phase).toBe('downloaded');
    expect(next.version.downloadedVersion).toBe('1.3.0');
  });

  it('records errors', () => {
    const next = updateFlowReducer(
      { phase: 'downloading', version: {} },
      { type: 'downloadFailed', payload: { message: 'network error' } },
    );
    expect(next.phase).toBe('error');
    expect(next.error).toBe('network error');
  });

  it('resets to idle', () => {
    const next = updateFlowReducer(
      { phase: 'downloaded', version: { downloadedVersion: '1.3.0' } },
      { type: 'reset' },
    );
    expect(next.phase).toBe('idle');
    expect(next.version).toEqual({});
  });
});

describe('startup update check throttle', () => {
  it('runs when no previous check is recorded', () => {
    window.localStorage.removeItem('shellspan.update.lastStartupCheckAt');
    expect(shouldRunStartupUpdateCheck(Date.now())).toBe(true);
  });

  it('runs after 12 hours have passed', () => {
    const now = Date.now();
    markStartupUpdateCheck(now - 13 * 60 * 60 * 1000);
    expect(shouldRunStartupUpdateCheck(now)).toBe(true);
  });

  it('does not run within 12 hours', () => {
    const now = Date.now();
    markStartupUpdateCheck(now - 60 * 60 * 1000);
    expect(shouldRunStartupUpdateCheck(now)).toBe(false);
  });
});
