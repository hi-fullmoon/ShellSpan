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
