// Actual249 private-control-loss observations; displaySource omitted from this test sampling.
// Source evidence SHA256: 8ac63b6df04b82f85240fff8f8ad65bf09fe89c6434b21991f57de223030c662
export const recordedAgentId="agent-storage-619e3b9d-6fb3-490d-9379-b46958fdd9b4";
export const keyCrashRecording=[
  {
    "inputObservation": {
      "snapshotSequence": 126,
      "commandInputPending": true,
      "nativeRecoveryRequired": false,
      "nativeClearPending": false,
      "commandObservationUnavailable": false,
      "activeCommand": {
        "submissionIntentDurable": true,
        "draftCleared": false,
        "phase": "submissionAttempted",
        "mayHaveSubmitted": true,
        "fullInputConfirmed": true,
        "leaseGeneration": 2,
        "sourceRevision": 1,
        "safeActions": [
          "query",
          "requestStop"
        ],
        "agentSessionId": "agent-storage-619e3b9d-6fb3-490d-9379-b46958fdd9b4",
        "taskId": "agent-storage-619e3b9d-6fb3-490d-9379-b46958fdd9b4",
        "operationId": "call-a79a9ab999ca30f8b4f81afd9b6d08a0",
        "commandId": "command-3fd586b4-9e82-4e31-86d9-aed3f7df3f96",
        "legacyState": "submitted",
        "legacyRevision": 13,
        "sourceMayBeEnqueued": true,
        "executionEvidence": "unknown",
        "noAutoReplay": true
      }
    }
  },
  {
    "inputObservation": {
      "snapshotSequence": 128,
      "commandInputPending": true,
      "nativeRecoveryRequired": true,
      "nativeClearPending": false,
      "commandObservationUnavailable": false,
      "activeCommand": {
        "submissionIntentDurable": true,
        "draftCleared": false,
        "phase": "uncertain",
        "mayHaveSubmitted": true,
        "fullInputConfirmed": true,
        "leaseGeneration": 2,
        "sourceRevision": 1,
        "safeActions": [
          "query",
          "requestStop"
        ],
        "agentSessionId": "agent-storage-619e3b9d-6fb3-490d-9379-b46958fdd9b4",
        "taskId": "agent-storage-619e3b9d-6fb3-490d-9379-b46958fdd9b4",
        "operationId": "call-a79a9ab999ca30f8b4f81afd9b6d08a0",
        "commandId": "command-3fd586b4-9e82-4e31-86d9-aed3f7df3f96",
        "legacyState": "uncertain",
        "legacyRevision": 14,
        "sourceMayBeEnqueued": true,
        "executionEvidence": "unknown",
        "noAutoReplay": true
      }
    }
  },
  {
    "inputObservation": {
      "snapshotSequence": 129,
      "commandInputPending": true,
      "nativeRecoveryRequired": true,
      "nativeClearPending": false,
      "commandObservationUnavailable": false
    }
  }
] as const;
