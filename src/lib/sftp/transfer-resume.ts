import type { CopyRemoteToRemoteRequest, UploadConflictPolicy } from '@/types';
import {
  buildRemoteConnectionRequest,
  invokeCancelRemoteCopy,
  invokeCopyRemoteToRemote,
  invokeLoadPreferences,
  invokeSavePreferences,
} from '@/lib/ipc/tauri';
import { t } from '@/locales';
import { useProfileStore } from '@/stores/profileStore';
import { useTransferStore } from '@/stores/transferStore';

const PREFERENCE_KEY = 'transferResumeCandidates';
const MAX_CANDIDATES = 50;
const POLICIES = new Set<UploadConflictPolicy>(['overwrite', 'replace', 'skip', 'fail']);
const CANDIDATE_KEYS = new Set([
  'schemaVersion',
  'operationId',
  'sourceProfileId',
  'destinationProfileId',
  'sourcePaths',
  'destinationDirectory',
  'conflictPolicies',
  'createdAt',
]);

export interface TransferResumeCandidate {
  schemaVersion: 1;
  operationId: string;
  sourceProfileId: string;
  destinationProfileId: string;
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
  createdAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseTransferResumeCandidates(raw: string | undefined): TransferResumeCandidate[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_CANDIDATES).filter((item): item is TransferResumeCandidate => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<TransferResumeCandidate>;
      return Object.keys(item).every((key) => CANDIDATE_KEYS.has(key))
        && candidate.schemaVersion === 1
        && isNonEmptyString(candidate.operationId)
        && isNonEmptyString(candidate.sourceProfileId)
        && isNonEmptyString(candidate.destinationProfileId)
        && Array.isArray(candidate.sourcePaths)
        && candidate.sourcePaths.length > 0
        && candidate.sourcePaths.length <= 10_000
        && candidate.sourcePaths.every(isNonEmptyString)
        && isNonEmptyString(candidate.destinationDirectory)
        && Array.isArray(candidate.conflictPolicies)
        && candidate.conflictPolicies.length === candidate.sourcePaths.length
        && candidate.conflictPolicies.every((policy) => POLICIES.has(policy))
        && isNonEmptyString(candidate.createdAt);
    });
  } catch {
    return [];
  }
}

export async function loadTransferResumeCandidates(): Promise<TransferResumeCandidate[]> {
  const entries = await invokeLoadPreferences();
  return parseTransferResumeCandidates(entries.find(([key]) => key === PREFERENCE_KEY)?.[1]);
}

let mutationQueue = Promise.resolve();

function mutateCandidates(
  mutate: (candidates: TransferResumeCandidate[]) => TransferResumeCandidate[],
): Promise<void> {
  const mutation = mutationQueue.then(async () => {
    const current = await loadTransferResumeCandidates();
    const next = mutate(current).slice(0, MAX_CANDIDATES);
    await invokeSavePreferences([[PREFERENCE_KEY, JSON.stringify(next)]]);
  });
  mutationQueue = mutation.catch(() => {});
  return mutation;
}

export function upsertTransferResumeCandidate(candidate: TransferResumeCandidate): Promise<void> {
  return mutateCandidates((candidates) => [
    candidate,
    ...candidates.filter((item) => item.operationId !== candidate.operationId),
  ]);
}

export function removeTransferResumeCandidate(operationId: string): Promise<void> {
  return mutateCandidates((candidates) => (
    candidates.filter((item) => item.operationId !== operationId)
  ));
}

function connectionKey(request: ReturnType<typeof buildRemoteConnectionRequest>): string {
  return JSON.stringify([
    request.host,
    request.port,
    request.username,
    request.jumpHost?.host ?? '',
    request.jumpHost?.port ?? 0,
    request.jumpHost?.username ?? '',
  ]);
}

export async function hydrateTransferResumeCandidates(): Promise<void> {
  const candidates = await loadTransferResumeCandidates();
  for (const candidate of candidates) {
    const sourceProfile = useProfileStore.getState().getProfile(candidate.sourceProfileId);
    const destinationProfile = useProfileStore.getState().getProfile(candidate.destinationProfileId);
    const missingProfile = !sourceProfile || !destinationProfile;

    const retry = missingProfile ? undefined : async (): Promise<void> => {
      const profiles = useProfileStore.getState();
      const currentSource = profiles.getProfile(candidate.sourceProfileId);
      const currentDestination = profiles.getProfile(candidate.destinationProfileId);
      if (!currentSource || !currentDestination) {
        throw new Error('saved connection profile not found');
      }
      const [source, destination] = await Promise.all([
        profiles.ensurePassword(currentSource),
        profiles.ensurePassword(currentDestination),
      ]);
      const request: CopyRemoteToRemoteRequest = {
        sourceConnection: buildRemoteConnectionRequest(source),
        destinationConnection: buildRemoteConnectionRequest(destination),
        sourcePaths: candidate.sourcePaths,
        destinationDirectory: candidate.destinationDirectory,
        conflictPolicies: candidate.conflictPolicies,
        operationId: candidate.operationId,
      };
      try {
        await invokeCopyRemoteToRemote(request);
        useTransferStore.getState().markOperationCompleted(candidate.operationId);
        await removeTransferResumeCandidate(candidate.operationId);
      } catch (error) {
        if (useTransferStore.getState().operations.find(
          (operation) => operation.operationId === candidate.operationId,
        )?.status === 'cancelling') {
          useTransferStore.getState().markOperationCancelled(candidate.operationId);
          await removeTransferResumeCandidate(candidate.operationId);
          return;
        }
        throw error;
      }
    };

    const sourceRequest = sourceProfile ? buildRemoteConnectionRequest(sourceProfile) : undefined;
    useTransferStore.getState().addOperation({
      operationId: candidate.operationId,
      kind: 'remote-copy',
      connectionId: sourceRequest ? connectionKey(sourceRequest) : undefined,
      paths: candidate.sourcePaths,
      currentPath: candidate.sourcePaths[0],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: candidate.sourcePaths.length,
      completedSteps: 0,
      status: 'failed',
      error: missingProfile
        ? t('sftp.transfer.resumeProfileMissing')
        : t('sftp.transfer.interrupted'),
      errorCategory: missingProfile ? 'not-found' : 'cancelled',
      retry,
      cancel: retry ? () => invokeCancelRemoteCopy(candidate.operationId) : undefined,
      onDiscard: () => removeTransferResumeCandidate(candidate.operationId),
    });
  }
}
