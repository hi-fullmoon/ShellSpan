// @ts-nocheck
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sessionCss = readFileSync("src/styles/session.css", "utf8");

describe("SessionTabs transparent rename input", () => {
  it("uses a transparent background for the rename input", () => {
    expect(sessionCss).toContain(".session-tab-input");
    expect(sessionCss).toMatch(/\.session-tab-input\s*\{[^}]*background:\s*transparent/s);
  });
});
