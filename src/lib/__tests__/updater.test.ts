import { describe, expect, it, vi } from "vitest";

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

import { checkForUpdate, downloadAndInstallUpdate } from "../updater";

describe("updater wrapper", () => {
  it("returns null when no update exists", async () => {
    checkMock.mockResolvedValueOnce(null);
    const result = await checkForUpdate();
    expect(result).toBeNull();
  });

  it("forwards progress events during download", async () => {
    const mockUpdate = {
      version: "0.2.0",
      body: "Fixes",
      downloadAndInstall: vi.fn(async (onEvent: (event: any) => void) => {
        onEvent({
          event: "Progress",
          data: {
            chunkLength: 40,
            contentLength: 100,
          },
        });
      }),
    };
    const progress = vi.fn();
    await downloadAndInstallUpdate(
      { version: "0.2.0", body: "Fixes", raw: mockUpdate as any },
      progress,
    );
    expect(progress).toHaveBeenCalledWith(40);
  });
});
