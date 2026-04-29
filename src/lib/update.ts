// update.ts — merged from updateFlow.ts, updater.ts, updateStartupPolicy.ts
import type { UpdateAction, UpdateState } from '../types';

export function updateFlowReducer(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "checkStarted":
      return {
        phase: "checking",
        version: state.version,
      };
    case "noUpdateFound":
      return {
        phase: "no_update",
        version: state.version,
      };
    case "updateFound":
      return {
        phase: "update_available",
        version: {
          ...state.version,
          latestVersion: action.payload.latestVersion,
        },
      };
    case "downloadStarted":
      return {
        phase: "downloading",
        version: state.version,
      };
    case "downloadCompleted":
      return {
        phase: "downloaded",
        version: {
          ...state.version,
          downloadedVersion: action.payload.downloadedVersion,
        },
      };
    case "downloadFailed":
      return {
        phase: "error",
        error: action.payload.message,
        version: state.version,
      };
    case "reset":
      return {
        phase: "idle",
      };
    default:
      return state;
  }
}

import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export interface AvailableUpdate {
  version: string;
  body?: string;
  raw: Update;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
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
    if (event.event === "Started") {
      contentLength = event.data.contentLength ?? 0;
      downloaded = 0;
      return;
    }

    if (event.event !== "Progress") {
      return;
    }

    const { chunkLength } = event.data;
    if (contentLength <= 0 || chunkLength <= 0) {
      return;
    }

    downloaded = Math.min(contentLength, downloaded + chunkLength);
    const percent = Math.round((downloaded / contentLength) * 100);
    onProgress(percent);
  });
}

const STARTUP_UPDATE_CHECK_KEY = "termbridge.update.startupLastCheckAt";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function shouldRunStartupUpdateCheck(now: number): boolean {
  const raw = window.localStorage.getItem(STARTUP_UPDATE_CHECK_KEY);

  if (raw == null) {
    return true;
  }

  const lastCheckAt = Number(raw);
  if (!Number.isFinite(lastCheckAt)) {
    return true;
  }
  if (lastCheckAt > now) {
    return true;
  }

  return now - lastCheckAt >= TWELVE_HOURS_MS;
}

export function markStartupUpdateCheck(now: number): void {
  window.localStorage.setItem(STARTUP_UPDATE_CHECK_KEY, String(now));
}
