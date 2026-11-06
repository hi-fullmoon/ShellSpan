import {describe,expect,it} from 'vitest';
import type {TerminalInputObservation} from '@/types';
import {recordedNativeUncertainty} from './native-key-crash-observation';
import {keyCrashRecording,recordedAgentId} from './native-key-crash-recording';

describe('recorded native uncertainty after transport retirement',()=>{
  it('retains the actual uncertain observation after the current snapshot retires active facts',()=>{
    const current:TerminalInputObservation=keyCrashRecording[2].inputObservation;
    expect(current.activeCommand).toBeUndefined();
    const fact=recordedNativeUncertainty(keyCrashRecording,recordedAgentId);
    expect(fact).toBe(keyCrashRecording[1].inputObservation.activeCommand);
    expect(fact?.executionEvidence).toBe('unknown');
    expect(fact?.submissionIntentDurable).toBe(true);
    expect(fact?.mayHaveSubmitted).toBe(true);
  });
  it('does not invent a fact from the retired snapshot alone',()=>{
    expect(recordedNativeUncertainty([keyCrashRecording[2]],recordedAgentId)).toBeUndefined();
  });
  it('does not reuse a different Agent operation',()=>{
    expect(recordedNativeUncertainty(keyCrashRecording,'different-agent')).toBeUndefined();
  });
});
