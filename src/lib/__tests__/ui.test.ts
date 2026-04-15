import { describe, expect, it } from "vitest";
import { cn, fileKindTone, sessionStatusDot, sessionStatusTone } from "../ui";

describe("cn", () => {
  it("joins only truthy class names", () => {
    expect(cn("rounded", false, null, "bg-slate-900", undefined, "p-2")).toBe(
      "rounded bg-slate-900 p-2",
    );
  });
});

describe("sessionStatusTone", () => {
  it.each([
    ["connected", "bg-emerald-500/12 text-emerald-300"],
    ["connecting", "bg-sky-500/12 text-sky-300"],
    ["error", "bg-rose-500/12 text-rose-300"],
    ["disconnected", "bg-slate-500/12 text-slate-300"],
  ] as const)("returns the right tone for %s sessions", (status, tone) => {
    expect(sessionStatusTone(status)).toBe(tone);
  });
});

describe("sessionStatusDot", () => {
  it.each([
    ["connected", "bg-emerald-400"],
    ["connecting", "bg-sky-400"],
    ["error", "bg-rose-400"],
    ["disconnected", "bg-slate-400"],
  ] as const)("returns the right dot color for %s sessions", (status, dot) => {
    expect(sessionStatusDot(status)).toBe(dot);
  });
});

describe("fileKindTone", () => {
  it.each([
    ["directory", "bg-cyan-500/12 text-cyan-300"],
    ["symlink", "bg-violet-500/12 text-violet-300"],
    ["file", "bg-slate-500/12 text-slate-300"],
    ["other", "bg-amber-500/12 text-amber-300"],
  ] as const)("returns the right tone for %s entries", (kind, tone) => {
    expect(fileKindTone(kind)).toBe(tone);
  });
});
