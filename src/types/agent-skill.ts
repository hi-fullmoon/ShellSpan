import type { AgentSessionTarget } from './agent-session';
export type SkillOrigin = 'workspace' | 'user' | 'builtin';
export interface SkillScope { readonly target: AgentSessionTarget; readonly root: string; readonly rootIdentity: string }
export interface SkillEntry {
  readonly name: string; readonly description: string; readonly relativePath: string; readonly resourceBase: string;
  readonly modelInvocable: boolean; readonly userInvocable: boolean;
  readonly fileHash: string; readonly instructionHash: string; readonly extensions: Readonly<Record<string, unknown>>;
  readonly origin?: SkillOrigin;
}
export interface SkillDiagnostic { readonly path: string; readonly code: string; readonly message: string }
export interface SkillSnapshot { readonly protocolVersion: 1; readonly scope: SkillScope; readonly entries: readonly SkillEntry[]; readonly snapshotRevision: string }
export interface SkillObservation { readonly protocolVersion: 1; readonly status: 'complete' | 'incomplete' | 'unavailable'; readonly snapshot: SkillSnapshot | null; readonly diagnostics: readonly SkillDiagnostic[] }
export interface SkillProvenance {
  readonly protocolVersion: 1; readonly rendererVersion: 1; readonly providerIdentity: string; readonly scope: SkillScope;
  readonly relativePath: string; readonly resourceBase: string; readonly invocation: 'model' | 'user'; readonly catalogRevision: string;
  readonly fileHash: string; readonly instructionHash: string; readonly messageIds: readonly string[]; readonly requestId: string | null; readonly callId: string | null;
}
export interface LoadedSkill { readonly name: string; readonly instructions: string; readonly provenance: SkillProvenance; readonly rendered: string; readonly renderedHash: string }
export interface SkillCatalogPublication { readonly scope: SkillScope | null; readonly modelCatalogDigest: string; readonly content: string }
export interface SkillStepPrepared { readonly protocolVersion: 1; readonly messageIds: readonly string[]; readonly catalog: SkillCatalogPublication | null; readonly outcomes: readonly { readonly name: string; readonly messageIds: readonly string[]; readonly loaded: LoadedSkill | null; readonly error: string | null }[] }
export interface SkillUserList { readonly sessionId: string; readonly status: 'fresh' | 'stale' | 'unavailable'; readonly revision: string | null; readonly entries: readonly SkillEntry[]; readonly diagnostics: readonly SkillDiagnostic[] }

export type SkillProposalMode = 'create' | 'update';
export type SkillProposalScope = 'user' | 'workspace';
export type SkillProposalAction = 'save' | 'requestRevision' | 'cancel';

export interface SkillProposalIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly proposalId: string;
}

export interface SkillProposalIssue {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface PreparedSkillProposal {
  readonly mode: SkillProposalMode;
  readonly scope: SkillProposalScope;
  readonly workspaceAllowed: boolean;
  readonly scopeDowngradeReason?: string | null;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly summary?: string | null;
  readonly existingContent?: string | null;
  readonly existingFileHash?: string | null;
  readonly overwritesBuiltin: boolean;
  readonly shadowedByWorkspace: boolean;
  readonly validationIssues: readonly SkillProposalIssue[];
}

export interface SavedSkillMetadata {
  readonly scope: SkillProposalScope;
  readonly name: string;
  readonly relativePath: string;
  readonly fileHash: string;
  readonly editedByUser: boolean;
}

export interface SkillProposalResolution {
  readonly identity: SkillProposalIdentity;
  readonly clientOperationId: string;
  readonly action: SkillProposalAction;
  readonly note?: string | null;
  readonly saved?: SavedSkillMetadata | null;
}

export interface ResolveSkillProposalInput {
  readonly identity: SkillProposalIdentity;
  readonly clientOperationId: string;
  readonly action: SkillProposalAction;
  readonly scope?: SkillProposalScope;
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly expectedBaseHash?: string | null;
  readonly note?: string;
}

export interface InspectSkillTargetInput {
  readonly sessionId: string;
  readonly scope: SkillProposalScope;
  readonly name: string;
}

export interface SkillTargetInspection {
  readonly scope: SkillProposalScope;
  readonly workspaceAllowed: boolean;
  readonly exists: boolean;
  readonly existingContent?: string | null;
  readonly existingFileHash?: string | null;
  readonly overwritesBuiltin: boolean;
  readonly shadowedByWorkspace: boolean;
}

export interface ManagedSkillItem {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly origin: SkillOrigin;
  readonly relativePath: string;
  readonly fileHash: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly overridesBuiltin: boolean;
}

export interface ManagedSkillCatalog {
  readonly userSkillsDir: string;
  readonly userSkillsDirExists: boolean;
  readonly skills: readonly ManagedSkillItem[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

export interface SaveUserSkillInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly expectedBaseHash?: string | null;
}

export interface DeleteUserSkillInput {
  readonly name: string;
  readonly expectedFileHash: string;
}

export interface AgentSkillProposalView {
  readonly identity: SkillProposalIdentity;
  readonly proposal: PreparedSkillProposal;
  readonly status: 'pending' | 'resolved' | 'cancelled';
  readonly resolution?: SkillProposalResolution;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly timestamp: string;
}

export function skillProposalKey(identity: SkillProposalIdentity): string {
  return `${identity.sessionId}:${identity.turnId}:${identity.stepId}:${identity.requestId}:${identity.callId}:${identity.proposalId}`;
}

export function skillOrigin(entry: SkillEntry): SkillOrigin {
  if (entry.origin) return entry.origin;
  if (entry.resourceBase === 'builtin') return 'builtin';
  if (entry.resourceBase === 'user') return 'user';
  return 'workspace';
}
