/** Controller facts, never inferred from command output. */
export interface AgentExecutionFailure {
  readonly kind: 'policyRejected' | 'backendUnavailable' | 'infrastructureFailure'
    | 'commandFailed' | 'cancelled' | 'timedOut' | 'terminationUnconfirmed';
  readonly code: string;
  readonly admission: 'notStarted' | 'started' | 'unknown';
}

export interface LocalSandboxBackendProbe {
  readonly infrastructureAvailable: boolean;
  readonly executionOs: string | null;
  readonly executionArch: string | null;
  readonly backendVersion: string | null;
  readonly workspaceVerified: false;
  readonly admissionEnabled: false;
  readonly failure: AgentExecutionFailure | null;
}

/** A read-only infrastructure observation never opens remote admission. */
export interface RemoteSandboxBackendProbe {
  readonly target: import('@/types/agent-session').AgentSessionTarget;
  readonly bindingRevision: number;
  readonly infrastructureAvailable: boolean;
  readonly launcherAvailable: boolean;
  readonly executionOs: 'linux' | 'macos' | 'unsupported';
  readonly backend: 'bubblewrap' | 'seatbelt' | null;
  readonly workspaceVerified: false;
  readonly admissionEnabled: false;
  readonly gaps: readonly string[];
}

/** A transient target-bound verification, never a resource grant. */
export interface RemoteSandboxVerification {
  readonly target: import('@/types/agent-session').AgentSessionTarget;
  readonly policy: 'readOnly' | 'workspace';
  readonly executionSurface: 'direct';
  readonly canonicalRoot: string;
  readonly remoteUid: number;
  readonly sshHostKeySha256: string;
  readonly sourceBindingDigest: string;
  readonly capability: import('@/types/agent-session').AgentSandboxCapability;
}

/** Cleanup reconciliation counts; this does not restore an execution grant. */
export interface DirectResourceRecovery {
  readonly resolved: number;
  readonly uncertain: number;
}
