// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  markStartupUpdateCheck,
  shouldRunStartupUpdateCheck,
} from "../updateStartupPolicy";

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
