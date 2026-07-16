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

export async function downloadAndInstallUpdate(
  update: AvailableUpdate,
  onProgress: (percent: number) => void,
): Promise<void> {
  let downloaded = 0;
  let contentLength = 0;

  await update.raw.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === 'Started') {
      contentLength =
        (event.data as { contentLength?: number } | undefined)?.contentLength ?? 0;
      downloaded = 0;
      return;
    }

    if (event.event !== 'Progress') {
      return;
    }

    const chunkLength =
      (event.data as { chunkLength?: number } | undefined)?.chunkLength ?? 0;
    if (contentLength <= 0 || chunkLength <= 0) {
      return;
    }

    downloaded = Math.min(contentLength, downloaded + chunkLength);
    const percent = Math.round((downloaded / contentLength) * 100);
    onProgress(percent);
  });
}

const STARTUP_UPDATE_CHECK_KEY = 'termbridge.update.lastStartupCheckAt';
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
