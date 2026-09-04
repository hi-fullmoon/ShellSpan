import type { SkillScope } from './agent-skill';
export interface FileCandidate { readonly path: string; readonly kind: 'file' | 'directory' }
export interface FileReferenceList {
  readonly entries: readonly FileCandidate[];
  readonly scope: SkillScope | null;
  readonly status: 'ready' | 'truncated' | 'error';
  readonly code: string | null;
  readonly excluded: number;
}
export type ListFileReferences = (query: string, signal: AbortSignal, root?: string) => Promise<FileReferenceList>;
