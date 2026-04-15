// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  markStartupUpdateCheck,
  shouldRunStartupUpdateCheck,
} from "../updateStartupPolicy";

describe("updateStartupPolicy", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("shouldRunStartupUpdateCheck returns true when no timestamp", () => {
    expect(shouldRunStartupUpdateCheck(1_700_000_000_000)).toBe(true);
  });

  it("shouldRunStartupUpdateCheck returns false within 12h after markStartupUpdateCheck", () => {
    const now = 1_700_000_000_000;

    markStartupUpdateCheck(now);

    expect(shouldRunStartupUpdateCheck(now + 60 * 60 * 1000)).toBe(false);
  });
});
