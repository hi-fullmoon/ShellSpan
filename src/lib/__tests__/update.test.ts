// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../types";
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  markStartupUpdateCheck,
  shouldRunStartupUpdateCheck,
  updateFlowReducer,
} from "../update";

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

describe("updateFlowReducer", () => {
  it("moves to update_available after updateFound action", () => {
    const state: UpdateState = {
      phase: "checking",
      version: {
        currentVersion: "1.0.0",
      },
    };

    const next = updateFlowReducer(state, {
      type: "updateFound",
      payload: {
        latestVersion: "1.1.0",
      },
    });

    expect(next.phase).toBe("update_available");
    expect(next.version).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    });
  });

  it("downloadFailed transitions to error but keeps existing version metadata", () => {
    const state: UpdateState = {
      phase: "downloading",
      version: {
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      },
    };

    const next = updateFlowReducer(state, {
      type: "downloadFailed",
      payload: {
        message: "network error",
      },
    });

    expect(next.phase).toBe("error");
    expect(next.error).toBe("network error");
    expect(next.version).toEqual(state.version);
  });
});

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

describe("updateStartupPolicy", () => {
  const now = 1_700_000_000_000;
  const twelveHoursMs = 12 * 60 * 60 * 1000;

  afterEach(() => {
    window.localStorage.clear();
  });

  it("shouldRunStartupUpdateCheck returns true when no timestamp", () => {
    expect(shouldRunStartupUpdateCheck(now)).toBe(true);
  });

  it("shouldRunStartupUpdateCheck returns false within 12h after markStartupUpdateCheck", () => {
    markStartupUpdateCheck(now);

    expect(shouldRunStartupUpdateCheck(now + 60 * 60 * 1000)).toBe(false);
  });

  it("shouldRunStartupUpdateCheck returns true at exactly 12h", () => {
    markStartupUpdateCheck(now);

    expect(shouldRunStartupUpdateCheck(now + twelveHoursMs)).toBe(true);
  });

  it("shouldRunStartupUpdateCheck returns true after more than 12h", () => {
    markStartupUpdateCheck(now);

    expect(shouldRunStartupUpdateCheck(now + twelveHoursMs + 1)).toBe(true);
  });

  it("shouldRunStartupUpdateCheck returns true when persisted timestamp is invalid", () => {
    window.localStorage.setItem("termbridge.update.startupLastCheckAt", "not-a-number");

    expect(shouldRunStartupUpdateCheck(now)).toBe(true);
  });

  it("shouldRunStartupUpdateCheck returns true when persisted timestamp is in the future", () => {
    markStartupUpdateCheck(now + 1);

    expect(shouldRunStartupUpdateCheck(now)).toBe(true);
  });
});
