import type { AgentSessionTarget } from './agent-session';
export interface SkillScope { readonly target: AgentSessionTarget; readonly root: string; readonly rootIdentity: string }
export interface SkillEntry {
  readonly name: string; readonly description: string; readonly relativePath: string; readonly resourceBase: string;
  readonly modelInvocable: boolean; readonly userInvocable: boolean;
  readonly fileHash: string; readonly instructionHash: string; readonly extensions: Readonly<Record<string, unknown>>;
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
