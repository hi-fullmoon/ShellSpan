import { check, type Update } from "@tauri-apps/plugin-updater";

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
  await update.raw.downloadAndInstall((event) => {
    if (event.event === "Progress" && event.data.contentLength > 0) {
      const percent = Math.round((event.data.chunkLength / event.data.contentLength) * 100);
      onProgress(percent);
    }
  });
}
