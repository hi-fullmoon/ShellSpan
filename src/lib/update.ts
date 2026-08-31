import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import type { UpdateStatus, UpdateVersionInfo } from '@/types';

export interface UpdateState {
  phase: UpdateStatus;
  version: UpdateVersionInfo;
  error?: string;
}

export type UpdateAction =
  | { type: 'checkStarted' }
  | { type: 'noUpdateFound' }
  | { type: 'updateFound'; payload: { latestVersion: string } }
  | { type: 'downloadStarted' }
  | { type: 'downloadCompleted'; payload: { downloadedVersion: string } }
  | { type: 'downloadFailed'; payload: { message: string } }
  | { type: 'reset' };

export function updateFlowReducer(
  state: UpdateState,
  action: UpdateAction,
): UpdateState {
  switch (action.type) {
    case 'checkStarted':
      return { phase: 'checking', version: state.version };
    case 'noUpdateFound':
      return { phase: 'no_update', version: state.version };
    case 'updateFound':
      return {
        phase: 'update_available',
        version: { ...state.version, latestVersion: action.payload.latestVersion },
      };
    case 'downloadStarted':
      return { phase: 'downloading', version: state.version };
    case 'downloadCompleted':
      return {
        phase: 'downloaded',
        version: {
          ...state.version,
          downloadedVersion: action.payload.downloadedVersion,
        },
      };
    case 'downloadFailed':
      return {
        phase: 'error',
        error: action.payload.message,
        version: state.version,
      };
    case 'reset':
      return { phase: 'idle', version: {} };
    default:
      return state;
  }
}

export interface AvailableUpdate {
  version: string;
  body?: string;
  raw: Update;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) {
    return null;
  }

  return {
    version: update.version,
    body: update.body,
    raw: update,
  };
}

export interface UpdateDownloadProgress {
  /** 0-100 when the total download size is known; absent while it is not. */
  percent?: number;
  receivedBytes: number;
  totalBytes: number;
}

export async function downloadAndInstallUpdate(
  update: AvailableUpdate,
  onProgress: (progress: UpdateDownloadProgress) => void,
): Promise<void> {
  let receivedBytes = 0;
  let totalBytes = 0;

  await update.raw.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === 'Started') {
      totalBytes =
        (event.data as { contentLength?: number } | undefined)?.contentLength ?? 0;
      receivedBytes = 0;
      return;
    }

    if (event.event !== 'Progress') {
      return;
    }

    const chunkLength =
      (event.data as { chunkLength?: number } | undefined)?.chunkLength ?? 0;
    if (chunkLength <= 0) {
      return;
    }

    receivedBytes += chunkLength;
    if (totalBytes > 0) {
      const percent = Math.round(
        (Math.min(totalBytes, receivedBytes) / totalBytes) * 100,
      );
      onProgress({ percent, receivedBytes, totalBytes });
    } else {
      // Total size unknown (e.g. a streaming/CDN response): report bytes so
      // callers can show an indeterminate progress state instead of a stuck 0%.
      onProgress({ receivedBytes, totalBytes: 0 });
    }
  });
}

const STARTUP_UPDATE_CHECK_KEY = 'shellspan.update.lastStartupCheckAt';
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function shouldRunStartupUpdateCheck(now: number): boolean {
  const raw = window.localStorage.getItem(STARTUP_UPDATE_CHECK_KEY);
  if (raw == null) {
    return true;
  }

  const lastCheckAt = Number(raw);
  if (!Number.isFinite(lastCheckAt) || lastCheckAt > now) {
    return true;
  }

  return now - lastCheckAt >= TWELVE_HOURS_MS;
}

export function markStartupUpdateCheck(now: number): void {
  window.localStorage.setItem(STARTUP_UPDATE_CHECK_KEY, String(now));
}
