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
      downloadAndInstall: vi.fn(async (onEvent: (event: unknown) => void) => {
        onEvent({
          event: "Started",
          data: {
            contentLength: 100,
          },
        });
        onEvent({
          event: "Progress",
          data: {
            chunkLength: 25,
          },
        });
        onEvent({
          event: "Progress",
          data: {
            chunkLength: 25,
          },
        });
        onEvent({
          event: "Progress",
          data: {
            chunkLength: 50,
          },
        });
      }),
    };
    const progress = vi.fn();
    await downloadAndInstallUpdate(
      { version: "0.2.0", body: "Fixes", raw: mockUpdate as any },
      progress,
    );
    expect(progress).toHaveBeenNthCalledWith(1, 25);
    expect(progress).toHaveBeenNthCalledWith(2, 50);
    expect(progress).toHaveBeenNthCalledWith(3, 100);
  });
});
