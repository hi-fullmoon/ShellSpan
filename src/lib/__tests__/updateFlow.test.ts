import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../types';
import { updateFlowReducer } from '../updateFlow';

describe('updateFlowReducer', () => {
  it('moves to update_available after updateFound action', () => {
    const state: UpdateState = {
      phase: 'checking',
      version: {
        currentVersion: '1.0.0',
      },
    };

    const next = updateFlowReducer(state, {
      type: 'updateFound',
      payload: {
        latestVersion: '1.1.0',
      },
    });

    expect(next.phase).toBe('update_available');
    expect(next.version).toEqual({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    });
  });

  it('downloadFailed transitions to error but keeps existing version metadata', () => {
    const state: UpdateState = {
      phase: 'downloading',
      version: {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        downloadedVersion: '1.1.0',
      },
    };

    const next = updateFlowReducer(state, {
      type: 'downloadFailed',
      payload: {
        message: 'network error',
      },
    });

    expect(next.phase).toBe('error');
    expect(next.error).toBe('network error');
    expect(next.version).toEqual(state.version);
  });
});
