import type { CopyRemoteToRemoteRequest, UploadConflictPolicy } from '@/types';
import {
  buildRemoteConnectionRequest,
  invokeCancelRemoteCopy,
  invokeCopyRemoteToRemote,
  invokeLoadPreferences,
  invokeSavePreferences,
} from '@/lib/ipc/tauri';
import { t } from '@/locales';
import { sshRouteKey } from '@/lib/connections/ssh-route';
import { createLogger } from '@/lib/logger';
import { invalidateDirectoryListingCacheByRouteKey } from '@/lib/sftp/directory-listing-cache';
import { useProfileStore } from '@/stores/profileStore';
import { getSftpPaneConnectionKey, getSftpPaneSource, useSftpStore, type SftpSide } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';

const PREFERENCE_KEY = 'transferResumeCandidates';
const logger = createLogger('sftp-transfer-resume');
const MAX_CANDIDATES = 50;
const POLICIES = new Set<UploadConflictPolicy>(['overwrite', 'replace', 'skip', 'fail']);
const CANDIDATE_KEYS = new Set([
  'schemaVersion',
  'operationId',
  'sourceProfileId',
  'destinationProfileId',
  'sourceRouteKey',
  'destinationRouteKey',
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
  sourceRouteKey?: string;
  destinationRouteKey?: string;
  sourcePaths: string[];
  destinationDirectory: string;
  conflictPolicies: UploadConflictPolicy[];
  createdAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function remoteDestinationPath(directory: string, sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const name = normalized.split('/').filter(Boolean).pop() ?? sourcePath;
  const base = directory === '/' ? '' : directory.replace(/\/+$/, '');
  return `${base}/${name}`;
}

function normalizeRemoteDirectory(directory: string): string {
  const trimmed = directory.trim();
  if (!trimmed || trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '') || '/';
}

function refreshDestinationPanes(destinationRouteKey: string | undefined, destinationDirectory: string): void {
  if (!destinationRouteKey) return;
  invalidateDirectoryListingCacheByRouteKey(destinationRouteKey);
  if (typeof document === 'undefined') return;
  const normalizedTarget = normalizeRemoteDirectory(destinationDirectory);
  const connections = useSftpStore.getState().connections;
  for (const conn of connections) {
    for (const side of ['local', 'remote'] as SftpSide[]) {
      if (getSftpPaneSource(conn, side) !== 'remote') continue;
      if (getSftpPaneConnectionKey(conn, side) !== destinationRouteKey) continue;
      const panePath = side === 'local' ? conn.localPath : conn.remotePath;
      if (normalizeRemoteDirectory(panePath) === normalizedTarget) {
        document.dispatchEvent(new CustomEvent('shellspan:open-sftp-path', {
          detail: { connectionId: conn.id, side, path: panePath, preserveSelection: true },
        }));
      }
    }
  }
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
        && ((candidate.sourceRouteKey === undefined && candidate.destinationRouteKey === undefined)
          || (isNonEmptyString(candidate.sourceRouteKey) && isNonEmptyString(candidate.destinationRouteKey)))
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

export async function copyRemoteTransferBatch(
  request: CopyRemoteToRemoteRequest,
  onPartial?: () => Promise<void>,
): Promise<void> {
  const { items } = await invokeCopyRemoteToRemote(request);
  const failed = items.flatMap((item, index) => item.status === 'failed' ? [{ item, index }] : []);
  if (failed.length === 0) return;

  request.sourcePaths = failed.map(({ item }) => item.sourcePath);
  const policies = request.conflictPolicies;
  request.conflictPolicies = failed.map(({ index }) => policies[index] ?? 'fail');
  await onPartial?.();
  const details = failed.map(({ item }) => `${item.sourcePath}\n${item.error ?? t('sftp.transfer.remoteCopyFailed')}`);
  throw new Error(details.join('\n'));
}

export async function hydrateTransferResumeCandidates(): Promise<void> {
  const candidates = await loadTransferResumeCandidates();
  for (const candidate of candidates) {
    let pending = candidate;
    const sourceProfile = useProfileStore.getState().getProfile(candidate.sourceProfileId);
    const destinationProfile = useProfileStore.getState().getProfile(candidate.destinationProfileId);
    const missingProfile = !sourceProfile || !destinationProfile;
    const routeMatches = sourceProfile && destinationProfile
      && candidate.sourceRouteKey === sshRouteKey(sourceProfile)
      && candidate.destinationRouteKey === sshRouteKey(destinationProfile);

    const retry = !routeMatches ? undefined : async (): Promise<void> => {
      const profiles = useProfileStore.getState();
      const currentSource = profiles.getProfile(candidate.sourceProfileId);
      const currentDestination = profiles.getProfile(candidate.destinationProfileId);
      if (!currentSource || !currentDestination) {
        throw new Error(t('sftp.transfer.resumeProfileMissing'));
      }
      if (pending.sourceRouteKey !== sshRouteKey(currentSource)
        || pending.destinationRouteKey !== sshRouteKey(currentDestination)) {
        throw new Error(t('sftp.transfer.resumeRouteChanged'));
      }
      const [source, destination] = await Promise.all([
        profiles.ensurePassword(currentSource),
        profiles.ensurePassword(currentDestination),
      ]);
      const request: CopyRemoteToRemoteRequest = {
        sourceConnection: buildRemoteConnectionRequest(source),
        destinationConnection: buildRemoteConnectionRequest(destination),
        sourcePaths: pending.sourcePaths,
        destinationDirectory: candidate.destinationDirectory,
        conflictPolicies: pending.conflictPolicies,
        operationId: candidate.operationId,
      };
      try {
        await copyRemoteTransferBatch(request, async () => {
          pending = { ...pending, sourcePaths: request.sourcePaths, conflictPolicies: request.conflictPolicies };
          await upsertTransferResumeCandidate(pending);
        });
        useTransferStore.getState().markOperationCompleted(candidate.operationId);
        await removeTransferResumeCandidate(candidate.operationId).catch((error: unknown) =>
          logger.warn('Failed to remove the completed transfer recovery entry', error),
        );
        refreshDestinationPanes(candidate.destinationRouteKey, candidate.destinationDirectory);
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

    const destinationPaths = candidate.sourcePaths.map((sourcePath) =>
      remoteDestinationPath(candidate.destinationDirectory, sourcePath),
    );
    const pathScopes = candidate.sourceRouteKey && candidate.destinationRouteKey
      ? [
          { connectionId: candidate.sourceRouteKey, paths: candidate.sourcePaths },
          { connectionId: candidate.destinationRouteKey, paths: destinationPaths },
        ]
      : undefined;

    useTransferStore.getState().addOperation({
      operationId: candidate.operationId,
      kind: 'remote-copy',
      route: sourceProfile && destinationProfile
        ? {
            source: {
              host: `${sourceProfile.username}@${sourceProfile.host}:${sourceProfile.port}`,
              path: candidate.sourcePaths.join('\n'),
            },
            destination: {
              host: `${destinationProfile.username}@${destinationProfile.host}:${destinationProfile.port}`,
              path: candidate.destinationDirectory,
            },
          }
        : undefined,
      connectionId: candidate.sourceRouteKey,
      paths: candidate.sourcePaths,
      pathScopes,
      currentPath: candidate.sourcePaths[0],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: candidate.sourcePaths.length,
      completedSteps: 0,
      status: 'failed',
      error: missingProfile
        ? t('sftp.transfer.resumeProfileMissing')
        : routeMatches ? t('sftp.transfer.interrupted') : t('sftp.transfer.resumeRouteChanged'),
      errorCategory: routeMatches ? 'cancelled' : 'not-found',
      retry,
      cancel: retry ? () => invokeCancelRemoteCopy(candidate.operationId) : undefined,
      onDiscard: () => removeTransferResumeCandidate(candidate.operationId),
    });
  }
}
